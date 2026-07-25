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

// LLM 열화 감시 — LLM계열 폴백(no_key·budget·llm_error·schema_mismatch·proxy_error)이
// 연속되면 KV에 인시던트를 남기고 /health가 노출한다 (외부 가동감시가 키워드로 잡는 용도).
// 아이솔레이트별 카운터라 근사치지만, 키 만료 같은 전역 장애는 모든 아이솔레이트에서 쌓인다.
// 회복 시 플래그를 지우지 않는다(멀티 아이솔레이트 핑퐁 방지) — TTL 만료로 자연 해제.
let llmFailStreak = 0
let degradedPutAt = 0
const LLM_DEGRADED = { key: 'stat:llm_degraded', after: 5, ttl: 21_600, refreshMs: 3_600_000 }

async function noteLlmFallback(env: Env, reason: string): Promise<void> {
  llmFailStreak++
  if (llmFailStreak < LLM_DEGRADED.after) return
  // 임계 도달 순간 1회 + 장애 지속 중 1h마다 갱신 — 저트래픽 장애도 TTL(6h)이 끊기지 않게
  const now = Date.now()
  if (llmFailStreak !== LLM_DEGRADED.after && now - degradedPutAt < LLM_DEGRADED.refreshMs) return
  if (!env.DIAG) return
  try {
    await env.DIAG.put(
      LLM_DEGRADED.key,
      JSON.stringify({ at: new Date().toISOString(), reason, streak: llmFailStreak }),
      { expirationTtl: LLM_DEGRADED.ttl },
    )
    degradedPutAt = now
  } catch (err) {
    console.error('llm_degraded_put_failed', err)
  }
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

  // llm 필드: 외부 가동감시(Uptime Kuma)가 '"llm":"ok"' 키워드 부재로 경보하는 용도
  app.get('/health', async (c) => {
    const env = getEnv(c)
    // KV 없는 런타임(node 예비)에선 판별 불가 — 'ok' 오보 대신 'unknown'
    let llm = 'unknown'
    if (env.DIAG) {
      try {
        llm = (await env.DIAG.get(LLM_DEGRADED.key)) ? 'degraded' : 'ok'
      } catch {
        llm = 'unknown'
      }
    }
    return c.json({ ok: true, llm })
  })

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

  // 에셋 업로드 — 뷰어의 '서버로 전송' 버튼이 생성한 GLB(base64)+슬롯을 올림.
  // 개발자가 curl로 받아 public/models/에 통합. 최신본 'model-latest' 고정키.
  app.post('/model', async (c) => {
    const env = getEnv(c)
    if (!env.DIAG) return c.json({ ok: false, reason: 'no_kv' })
    const body = await c.req.text() // {slot, name, glb(base64)} JSON
    if (body.length > 24 * 1024 * 1024) return c.json({ ok: false, reason: 'too_large' }, 413)
    await env.DIAG.put('model-latest', body, { expirationTtl: 86400 })
    return c.json({ ok: true })
  })

  app.get('/model', async (c) => {
    const env = getEnv(c)
    const v = env.DIAG ? await env.DIAG.get('model-latest') : null
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

  // 전역 리더보드 — 점수 제출/조회 (KV 'leaderboard', 상위 50 유지)
  app.post('/score', async (c) => {
    const env = getEnv(c)
    if (!env.DIAG) return c.json({ ok: false, reason: 'no_kv' })
    const body = (await c.req.json().catch(() => null)) as { name?: string; score?: number; wave?: number; version?: string } | null
    if (!body || typeof body.score !== 'number' || body.score < 0 || body.score > 1e7) {
      return c.json({ ok: false, reason: 'bad_score' }, 400)
    }
    // 밸런스 버전별 리더보드 분리 — 난이도가 바뀌면 점수 비교가 불공정하므로 키를 버전으로 나눔
    const version = (String(body.version ?? 'v0').replace(/[^a-z0-9._-]/gi, '').slice(0, 16)) || 'v0'
    const entry = {
      name: String(body.name ?? '익명').slice(0, 12).replace(/[<>&]/g, ''),
      score: Math.floor(body.score),
      wave: Math.max(0, Math.min(11, Math.floor(body.wave ?? 0))),
      at: Date.now(),
    }
    const key = `leaderboard:${version}`
    try {
      const raw = await env.DIAG.get(key)
      const board = raw ? (JSON.parse(raw) as (typeof entry)[]) : []
      board.push(entry)
      board.sort((a, b) => b.score - a.score)
      const top = board.slice(0, 50)
      await env.DIAG.put(key, JSON.stringify(top))
      return c.json({ ok: true, rank: top.findIndex((e) => e === entry) + 1, total: board.length })
    } catch (err) {
      // 단일 키 리더보드는 KV 키당 1write/sec 제한에 동시 제출이 걸릴 수 있음 — 무음 유실 금지
      console.error('score_kv_failed', err)
      return c.json({ ok: false, reason: 'kv_write_failed' }, 503)
    }
  })
  app.get('/leaderboard', async (c) => {
    const env = getEnv(c)
    const version = (String(c.req.query('v') ?? 'v0').replace(/[^a-z0-9._-]/gi, '').slice(0, 16)) || 'v0'
    const raw = env.DIAG ? await env.DIAG.get(`leaderboard:${version}`) : null
    return c.json(raw ? JSON.parse(raw) : [])
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

    if (!pickProvider(env)) {
      await noteLlmFallback(env, 'no_key')
      return c.json({ fallback: true, reason: 'no_key' })
    }
    if (overDailyBudget(Number(env.MAX_DAILY_CALLS) || 2000)) {
      await noteLlmFallback(env, 'budget')
      return c.json({ fallback: true, reason: 'budget' })
    }

    try {
      const raw = await callLlm(env, parsed.data)
      if (raw === null) {
        // llm.ts가 원인(401·빈 응답·JSON 파손)을 이미 console.error로 남긴 케이스.
        // null을 스키마에 넣으면 schema_mismatch로 위장되므로 사유를 구분한다.
        await noteLlmFallback(env, 'llm_error')
        return c.json({ fallback: true, reason: 'llm_error' })
      }
      const design = (parsed.data.boss ? bossDesignSchema : waveDesignSchema).safeParse(raw)
      if (!design.success) {
        console.error('schema_mismatch', JSON.stringify(raw)?.slice(0, 300))
        await noteLlmFallback(env, 'schema_mismatch')
        return c.json({ fallback: true, reason: 'schema_mismatch' })
      }
      llmFailStreak = 0
      return c.json({ ...design.data, fallback: false })
    } catch (err) {
      console.error('proxy_error', err)
      await noteLlmFallback(env, 'proxy_error')
      return c.json({ fallback: true, reason: 'proxy_error' })
    }
  })

  return app
}
