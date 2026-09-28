import { describe, expect, it } from 'vitest'
import { createApp, type Env } from '../../server/src/app'
import { issueToken } from '../../server/src/token'

/** 임의 시각에 발급된 것처럼 보이는 **정상 서명** 토큰 (서버 시계 기준 경과시간 테스트용) */
async function tokenIssuedAgo(ms: number): Promise<string> {
  const real = Date.now
  Date.now = () => real() - ms
  try {
    return await issueToken(SECRET)
  } finally {
    Date.now = real
  }
}

/**
 * 리더보드 제출(POST /score) 게이트 회귀 테스트 (T-2026W37-244).
 * 고치기 전 구멍: /score만 인증도 리미터도 없어서
 *   curl -XPOST .../score '{"score":9999999}' → {"ok":true} 로 공개 리더보드 최상단 점거.
 * 지키려는 것:
 *   1) 세션 토큰 없는(또는 위조한) 제출은 401이고 리더보드에 아무것도 안 남는다.
 *   2) 토큰이 있어도 웨이브 대비 터무니없는 점수는 400 — /session이 공개 발급이라
 *      토큰만으론 위조를 못 막기 때문에 점수 자체에 상한을 둔다.
 *   3) per-IP 리미터가 도배를 끊는다.
 *   4) 정상 플레이(실측 최고 기록대)는 그대로 통과한다 — 게이트가 진짜 점수를 자르면 안 된다.
 */

const SECRET = 'test-session-secret'

function fakeEnv(over: Partial<Env> = {}): Env {
  const kv = new Map<string, string>()
  return {
    DIAG: {
      put: async (k: string, v: string) => void kv.set(k, v),
      get: async (k: string) => kv.get(k) ?? null,
    },
    ...over,
  }
}

const appFor = (env: Env) => createApp(() => env)

/** 리미터가 모듈 수준 Map이라 테스트끼리 새는 것을 막으려고 IP를 매번 다르게 준다 */
let ipSeq = 0
const nextIp = () => `10.0.0.${++ipSeq}`

const scorePost = (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  ip = nextIp(),
) =>
  new Request('http://x/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
    body: JSON.stringify(body),
  })

const board = async (app: ReturnType<typeof appFor>, v = 'v11') =>
  (await (await app.request(`/leaderboard?v=${v}`)).json()) as { score: number }[]

describe('제출(POST /score) 게이트 — 세션 토큰', () => {
  it('토큰 없는 제출은 401이고 리더보드에 안 들어간다 (티켓 재현 경로)', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const res = await app.request(scorePost({ name: '위조', score: 9_999_999, wave: 11, version: 'v11' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'no_token' })
    expect(await board(app)).toEqual([])
  })

  it('위조 토큰도 401', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const res = await app.request(
      scorePost({ score: 1000, wave: 2, version: 'v11' }, { 'x-session-token': `${Date.now()}.forged` }),
    )
    expect(res.status).toBe(401)
    expect(await board(app)).toEqual([])
  })

  it('정상 토큰이면 등재되고 순위를 돌려준다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await tokenIssuedAgo(5 * 60_000) // 5분짜리 한 판
    const res = await app.request(
      scorePost({ name: '플레이어', score: 34_500, wave: 11, version: 'v11' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, rank: 1 })
    expect(await board(app)).toMatchObject([{ name: '플레이어', score: 34_500, wave: 11 }])
  })

  it('SESSION_SECRET 미설정(로컬·예비 런타임)에서는 검증을 생략한다', async () => {
    const app = appFor(fakeEnv())
    const res = await app.request(scorePost({ score: 100, wave: 1, version: 'v11' }))
    expect(res.status).toBe(200)
  })
})

