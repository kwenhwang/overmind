import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 점수 제출이 세션 토큰을 실제로 붙이는지 (T-2026W37-244).
 * 서버가 POST /score에도 토큰을 요구하게 됐으므로, 클라가 헤더를 빠뜨리면
 * 판을 끝낸 사람의 점수가 401로 조용히 사라진다 — 여기가 그 회귀를 잡는 자리다.
 */

const PROXY = 'https://overmind-proxy.kwenhwang.workers.dev'

type Call = { url: string; init?: RequestInit }

function mockFetch(handler: (url: string, init?: RequestInit) => Response): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  })
  return calls
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const tokenOf = (call: Call): string | undefined =>
  (call.init?.headers as Record<string, string> | undefined)?.['x-session-token']

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('점수 제출 세션 토큰', () => {
  it('제출에 /session 토큰을 헤더로 붙이고 순위를 돌려준다', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({ token: 'tok-1' }) : json({ ok: true, rank: 3 }),
    )
    const { submitScore } = await import('../../src/ai/director')

    expect(await submitScore('플레이어', 1234, 5, 'v11')).toBe(3)
    const post = calls.find((c) => c.url === `${PROXY}/score`)
    expect(post).toBeDefined()
    expect(tokenOf(post!)).toBe('tok-1')
  })

  it('토큰 만료(401)면 재발급 후 1회 재시도한다 — 긴 판의 점수 유실 방지', async () => {
    let issued = 0
    const calls = mockFetch((url, init) => {
      if (url.endsWith('/session')) return json({ token: `tok-${++issued}` })
      return tokenOf({ url, init }) === 'tok-2' ? json({ ok: true, rank: 1 }) : json({ ok: false, reason: 'no_token' }, 401)
    })
    const { submitScore } = await import('../../src/ai/director')

    expect(await submitScore('플레이어', 999, 2, 'v11')).toBe(1)
    const posts = calls.filter((c) => c.url === `${PROXY}/score`)
    expect(posts.length).toBe(2)
    expect(tokenOf(posts[1]!)).toBe('tok-2')
  })

  it('제출에 성공하면 다음 판을 위해 시계를 새로 받는다 — 이전 판 시간 물림 방지', async () => {
    let issued = 0
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({ token: `tok-${++issued}` }) : json({ ok: true, rank: 1 }),
    )
    const { submitScore } = await import('../../src/ai/director')

    await submitScore('플레이어', 1000, 2, 'v11')
    await new Promise((r) => setTimeout(r, 0)) // 제출 뒤 비동기 재발급이 끝나길 기다린다
    expect(calls.filter((c) => c.url.endsWith('/session')).length).toBe(2)

    await submitScore('플레이어', 2000, 3, 'v11')
    const posts = calls.filter((c) => c.url === `${PROXY}/score`)
    const runTokenOf = (call: Call) =>
      (call.init?.headers as Record<string, string> | undefined)?.['x-run-token']
    expect(runTokenOf(posts[0]!)).toBe('tok-1')
    expect(runTokenOf(posts[1]!)).toBe('tok-2') // 두 번째 판은 새 시계로 센다
  })

  it('제출에 판 시작 토큰(x-run-token)을 함께 싣는다', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({ token: 'tok-1' }) : json({ ok: true, rank: 2 }),
    )
    const { submitScore } = await import('../../src/ai/director')
    await submitScore('플레이어', 500, 1, 'v11')
    const post = calls.find((c) => c.url === `${PROXY}/score`)!
    expect((post.init?.headers as Record<string, string>)['x-run-token']).toBe('tok-1')
  })

  it('400(위조 점수 등)은 재발급으로 안 풀리므로 재시도하지 않는다', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({ token: 'tok-1' }) : json({ ok: false, reason: 'implausible_score' }, 400),
    )
    const { submitScore } = await import('../../src/ai/director')

    expect(await submitScore('위조', 9_999_999, 11, 'v11')).toBe(null)
    expect(calls.filter((c) => c.url === `${PROXY}/score`).length).toBe(1)
  })
})
