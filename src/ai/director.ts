import type { BossDesign, RunContext, TelemetryDigest, WaveDesign } from './schema'

/**
 * L2 디렉터 클라이언트.
 * 프록시(LLM) 우선 → 타임아웃/실패/예산 초과 시 규칙기반 폴백.
 * 게임 루프는 이 모듈을 절대 await하지 않는다 — 웨이브 인터미션에서만 결과를 소비.
 */

const ENDPOINTS: string[] = [
  // 개발 오버라이드 (.env.local의 VITE_PROXY_URL) 우선, 그 뒤 프로덕션 엔드포인트
  ...(import.meta.env.VITE_PROXY_URL ? [import.meta.env.VITE_PROXY_URL] : []),
  'https://overmind-proxy.kwenhwang.workers.dev',
]
const TIMEOUT_MS = 6000
let sessionToken = ''

/** 게임 시작 시 1회 — 프록시에서 단기 서명 토큰을 받아둔다 (없어도 폴백으로 동작) */
export async function initSession(): Promise<void> {
  for (const base of ENDPOINTS) {
    try {
      const res = await fetch(`${base}/session`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) continue
      sessionToken = ((await res.json()) as { token?: string }).token ?? ''
      if (sessionToken) return
    } catch {
      /* 다음 엔드포인트 */
    }
  }
}

/** 진단 캡처 업로드 (게임 내 '진단 전송' 버튼) — 개발자가 사용자 실기기 화면 확인용 */
export async function uploadDiag(payload: { img: string; info: unknown }): Promise<boolean> {
  for (const base of ENDPOINTS) {
    try {
      const res = await fetch(`${base}/diag`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) return true
    } catch {
      /* 다음 엔드포인트 */
    }
  }
  return false
}

/** 게임플레이 로그(RL 데이터셋) 업로드 — ?rl 에피소드 종료 시 */
export async function uploadRL(episode: object): Promise<boolean> {
  for (const base of ENDPOINTS) {
    try {
      const res = await fetch(`${base}/rl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(episode),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) return true
    } catch {
      /* 다음 엔드포인트 */
    }
  }
  return false
}

const PROFILE_KEY = 'overmind-profile'
const RUNS_KEY = 'overmind-runs'
const OUTCOME_KEY = 'overmind-last-outcome'

let seq = 0

/** 판을 넘는 기억 — localStorage 관리 */
export const memory = {
  profile: (): string => localStorage.getItem(PROFILE_KEY) ?? '',
  saveProfile(text: string): void {
    if (text.trim()) localStorage.setItem(PROFILE_KEY, text.slice(0, 600))
  },
  runContext(): RunContext {
    const outcome = localStorage.getItem(OUTCOME_KEY)
    const [kind, wave] = (outcome ?? 'none:0').split(':')
    return {
      runNumber: Number(localStorage.getItem(RUNS_KEY) ?? 1),
      lastOutcome: kind === 'died' || kind === 'victory' ? kind : 'none',
      diedAtWave: Number(wave) || 0,
      profile: this.profile(),
    }
  },
  startRun(): void {
    localStorage.setItem(RUNS_KEY, String(Number(localStorage.getItem(RUNS_KEY) ?? 0) + 1))
  },
  endRun(victory: boolean, wave: number): void {
    localStorage.setItem(OUTCOME_KEY, `${victory ? 'victory' : 'died'}:${wave}`)
  },
}

export async function requestWaveDesign(digest: TelemetryDigest): Promise<WaveDesign> {
  const mySeq = ++seq
  const body = JSON.stringify({ ...digest, ...memory.runContext() })
  for (const base of ENDPOINTS) {
    try {
      const res = await fetch(`${base}/directive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) continue
      const data = (await res.json()) as WaveDesign & { fallback?: boolean }
      if (data.fallback) break // 서버 예산 캡 → 폴백
      if (mySeq !== seq) break // 낡은 응답 폐기
      memory.saveProfile(data.profileUpdate ?? '')
      return sanitize(data, digest.wave + 1)
    } catch {
      // 다음 엔드포인트로 페일오버
    }
  }
  return fallbackDesign(digest)
}