describe('점수 상한 — 토큰을 받아도 위조 점수는 못 넣는다', () => {
  const withToken = async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    return { app, token: await issueToken(SECRET) }
  }

  it('웨이브 11이어도 9,999,999는 400', async () => {
    const { app, token } = await withToken()
    const res = await app.request(
      scorePost({ score: 9_999_999, wave: 11, version: 'v11' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'implausible_score' })
    expect(await board(app)).toEqual([])
  })

  it('웨이브를 부풀려 상한을 늘리려 해도 정규화된 웨이브(≤11)로 판정한다', async () => {
    const { app, token } = await withToken()
    const res = await app.request(
      scorePost({ score: 5_000_000, wave: 9999, version: 'v11' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(400)
    expect(await board(app)).toEqual([])
  })

  it('웨이브 1에 100만 점 같은 비율 위조도 400', async () => {
    const { app, token } = await withToken()
    const res = await app.request(
      scorePost({ score: 1_000_000, wave: 1, version: 'v11' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(400)
  })

  it('NaN·음수·비수치는 bad_score', async () => {
    const { app, token } = await withToken()
    for (const score of [-1, 'x', null, undefined]) {
      const res = await app.request(
        scorePost({ score, wave: 3, version: 'v11' }, { 'x-session-token': token }),
      )
      expect(res.status, String(score)).toBe(400)
      expect(await res.json()).toMatchObject({ reason: 'bad_score' })
    }
  })

  it('실측 최고 기록대(웨이브 9 · 166,850)는 그대로 통과한다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await tokenIssuedAgo(10 * 60_000) // 10분짜리 한 판
    const res = await app.request(
      scorePost({ name: '황도윤', score: 166_850, wave: 9, version: 'v9' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(200)
    expect(await board(app, 'v9')).toMatchObject([{ score: 166_850 }])
  })
})

describe('토큰 발급 시각 상한 — 방금 받은 토큰으로는 큰 점수를 못 넣는다', () => {
  it('토큰을 받자마자 1,000,000점을 넣으려 하면 400 too_fast (codex 교차검증 지적)', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await issueToken(SECRET) // 지금 막 받은 토큰
    const res = await app.request(
      scorePost({ name: '위조', score: 1_000_000, wave: 11, version: 'v11' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'too_fast' })
    expect(await board(app)).toEqual([])
  })

  it('경과시간만큼만 허용한다 — 2분 된 토큰은 18만점은 되고 100만점은 안 된다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await tokenIssuedAgo(2 * 60_000) // 1,500점/초 × 120초 + 2,000 = 182,000
    const ok = await app.request(
      scorePost({ score: 180_000, wave: 9, version: 'v11' }, { 'x-session-token': token }),
    )
    expect(ok.status).toBe(200)
    const tooFast = await app.request(
      scorePost({ score: 1_000_000, wave: 11, version: 'v11' }, { 'x-session-token': token }),
    )
    expect(tooFast.status).toBe(400)
    expect(await tooFast.json()).toMatchObject({ reason: 'too_fast' })
  })

  it('즉사(짧은 판)의 소액 점수는 갓 받은 토큰으로도 통과한다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const res = await app.request(
      scorePost({ score: 1_500, wave: 1, version: 'v11' }, { 'x-session-token': await issueToken(SECRET) }),
    )
    expect(res.status).toBe(200)
  })

  it('SESSION_SECRET 미설정 런타임에서는 시간 상한을 적용하지 않는다(웨이브 상한은 그대로)', async () => {
    const app = appFor(fakeEnv())
    const ok = await app.request(scorePost({ score: 90_000, wave: 1, version: 'v11' }))
    expect(ok.status).toBe(200)
    const capped = await app.request(scorePost({ score: 900_000, wave: 1, version: 'v11' }))
    expect(capped.status).toBe(400)
  })
})

describe('판 시작 시계(x-run-token) — 긴 세션에서 토큰이 갱신돼도 정상 점수는 산다', () => {
  it('갱신된 토큰 + 판 시작 토큰이면 통과한다 (codex 교차검증 지적 2회차)', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const fresh = await issueToken(SECRET) // 제출 직전 갱신된 인증 토큰
    const runToken = await tokenIssuedAgo(40 * 60_000) // 40분 전 탭을 열며 받은 최초 토큰(이미 만료)
    const res = await app.request(
      scorePost({ score: 150_000, wave: 9, version: 'v11' }, { 'x-session-token': fresh, 'x-run-token': runToken }),
    )
    expect(res.status).toBe(200)
  })

  it('서명이 안 맞는 판 시작 토큰은 무시한다 — 위조로 상한을 넓힐 수 없다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const fresh = await issueToken(SECRET)
    const forged = `${Date.now() - 40 * 60_000}.forged-signature-aaaaaaaaaaaaaaaaaaaaaaaaaaa`
    const res = await app.request(
      scorePost({ score: 150_000, wave: 9, version: 'v11' }, { 'x-session-token': fresh, 'x-run-token': forged }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'too_fast' })
  })

  it('더 늦게 발급된 판 시작 토큰은 시계를 되감지 못한다 — 더 이른 쪽만 채택', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const older = await tokenIssuedAgo(10 * 60_000) // 허용 2,000 + 1,500×600 = 902,000
    const later = await issueToken(SECRET)
    const keep = await app.request(
      scorePost({ score: 500_000, wave: 11, version: 'v11' }, { 'x-session-token': older, 'x-run-token': later }),
    )
    expect(keep.status).toBe(200) // 늦은 토큰은 무시되고 인증 토큰(10분) 기준이 그대로 산다
    const over = await app.request(
      scorePost({ score: 1_000_000, wave: 11, version: 'v11' }, { 'x-session-token': older, 'x-run-token': later }),
    )
    expect(over.status).toBe(400)
  })
})

describe('제출 도배 — per-IP 리미터', () => {
  it('cf-connecting-ip가 없는 런타임에서는 XFF로 사용자를 가른다 (남의 제출이 내 429가 되지 않게)', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await issueToken(SECRET)
    const mine = `10.9.9.${++ipSeq}`
    const post = (xff: string) =>
      new Request('http://x/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `${xff}, 10.0.0.1`, 'x-session-token': token },
        body: JSON.stringify({ score: 100, wave: 1, version: 'v11' }),
      })
    for (let i = 0; i < 11; i++) await app.request(post(mine)) // 남이 창을 다 쓴다
    const others = await app.request(post(`10.9.8.${++ipSeq}`))
    expect(others.status).toBe(200) // 다른 사용자는 멀쩡해야 한다
  })

  it('같은 IP로 10회를 넘기면 429', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await issueToken(SECRET)
    const ip = nextIp()
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      const res = await app.request(
        scorePost({ score: 100 + i, wave: 1, version: 'v11' }, { 'x-session-token': token }, ip),
      )
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200))
    expect(statuses.slice(10)).toEqual([429, 429])
    expect((await board(app)).length).toBe(10)
  })
})

