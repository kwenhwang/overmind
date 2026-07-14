import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { digestSchema, waveDesignSchema, directiveTool } from './schema'
import { SYSTEM_PROMPT, buildUserMessage } from './prompt'

export interface Env {
  ANTHROPIC_API_KEY: string
  /** 쉼표 구분 허용 오리진. 미설정 시 로컬 개발용 전체 허용 */
  ALLOWED_ORIGINS?: string
  MODEL?: string
  /** 일일 LLM 호출 상한 (기본 2000 ≈ $4~5). 최종 방어선은 Anthropic 콘솔의 워크스페이스 지출 한도 */
  MAX_DAILY_CALLS?: string
}

const RATE_LIMIT_PER_MIN = 10
const DEFAULT_MODEL = 'claude-haiku-4-5'

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
    const env = getEnv(c)
    const ip =
      c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? 'unknown'

    if (rateLimited(ip)) return c.json({ fallback: true, reason: 'rate_limited' }, 429)

    const parsed = digestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ fallback: true, reason: 'bad_input' }, 400)

    if (!env.ANTHROPIC_API_KEY) return c.json({ fallback: true, reason: 'no_key' })
    if (overDailyBudget(Number(env.MAX_DAILY_CALLS) || 2000))
      return c.json({ fallback: true, reason: 'budget' })

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.MODEL || DEFAULT_MODEL,
          max_tokens: 500,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserMessage(parsed.data) }],
          tools: [directiveTool],
          tool_choice: { type: 'tool', name: directiveTool.name },
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        console.error('anthropic_error', res.status, await res.text().catch(() => ''))
        return c.json({ fallback: true, reason: 'llm_error' })
      }
      const msg = (await res.json()) as { content?: { type: string; input?: unknown }[] }
      const toolUse = msg.content?.find((b) => b.type === 'tool_use')
      const design = waveDesignSchema.safeParse(toolUse?.input)
      if (!design.success) {
        console.error('schema_mismatch', JSON.stringify(toolUse?.input).slice(0, 300))
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
