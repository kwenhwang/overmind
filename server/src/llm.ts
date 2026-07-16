import { directiveTool } from './schema'
import { SYSTEM_PROMPT, buildUserMessage } from './prompt'
import type { Digest } from './schema'
import type { Env } from './app'

/**
 * LLM 프로바이더 계층 — OpenAI(기본)와 Anthropic 겸용.
 * 어느 쪽이든 검증 전 원시 객체를 반환하고, 최종 검증은 app.ts의 zod가 담당.
 */

const OPENAI_DEFAULT_MODEL = 'gpt-5.4-mini'
const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5'

export function pickProvider(env: Env): 'openai' | 'anthropic' | null {
  if (env.PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) return 'anthropic'
  if (env.PROVIDER === 'openai' && env.OPENAI_API_KEY) return 'openai'
  if (env.OPENAI_API_KEY) return 'openai'
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  return null
}

export async function callLlm(env: Env, digest: Digest): Promise<unknown> {
  const provider = pickProvider(env)
  if (provider === 'openai') return callOpenAi(env, digest)
  if (provider === 'anthropic') return callAnthropic(env, digest)
  return null
}

/**
 * directiveTool.input_schema → OpenAI strict json_schema.
 * strict 모드는 모든 중첩 object에 additionalProperties:false를 요구 — 재귀로 부여.
 */
function openAiSchema(): Record<string, unknown> {
  const schema = structuredClone(directiveTool.input_schema) as Record<string, unknown>
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (obj.type === 'object') {
      obj.additionalProperties = false
      const props = obj.properties as Record<string, unknown> | undefined
      if (props) for (const v of Object.values(props)) walk(v)
    }
    if (obj.items) walk(obj.items)
  }
  walk(schema)
  return schema
}

async function callOpenAi(env: Env, digest: Digest): Promise<unknown> {
  const body: Record<string, unknown> = {
    model: env.MODEL || OPENAI_DEFAULT_MODEL,
    // 한국어 대사가 길면 500으로는 JSON이 중간에 잘림(finish_reason=length) — 실측 후 900으로 확정
    max_completion_tokens: 900,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(digest) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'wave_design', strict: true, schema: openAiSchema() },
    },
  }
  // gpt-5 계열 저지연 설정 — 미지원 모델이면 해당 파라미터 없이 1회 재시도
  if (env.REASONING_EFFORT !== 'off') body.reasoning_effort = env.REASONING_EFFORT || 'none'

  let res = await openAiFetch(env, body)
  if (res.status === 400 && 'reasoning_effort' in body) {
    delete body.reasoning_effort
    res = await openAiFetch(env, body)
  }
  if (!res.ok) {
    console.error('openai_error', res.status, await res.text().catch(() => ''))
    return null
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string; refusal?: string }; finish_reason?: string }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    console.error('openai_empty', JSON.stringify(data).slice(0, 500))
    return null
  }
  const parsed = parseFirstJsonObject(content)
  if (parsed === null) console.error('openai_bad_json', content.slice(0, 300))
  return parsed
}

/**
 * gpt-5.4-mini가 strict json_schema에서도 간헐적으로 JSON 객체를 두 개 연달아
 * 출력하는 사례 실측(5회 중 3회) — 첫 번째 완결 객체만 추출한다.
 */
function parseFirstJsonObject(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    /* 아래에서 첫 객체 추출 시도 */
  }
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i++
        i++
      }
    } else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function openAiFetch(env: Env, body: Record<string, unknown>): Promise<Response> {
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
}

async function callAnthropic(env: Env, digest: Digest): Promise<unknown> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.MODEL || ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(digest) }],
      tools: [directiveTool],
      tool_choice: { type: 'tool', name: directiveTool.name },
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    console.error('anthropic_error', res.status, await res.text().catch(() => ''))
    return null
  }
  const msg = (await res.json()) as { content?: { type: string; input?: unknown }[] }
  return msg.content?.find((b) => b.type === 'tool_use')?.input ?? null
}
