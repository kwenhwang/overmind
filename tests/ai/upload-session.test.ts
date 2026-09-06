import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 업로드가 세션 토큰을 실제로 붙이는지 (T-2026W32-06).
 * 서버가 POST /diag·/rl에 토큰을 요구하게 됐으므로, 클라가 헤더를 빠뜨리면
 * 진단·RL이 401로 조용히 유실된다 — 여기가 그 회귀를 잡는 자리다.
 * director는 모듈 수준에 토큰을 캐시하므로 매 테스트 resetModules로 새로 불러온다.
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

describe('업로드 세션 토큰', () => {
  it('진단 업로드는 /session 토큰을 헤더로 붙인다', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({ token: 'tok-1' }) : json({ ok: true }),
    )
    const { uploadDiag } = await import('../../src/ai/director')

    expect(await uploadDiag({ img: 'x', info: {} })).toBe(true)
    const upload = calls.find((c) => c.url === `${PROXY}/diag`)
    expect(upload).toBeDefined()
    expect(tokenOf(upload!)).toBe('tok-1')
  })

  it('RL 업로드도 같은 토큰을 붙이고, 세션은 한 번만 받는다', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({ token: 'tok-1' }) : json({ ok: true }),
    )
    const { uploadDiag, uploadRL } = await import('../../src/ai/director')

    await uploadDiag({ img: 'x', info: {} })
    expect(await uploadRL({ steps: [] })).toBe(true)
    expect(tokenOf(calls.find((c) => c.url === `${PROXY}/rl`)!)).toBe('tok-1')
    expect(calls.filter((c) => c.url.endsWith('/session')).length).toBe(1)
  })

  it('토큰 만료(401)면 재발급 후 1회 재시도해 성공한다', async () => {
    let issued = 0
    let uploads = 0
    const calls = mockFetch((url) => {
      if (url.endsWith('/session')) return json({ token: `tok-${++issued}` })
      uploads++
      return uploads === 1 ? json({ ok: false, reason: 'no_token' }, 401) : json({ ok: true })
    })
    const { uploadDiag } = await import('../../src/ai/director')

    expect(await uploadDiag({ img: 'x', info: {} })).toBe(true)
    const posts = calls.filter((c) => c.url === `${PROXY}/diag`)
    expect(posts.length).toBe(2)
    expect(tokenOf(posts[0])).toBe('tok-1')
    expect(tokenOf(posts[1])).toBe('tok-2') // 만료 토큰을 그대로 재사용하지 않는다
  })

  it('401이 계속되면 무한 재시도하지 않고 실패를 돌려준다', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({ token: 'tok' }) : json({ ok: false }, 401),
    )
    const { uploadDiag } = await import('../../src/ai/director')

    expect(await uploadDiag({ img: 'x', info: {} })).toBe(false)
    expect(calls.filter((c) => c.url === `${PROXY}/diag`).length).toBe(2)
  })

  it('413(용량 초과)은 토큰 문제가 아니므로 재시도하지 않는다', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({ token: 'tok' }) : json({ ok: false, reason: 'too_large' }, 413),
    )
    const { uploadDiag } = await import('../../src/ai/director')

    expect(await uploadDiag({ img: 'x', info: {} })).toBe(false)
    expect(calls.filter((c) => c.url === `${PROXY}/diag`).length).toBe(1)
  })

  it('AI 설계 요청(/directive)도 만료된 토큰을 재사용하지 않는다 (codex 지적 2026-09-07)', async () => {
    // 종전엔 initSession()이 받아 둔 sessionToken을 그대로 보냈다 — 서버 TTL 30분을 넘긴
    // 판 후반(특히 보스전)에는 매번 401 → 폴백이라 LLM 디렉터가 사실상 죽어 있었다.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-07T00:00:00Z'))
      let issued = 0
      const calls = mockFetch((url) =>
        url.endsWith('/session') ? json({ token: `tok-${++issued}` }) : json({ fallback: true }),
      )
      const { initSession, requestWaveDesign, requestBossDesign } = await import('../../src/ai/director')
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      })

      await initSession()
      vi.setSystemTime(new Date('2026-09-07T00:26:00Z')) // 토큰 최대 수명(25분) 경과
      await requestWaveDesign({
        wave: 1,
        playerHpPct: 100,
        dodgeLeftPct: 50,
        dodgeRightPct: 50,
        meleeUsePct: 50,
        rangedUsePct: 50,
        avgDistToCenter: 0.5,
        damageTakenThisWave: 0,
        killsByType: {},
        waveClearSeconds: 10,
      })
      await requestBossDesign({
        wave: 10,
        playerHpPct: 100,
        dodgeLeftPct: 50,
        dodgeRightPct: 50,
        meleeUsePct: 50,
        rangedUsePct: 50,
        avgDistToCenter: 0.5,
        damageTakenThisWave: 0,
        killsByType: {},
        waveClearSeconds: 10,
      })

      const directives = calls.filter((c) => c.url === `${PROXY}/directive`)
      expect(directives.length).toBe(2)
      for (const d of directives) expect(tokenOf(d)).toBe('tok-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('/directive가 401이면 토큰을 버리고 1회 재발급해 재시도한다 (codex 지적 2026-09-07)', async () => {
    // 서명 키 교체·서버 재배포로 토큰이 죽으면, 복구가 없을 때 캐시 수명(25분) 내내
    // LLM 디렉터가 통째로 규칙 폴백으로 떨어진다.
    let issued = 0
    let directives = 0
    const calls = mockFetch((url) => {
      if (url.endsWith('/session')) return json({ token: `tok-${++issued}` })
      directives++
      return directives === 1 ? json({ fallback: true, reason: 'no_token' }, 401) : json({ fallback: true })
    })
    const { requestWaveDesign } = await import('../../src/ai/director')
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    })

    await requestWaveDesign({
      wave: 1,
      playerHpPct: 100,
      dodgeLeftPct: 50,
      dodgeRightPct: 50,
      meleeUsePct: 50,
      rangedUsePct: 50,
      avgDistToCenter: 0.5,
      damageTakenThisWave: 0,
      killsByType: {},
      waveClearSeconds: 10,
    })

    const posts = calls.filter((c) => c.url === `${PROXY}/directive`)
    expect(posts.length).toBe(2)
    expect(tokenOf(posts[0])).toBe('tok-1')
    expect(tokenOf(posts[1])).toBe('tok-2') // 죽은 토큰을 그대로 재사용하지 않는다
  })

  it('/session이 죽어도 업로드는 시도한다 (SESSION_SECRET 미설정 서버 호환)', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/session') ? json({}, 500) : json({ ok: true }),
    )
    const { uploadDiag } = await import('../../src/ai/director')

    expect(await uploadDiag({ img: 'x', info: {} })).toBe(true)
    expect(tokenOf(calls.find((c) => c.url === `${PROXY}/diag`)!)).toBe('')
  })
})
