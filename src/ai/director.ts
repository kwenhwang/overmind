import type { TelemetryDigest, WaveDesign } from './schema'

/**
 * L2 디렉터 클라이언트.
 * 프록시(LLM) 우선 → 타임아웃/실패/예산 초과 시 규칙기반 폴백.
 * 게임 루프는 이 모듈을 절대 await하지 않는다 — 웨이브 인터미션에서만 결과를 소비.
 */

const ENDPOINTS: string[] = [
  // 개발 오버라이드 (.env.local의 VITE_PROXY_URL) 우선, 그 뒤 프로덕션 엔드포인트
  ...(import.meta.env.VITE_PROXY_URL ? [import.meta.env.VITE_PROXY_URL] : []),
  // CF Worker 배포 후 추가: 'https://overmind-proxy.<account>.workers.dev'
]
const TIMEOUT_MS = 6000

let seq = 0

export async function requestWaveDesign(digest: TelemetryDigest): Promise<WaveDesign> {
  const mySeq = ++seq
  for (const base of ENDPOINTS) {
    try {
      const res = await fetch(`${base}/directive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(digest),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) continue
      const data = (await res.json()) as WaveDesign & { fallback?: boolean }
      if (data.fallback) break // 서버 예산 캡 → 폴백
      if (mySeq !== seq) break // 낡은 응답 폐기
      return sanitize(data)
    } catch {
      // 다음 엔드포인트로 페일오버
    }
  }
  return fallbackDesign(digest)
}

/** LLM 출력 최종 방어선 — 스키마는 서버가 보장하지만 수치 범위는 클라이언트도 확인 */
function sanitize(d: WaveDesign): WaveDesign {
  const total = d.spawns.reduce((n, s) => n + s.count, 0)
  if (total < 1 || total > 14) return { ...d, spawns: [{ type: 'drone', count: 6 }] }
  return d
}

/**
 * 규칙기반 폴백 — 프록시 불통이어도 게임은 계속된다 (심사 안전망).
 * 텔레메트리를 단순 규칙으로 반영해 "덜 똑똑한 오버마인드"로 동작.
 */
export function fallbackDesign(digest: TelemetryDigest): WaveDesign {
  const wave = digest.wave + 1
  const melee = digest.meleeUsePct >= 50
  const spawns: WaveDesign['spawns'] = melee
    ? [
        { type: 'spitter', count: Math.min(2 + wave, 6) },
        { type: 'drone', count: wave },
      ]
    : [
        { type: 'drone', count: Math.min(3 + wave, 8) },
        { type: 'brute', count: Math.max(0, wave - 2) },
      ]
  const dodgeLeft = digest.dodgeLeftPct > 60
  return {
    spawns,
    spawnBias: dodgeLeft ? 'left' : digest.dodgeRightPct > 60 ? 'right' : 'surround',
    counterReason: melee
      ? '근접 위주 전투 감지 — 원거리 유닛으로 거리를 벌린다'
      : '원거리 위주 전투 감지 — 돌격 유닛으로 압박한다',
    taunt: TAUNT_POOL[wave % TAUNT_POOL.length],
    mood: digest.playerHpPct < 35 ? 'confident' : 'angry',
    aggression: Math.min(5, 2 + Math.floor(wave / 2)) as WaveDesign['aggression'],
  }
}

const TAUNT_POOL = [
  '패턴 분석 완료. 다음 수는 이미 정해져 있다.',
  '너의 습관이 너를 배신할 것이다.',
  '흥미롭군. 하지만 예측 가능해.',
  '재구성한다. 이번엔 다를 것이다.',
  '네 움직임은 전부 기록되고 있다.',
]
