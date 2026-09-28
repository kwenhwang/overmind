/**
 * 단기 세션 토큰 (HMAC-SHA256) — 봇/curl 남용 방어.
 * CORS는 브라우저에서만 강제되므로 Origin 헤더 없는 직접 호출을 막지 못한다.
 * 게임 시작 시 /session에서 서명 토큰을 받고, /directive가 이를 검증한다.
 * 완벽한 방어는 아니지만(토큰도 스크립트로 받을 수 있음) 진입 장벽 + IP 레이트리밋 +
 * 일일 캡의 다층 방어를 이룬다. 서명은 SECRET을 모르면 위조 불가.
 */

const TTL_MS = 30 * 60 * 1000 // 30분 (한 세션 플레이 시간 여유)

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  return b64url(new Uint8Array(sig))
}

/** 토큰 = "<발급시각ms>.<hmac>" */
export async function issueToken(secret: string): Promise<string> {
  const ts = String(Date.now())
  return `${ts}.${await hmac(secret, ts)}`
}

/**
 * 서명이 이미 검증된 토큰에서 발급 시각(ms)을 꺼낸다 — 형식이 아니면 null.
 * 발급 시각은 SECRET으로 서명된 값이라 클라이언트가 위조할 수 없다. /score가 이걸
 * '그 사이에 실제로 얼마나 벌 수 있었나'의 기준 시계로 쓴다 (T-2026W37-244).
 */
export function tokenIssuedAt(token: string | undefined): number | null {
  if (!token) return null
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const issued = Number(token.slice(0, dot))
  return Number.isFinite(issued) ? issued : null
}

/**
 * 서명만 검증한다 — TTL은 보지 않는다. '이 시각에 우리가 발급한 토큰이다'라는 사실만 필요한
 * 곳(=/score의 판 시작 시계)에서 쓴다. 인증 통과에는 절대 쓰지 마라 (T-2026W37-244).
 */
export async function verifyTokenSignature(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot < 0) return false
  const ts = token.slice(0, dot)
  const issued = Number(ts)
  if (!Number.isFinite(issued) || issued > Date.now() + 60_000) return false
  return constantTimeEq(token.slice(dot + 1), await hmac(secret, ts))
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyToken(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot < 0) return false
  const ts = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const issued = Number(ts)
  if (!Number.isFinite(issued) || Date.now() - issued > TTL_MS || issued > Date.now() + 60_000) return false
  const expected = await hmac(secret, ts)
  // 길이 동일 + 상수시간 비교
  if (sig.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
