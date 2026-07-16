import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { digestSchema, waveDesignSchema, bossDesignSchema } from './schema'
import { callLlm, pickProvider } from './llm'

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
    })(c, next)
  })

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/directive', async (c) => {
    console.log('directive_request', new Date().toISOString())
    const env = getEnv(c)
    const ip =
      c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? 'unknown'

    if (rateLimited(ip)) return c.json({ fallback: true, reason: 'rate_limited' }, 429)

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