/** 보스전 설계 요청 — 누적 프로파일의 총결산. 실패 시 규칙기반 폴백 보스 */
export async function requestBossDesign(digest: TelemetryDigest): Promise<BossDesign> {
  const body = JSON.stringify({ ...digest, ...memory.runContext(), boss: true })
  for (const base of ENDPOINTS) {
    try {
      const res = await fetch(`${base}/directive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) continue
      const data = (await res.json()) as BossDesign & { fallback?: boolean }
      if (data.fallback) break
      if (!data.phases?.length) break
      return data
    } catch {
      // 다음 엔드포인트로 페일오버
    }
  }
  return fallbackBossDesign(digest)
}

export function fallbackBossDesign(digest: TelemetryDigest): BossDesign {
  const melee = digest.meleeUsePct >= 50
  return {
    verdict: '데이터 수집 완료. 너의 패턴은 이미 기록되었다. 최종 검증을 시작한다.',
    phases: [
      {
        name: '검증 프로토콜',
        attack: melee ? 'radial_burst' : 'charge',
        minions: [{ type: 'drone', count: 2 }],
        hazards: [],
        taunt: '이제 내가 직접 상대한다.',
      },
      {
        name: '말소 프로토콜',
        attack: 'targeted_slam',
        minions: [{ type: 'spitter', count: 2 }],
        hazards: [{ type: 'spike_zone', placement: 'center' }],
        taunt: '흥미로운 저항이다. 하지만 결과는 같다.',
      },
    ],
    winLine: '예측대로였다. 다음 판도 기록하겠다.',
    loseLine: '…계산 밖의 변수였다. 인정한다.',
    mood: 'confident',
  }
}

/**
 * LLM 출력 최종 방어선 + 난이도 가드레일.
 * LLM/폴백이 초반 웨이브에 과도한 구성(12기+모디파이어+해저드)을 쏟아 심사위원이
 * 첫 판에 급사하는 것을 방지 — 웨이브 번호에 비례해 적 수·모디파이어·해저드를 클램프.
 * (설계 의도는 유지하되 강도만 웨이브에 맞게 조인다.)
 */
function sanitize(d: WaveDesign, wave: number): WaveDesign {
  const maxEnemies = Math.min(3 + wave, 9) // W1=4 … W5=8 (완화 — 봇 보스도달 0% 대응)
  const maxModsPerGroup = wave <= 1 ? 0 : wave <= 3 ? 1 : 2
  const maxHazards = wave <= 1 ? 0 : wave <= 3 ? 1 : 2

  let budget = maxEnemies
  const spawns = d.spawns
    .map((s) => {
      const count = Math.max(1, Math.min(s.count, budget))
      budget -= count
      return { type: s.type, count, modifiers: (s.modifiers ?? []).slice(0, maxModsPerGroup) }
    })
    .filter((s) => s.count > 0 && budget >= 0 - s.count)
  if (spawns.length === 0) spawns.push({ type: 'drone', count: Math.min(4, maxEnemies), modifiers: [] })

  return {
    ...d,
    spawns,
    hazards: (d.hazards ?? []).slice(0, maxHazards),
    aggression: (wave <= 1 ? Math.min(d.aggression, 2) : d.aggression) as WaveDesign['aggression'],
  }
}

/**
 * 규칙기반 폴백 — 프록시 불통이어도 게임은 계속된다 (심사 안전망).
 * 텔레메트리를 단순 규칙으로 반영해 "덜 똑똑한 오버마인드"로 동작.
 */
export function fallbackDesign(digest: TelemetryDigest): WaveDesign {
  const wave = digest.wave + 1
  const melee = digest.meleeUsePct >= 50
  // 규칙 기반은 단순 1:1 매핑이 한계 — LLM은 이 부품들을 상황 조합으로 설계한다
  const spawns: WaveDesign['spawns'] = melee
    ? [
        { type: 'spitter', count: Math.min(2 + wave, 6) },
        { type: 'drone', count: wave, modifiers: wave >= 2 ? ['thorns'] : [] },
      ]
    : [
        { type: 'drone', count: Math.min(3 + wave, 8), modifiers: wave >= 3 ? ['enrage_far'] : [] },
        { type: 'brute', count: Math.max(0, wave - 2) },
      ]
  const dodgeLeft = digest.dodgeLeftPct > 60
  return {
    spawns,
    hazards:
      wave >= 3
        ? [{ type: 'spike_zone', placement: dodgeLeft ? 'player_left' : 'player_right' }]
        : [],
    spawnBias: dodgeLeft ? 'left' : digest.dodgeRightPct > 60 ? 'right' : 'surround',
    counterReason: melee
      ? '근접 위주 전투 감지 — 원거리 유닛으로 거리를 벌린다'
      : '원거리 위주 전투 감지 — 돌격 유닛으로 압박한다',
    taunt: TAUNT_POOL[wave % TAUNT_POOL.length],
    profileUpdate: '', // 폴백은 기억을 갱신하지 않음 (기존 프로파일 유지)
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
