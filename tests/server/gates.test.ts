import { describe, expect, it } from 'vitest'
import { createApp, type Env } from '../../server/src/app'
import { issueToken } from '../../server/src/token'

/**
 * 진단·에셋·RL KV 라우트의 인증 게이트 회귀 테스트 (T-2026W32-06).
 * 지키려는 것:
 *   1) 조회(GET)는 DIAG_KEY 없이는 절대 열리지 않는다 — 키 미설정이면 503(fail-closed).
 *   2) 업로드(POST)는 세션 토큰 없이는 KV에 못 쓴다 — 무자격 20MB 쓰기 차단.
 *   3) /health가 게이트 켜짐/꺼짐을 노출해 '시크릿 주입을 깜빡한 배포'를 밖에서 잡는다.
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

const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ img: 'data:image/png;base64,AA', info: {} }),
  })

describe('조회(GET) 게이트 — DIAG_KEY', () => {
  const paths = ['/diag', '/model', '/rl']

  it.each(paths)('%s: 키 미설정 배포는 열리지 않고 503', async (path) => {
    const res = await appFor(fakeEnv()).request(path)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ reason: 'diag_key_unset' })
  })

  it.each(paths)('%s: 키 설정 후 헤더 없으면 401', async (path) => {
    const res = await appFor(fakeEnv({ DIAG_KEY: 'k' })).request(path)
    expect(res.status).toBe(401)
  })

  it.each(paths)('%s: 올바른 키면 통과', async (path) => {
    const res = await appFor(fakeEnv({ DIAG_KEY: 'k' })).request(path, {
      headers: { 'x-diag-key': 'k' },
    })
    expect(res.status).toBe(200)
  })
})

describe('업로드(POST) 게이트 — 세션 토큰', () => {
  const paths = ['/diag', '/model', '/rl']

  it.each(paths)('%s: 토큰 없는 POST는 401이고 KV에 아무것도 안 남는다', async (path) => {
    const env = fakeEnv({ SESSION_SECRET: SECRET, DIAG_KEY: 'k' })
    const app = appFor(env)
    const res = await app.request(post(path))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ reason: 'no_token' })
    // 같은 워커에서 조회해도 비어 있어야 한다 (쓰기가 실제로 막혔는지 확인)
    const read = await app.request(path, { headers: { 'x-diag-key': 'k' } })
    expect(await read.json()).toMatchObject({ ok: false })
  })

  it.each(paths)('%s: 위조 토큰도 401', async (path) => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET }))
    const res = await app.request(post(path, { 'x-session-token': `${Date.now()}.forged` }))
    expect(res.status).toBe(401)
  })

  it.each(paths)('%s: 정상 토큰이면 저장된다', async (path) => {
    const app = appFor(fakeEnv({ SESSION_SECRET: SECRET, DIAG_KEY: 'k' }))
    const token = await issueToken(SECRET)
    const res = await app.request(post(path, { 'x-session-token': token }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    const read = await app.request(path, { headers: { 'x-diag-key': 'k' } })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ info: {} })
  })

  it('SESSION_SECRET 미설정(로컬·예비 런타임)에서는 검증을 생략한다', async () => {
    const res = await appFor(fakeEnv()).request(post('/diag'))
    expect(res.status).toBe(200)
  })
})

describe('/health 게이트 노출 — 조용한 무효화 감지', () => {
  it('시크릿이 다 주입된 배포는 on/on', async () => {
    const res = await appFor(fakeEnv({ DIAG_KEY: 'k', SESSION_SECRET: SECRET })).request('/health')
    expect(await res.json()).toMatchObject({ ok: true, gates: { diag: 'on', session: 'on' } })
  })

  it('주입을 깜빡하면 off가 드러난다 (키 값 자체는 노출 금지)', async () => {
    const res = await appFor(fakeEnv()).request('/health')
    const body = (await res.json()) as { gates: Record<string, string> }
    expect(body.gates).toEqual({ diag: 'off', session: 'off' })
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })
})