/**
 * 자동화(우리 야간 감사 렌즈) 오염 차단·자가청소 (T-2026W38-396).
 * 실사고 2건이 이 describe의 재현 대상이다:
 *   · v9 1위 `qa-probe-p0` 9,999,999점(웨이브11) — 보안 렌즈가 라이브에 위조 점수를 밀어 넣었다.
 *   · v11 `test-ux-revi` 1점(웨이브1) — UX 렌즈가 헤드리스 플레이 후 이름을 남겨 6일 잔류했다.
 * 지키려는 것: (1) 프로브 이름은 공개 보드에 못 들어간다 (2) 모래상자 버전은 열려 있다
 *   (3) **이미 들어와 앉은 오염은 읽기에서 안 보이고 다음 제출 때 격리로 옮겨진다**
 *   (4) 격리 기록에 실패하면 청소하지 않는다 — 증거 없는 삭제 금지.
 */
describe('자동화 제출 차단 — 예약 이름', () => {
  it('프로브 이름(qa-probe-p0)은 400이고 공개 보드에 안 남는다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await tokenIssuedAgo(10 * 60 * 1000)
    const res = await app.request(
      scorePost({ name: 'qa-probe-p0', score: 500_000, wave: 11, version: 'v9' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'reserved_name' })
    expect(await board(app, 'v9')).toEqual([])
  })

  it('UX 렌즈 이름(test-ux-revi)도 막힌다 — 점수가 1점이어도 공개 보드는 사람 것이다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await issueToken(SECRET)
    const res = await app.request(
      scorePost({ name: 'test-ux-revi', score: 1, wave: 1, version: 'v11' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(400)
    expect(await board(app)).toEqual([])
  })

  it('모래상자 버전(sandbox)에는 넣을 수 있다 — 렌즈가 갈 곳을 없애면 또 라이브를 때린다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await issueToken(SECRET)
    const res = await app.request(
      scorePost({ name: 'qa-probe-p0', score: 100, wave: 1, version: 'sandbox' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(200)
    expect((await board(app, 'sandbox')).length).toBe(1)
    expect(await board(app, 'v11')).toEqual([]) // 공개 보드는 그대로 비어 있다
  })

  it('사람 이름은 그대로 통과한다 — 게이트가 진짜 플레이어를 자르면 안 된다', async () => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const token = await tokenIssuedAgo(10 * 60 * 1000)
    const res = await app.request(
      scorePost({ name: '황도윤', score: 166_850, wave: 9, version: 'v9' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(200)
    expect(await board(app, 'v9')).toMatchObject([{ name: '황도윤', score: 166_850 }])
  })
})

describe('이미 오염된 보드의 자가청소', () => {
  /** 사고 당시 라이브 KV 그대로 — 위조 점수 1위 + 프로브 이름 잔류 + 진짜 기록들 */
  const pollutedBoard = JSON.stringify([
    { name: 'qa-probe-p0', score: 9_999_999, wave: 11, at: 1789750052176 },
    { name: '황도윤', score: 166_850, wave: 9, at: 1784369433808 },
    { name: 'test-ux-revi', score: 1, wave: 1, at: 1789231254582 },
  ])

  function envWith(board: string, over: Partial<Env> = {}): { env: Env; kv: Map<string, string> } {
    const kv = new Map<string, string>([['leaderboard:v9', board]])
    return {
      kv,
      env: {
        SESSION_SECRET: SECRET,
        DIAG: {
          put: async (k: string, v: string) => void kv.set(k, v),
          get: async (k: string) => kv.get(k) ?? null,
        },
        ...over,
      },
    }
  }

  it('조회(GET)에서 위조 점수와 프로브 이름이 사라진다 — 배포 즉시 공개 보드가 깨끗해진다', async () => {
    const { env } = envWith(pollutedBoard)
    const app = appFor(env)
    expect(await board(app, 'v9')).toMatchObject([{ name: '황도윤', score: 166_850 }])
  })

  it('다음 제출 때 오염이 KV에서 빠지고 격리 키에 옮겨 적힌다 (지우지 않는다)', async () => {
    const { env, kv } = envWith(pollutedBoard)
    const app = appFor(env)
    const token = await tokenIssuedAgo(10 * 60 * 1000)
    const res = await app.request(
      scorePost({ name: '아빠', score: 164_000, wave: 9, version: 'v9' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(200)
    const stored = JSON.parse(kv.get('leaderboard:v9')!) as { name: string }[]
    expect(stored.map((e) => e.name)).toEqual(['황도윤', '아빠'])
    const quarantined = JSON.parse(kv.get('leaderboard:v9:quarantine')!) as { name: string }[]
    expect(quarantined.map((e) => e.name).sort()).toEqual(['qa-probe-p0', 'test-ux-revi'])
  })

  it('격리 기록에 실패하면 청소하지 않는다 — 증거 없는 삭제보다 눈에 보이는 오염이 낫다', async () => {
    const { env, kv } = envWith(pollutedBoard)
    const put = env.DIAG!.put
    env.DIAG!.put = async (k: string, v: string) => {
      if (k.endsWith(':quarantine')) throw new Error('kv down')
      return put(k, v)
    }
    const app = appFor(env)
    const token = await tokenIssuedAgo(10 * 60 * 1000)
    const res = await app.request(
      scorePost({ name: '아빠', score: 164_000, wave: 9, version: 'v9' }, { 'x-session-token': token }),
    )
    expect(res.status).toBe(200)
    const stored = JSON.parse(kv.get('leaderboard:v9')!) as { name: string }[]
    expect(stored).toHaveLength(4) // 오염 2건이 그대로 남아 있다
    expect(await board(app, 'v9')).toHaveLength(2) // 다만 사람 눈에는 안 보인다
  })
})
