import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { digestSchema, waveDesignSchema, bossDesignSchema } from './schema'
import { callLlm, pickProvider } from './llm'
import { issueToken, verifyToken } from './token'

export interface Env {
  /** 우선 사용 (gpt-5.4-mini 기본) */
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  /** 'openai' | 'anthropic' — 미설정 시 키 존재 순서로 자동 */
  PROVIDER?: string
  /** 쉼표 구분 허용 오리진. 미설정 시 로컬 개발용 전체 허용 */
  ALLOWED_ORIGINS?: string
  MODEL?: string
  /** gpt-5 계열 reasoning_effort (기본 'none', 'off'면 파라미터 제외) */
  REASONING_EFFORT?: string
  /** 일일 LLM 호출 상한 (기본 2000). 최종 방어선은 프로바이더 콘솔의 지출 한도 */
  MAX_DAILY_CALLS?: string
  /** 세션 토큰 HMAC 서명 키. 미설정 시 토큰 검증 생략(하위호환) */
  SESSION_SECRET?: string
  /** 진단 캡처 저장 KV (게임 내 진단 버튼 업로드) */
  DIAG?: {
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
    get(key: string): Promise<string | null>
  }
}

const RATE_LIMIT_PER_MIN = 10

// 인메모리 카운터 — CF Worker는 아이솔레이트별이라 근사치지만,
// 진짜 상한은 Anthropic 콘솔 지출 한도가 담당한다 (다층 방어의 한 층일 뿐).
const perIp = new Map<string, { count: number; windowStart: number }>()
let daily = { date: '', calls: 0 }

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = perIp.get(ip)
  if (!entry || now - entry.windowStart > 60_000) {
    perIp.set(ip, { count: 1, windowStart: now })
    if (perIp.size > 10_000) perIp.clear() // 메모리 방어
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT_PER_MIN
}

function overDailyBudget(max: number): boolean {
  const today = new Date().toISOString().slice(0, 10)
  if (daily.date !== today) daily = { date: today, calls: 0 }
  if (daily.calls >= max) return true
  daily.calls++
  return false
}

export function createApp(getEnv: (c: { env: unknown }) => Env) {
  const app = new Hono()

  app.use('*', async (c, next) => {
    const env = getEnv(c)
    const origins = env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim())
    return cors({
      origin: origins && origins.length > 0 ? origins : '*',
      allowMethods: ['POST', 'GET', 'OPTIONS'],
      allowHeaders: ['content-type', 'x-session-token'],
    })(c, next)
  })

  app.get('/health', (c) => c.json({ ok: true }))

  // 진단 캡처 업로드 — 게임 내 '진단 전송' 버튼이 화면(dataURL)+렌더 정보를 올림.
  // 개발자가 사용자 실기기 화면을 직접 확인하기 위한 통로 (최신본 'latest' 고정키).
  app.post('/diag', async (c) => {
    const env = getEnv(c)
    if (!env.DIAG) return c.json({ ok: false, reason: 'no_kv' })
    const body = await c.req.text() // {img, info} JSON 문자열 (최대 ~수백KB)
    if (body.length > 20 * 1024 * 1024) return c.json({ ok: false, reason: 'too_large' }, 413)
    await env.DIAG.put('latest', body, { expirationTtl: 86400 })
    return c.json({ ok: true })
  })

  app.get('/diag', async (c) => {
    const env = getEnv(c)
    const v = env.DIAG ? await env.DIAG.get('latest') : null
    return v ? c.body(v, 200, { 'content-type': 'application/json' }) : c.json({ ok: false })
  })

  // 게임플레이 로그(RL 데이터셋) 업로드/조회 — ?rl 모드 에피소드. KV 재사용.
  app.post('/rl', async (c) => {
    const env = getEnv(c)
    if (!env.DIAG) return c.json({ ok: false, reason: 'no_kv' })
    const body = await c.req.text()
    if (body.length > 24 * 1024 * 1024) return c.json({ ok: false, reason: 'too_large' }, 413)
    await env.DIAG.put('rl-latest', body, { expirationTtl: 604800 }) // 7일
    return c.json({ ok: true })
  })
  app.get('/rl', async (c) => {
    const env = getEnv(c)
    const v = env.DIAG ? await env.DIAG.get('rl-latest') : null
    return v ? c.body(v, 200, { 'content-type': 'application/json' }) : c.json({ ok: false })
  })

  // 게임 시작 시 1회 — 단기 서명 토큰 발급 (봇 진입 장벽)
  app.get('/session', async (c) => {
    const env = getEnv(c)
    if (!env.SESSION_SECRET) return c.json({ token: '' })
    return c.json({ token: await issueToken(env.SESSION_SECRET) })
  })

  app.post('/directive', async (c) => {
    const env = getEnv(c)
    const ip =
      c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? 'unknown'

    if (rateLimited(ip)) return c.json({ fallback: true, reason: 'rate_limited' }, 429)

    // 세션 토큰 검증 (SECRET 설정 시) — Origin 없는 봇/curl 차단
    if (env.SESSION_SECRET) {
      const ok = await verifyToken(env.SESSION_SECRET, c.req.header('x-session-token'))
      if (!ok) return c.json({ fallback: true, reason: 'no_token' }, 401)
    }

    const parsed = digestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ fallback: true, reason: 'bad_input' }, 400)

    if (!pickProvider(env)) return c.json({ fallback: true, reason: 'no_key' })
    if (overDailyBudget(Number(env.MAX_DAILY_CALLS) || 2000))
      return c.json({ fallback: true, reason: 'budget' })

    try {
      const raw = await callLlm(env, parsed.data)
      const design = (parsed.data.boss ? bossDesignSchema : waveDesignSchema).safeParse(raw)
      if (!design.success) {
        console.error('schema_mismatch', JSON.stringify(raw)?.slice(0, 300))
        return c.json({ fallback: true, reason: 'schema_mismatch' })
      }
      return c.json({ ...design.data, fallback: false })
    } catch (err) {
      console.error('proxy_error', err)
      return c.json({ fallback: true, reason: 'proxy_error' })
    }
  })

  return app
}
