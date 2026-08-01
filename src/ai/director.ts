import type { BossDesign, Modifier, RunContext, TelemetryDigest, WaveDesign } from './schema'

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
// 웨이브 설계는 전투 중 프리페치(백그라운드)라 게임을 막지 않음 → 넉넉히.
// gpt-5.4-mini의 한국어 보스급 응답이 ~16s 걸려 기존 6s는 항상 폴백이었음(치명적).
const TIMEOUT_MS = 20000
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

export interface ScoreEntry {
  name: string
  score: number
  wave: number
  at: number
}

/** 점수 제출 → 순위 반환. version별로 리더보드 분리(밸런스 변경 시 점수 비교 공정성) */
export async function submitScore(name: string, score: number, wave: number, version: string): Promise<number | null> {
  for (const base of ENDPOINTS) {
    try {
      const res = await fetch(`${base}/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, score, wave, version }),
        signal: AbortSignal.timeout(6000),
      })
      if (!res.ok) continue
      return ((await res.json()) as { rank?: number }).rank ?? null
    } catch {
      /* 다음 */
    }
  }
  return null
}

/** 리더보드 조회 (해당 version 상위) */
export async function fetchLeaderboard(version: string): Promise<ScoreEntry[]> {
  for (const base of ENDPOINTS) {
    try {
      const res = await fetch(`${base}/leaderboard?v=${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(6000) })
      if (res.ok) return (await res.json()) as ScoreEntry[]
    } catch {
      /* 다음 */
    }
  }
  return []
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

let openingSeq = 0
let waveSeq = 0
let bossSeq = 0

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

async function fetchWaveDesign(
  digest: TelemetryDigest,
  signal: AbortSignal | undefined,
  isCurrent: () => boolean,
  persistProfile: boolean,
): Promise<WaveDesign | null> {
  const body = JSON.stringify({ ...digest, ...memory.runContext() })
  for (const base of ENDPOINTS) {
    if (signal?.aborted || !isCurrent()) return null
    try {
      const res = await fetch(`${base}/directive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      })
      if (signal?.aborted || !isCurrent()) return null
      if (!res.ok) continue
      const data = (await res.json()) as WaveDesign & { fallback?: boolean }
      if (data.fallback) break // 서버 예산 캡 → 폴백
      if (signal?.aborted || !isCurrent()) return null
      if (persistProfile) memory.saveProfile(data.profileUpdate ?? '')
      return finalizeDesign(data, digest, 'llm')
    } catch {
      if (signal?.aborted || !isCurrent()) return null
      // 다음 엔드포인트로 페일오버
    }
  }
  if (signal?.aborted || !isCurrent()) return null
  return fallbackDesign(digest)
}

export async function requestWaveDesign(digest: TelemetryDigest, signal?: AbortSignal): Promise<WaveDesign | null> {
  const requestSeq = ++waveSeq
  return fetchWaveDesign(digest, signal, () => requestSeq === waveSeq, true)
}

/** W1을 막지 않는 복귀 인사 전용 요청. 웨이브 프리페치와 수명·프로파일 갱신을 분리한다. */
export async function requestOpeningDesign(digest: TelemetryDigest, signal?: AbortSignal): Promise<WaveDesign | null> {
  const requestSeq = ++openingSeq
  return fetchWaveDesign(digest, signal, () => requestSeq === openingSeq, false)
}

/** 보스전 설계 요청 — 누적 프로파일의 총결산. 실패 시 규칙기반 폴백 보스 */
export async function requestBossDesign(digest: TelemetryDigest, signal?: AbortSignal): Promise<BossDesign | null> {
  const mySeq = ++bossSeq
  const body = JSON.stringify({ ...digest, ...memory.runContext(), boss: true })
  for (const base of ENDPOINTS) {
    if (signal?.aborted || mySeq !== bossSeq) return null
    try {
      const res = await fetch(`${base}/directive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      })
      if (signal?.aborted || mySeq !== bossSeq) return null
      if (!res.ok) continue
      const data = (await res.json()) as BossDesign & { fallback?: boolean }
      if (data.fallback) break
      if (!data.phases?.length) break
      if (signal?.aborted || mySeq !== bossSeq) return null
      return data
    } catch {
      if (signal?.aborted || mySeq !== bossSeq) return null
      // 다음 엔드포인트로 페일오버
    }
  }
  if (signal?.aborted || mySeq !== bossSeq) return null
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
 * LLM/폴백이 초반 웨이브에 과도한 구성(다수 유닛+모디파이어+해저드)을 쏟아 심사위원이
 * 첫 판에 급사하는 것을 방지 — 웨이브 번호에 비례해 적 수·모디파이어·해저드를 클램프.
 * (설계 의도는 유지하되 강도만 웨이브에 맞게 조인다.)
 */
function sanitize(d: WaveDesign, wave: number): WaveDesign {
  const threatBudget = Math.min(5 + (wave - 1) * 1.5, 18)
  const unitCap = 14
  const maxModsPerGroup = maxModsForWave(wave)
  const maxHazards = maxHazardsForWave(wave)
  const threatCost = { drone: 1, spitter: 1.25, brute: 2.5 } as const

  let remainingThreat = threatBudget
  let remainingUnits = unitCap
  const spawns: WaveDesign['spawns'] = []
  for (const spawn of d.spawns) {
    const requested = Math.max(0, Math.floor(spawn.count))
    if (requested === 0 || remainingUnits === 0) continue
    const modifiers = uniq(spawn.modifiers ?? []).slice(0, maxModsPerGroup)
    const costPerUnit = threatCost[spawn.type] + modifiers.length * 0.5
    const affordable = Math.floor((remainingThreat + Number.EPSILON) / costPerUnit)
    const count = Math.min(requested, remainingUnits, affordable)
    if (count <= 0) continue
    spawns.push({ type: spawn.type, count, modifiers })
    remainingThreat -= count * costPerUnit
    remainingUnits -= count
  }

  return {
    ...d,
    spawns,
    hazards: (d.hazards ?? []).slice(0, maxHazards),
    aggression: (wave <= 1 ? Math.min(d.aggression, 2) : d.aggression) as WaveDesign['aggression'],
  }
}

const uniq = (a: Modifier[]): Modifier[] => [...new Set(a)]

/** sanitize와 같은 웨이브별 상한 — 룰 보충이 상한에 잘려 '말만 하고 안 붙는' 것을 막기 위해 공유한다 */
const maxModsForWave = (wave: number): number => (wave <= 1 ? 0 : wave <= 3 ? 1 : 2)
const maxHazardsForWave = (wave: number): number => (wave <= 1 ? 0 : wave <= 3 ? 1 : 2)

/** 텔레메트리에서 읽어낸 '가장 뚜렷한 습관 하나' */
export type DominantHabit =
  | { kind: 'dodge'; side: 'left' | 'right'; pct: number }
  | { kind: 'melee'; pct: number }
  | { kind: 'kite'; pct: number }

/** 이 %p 미만의 편향은 습관으로 보지 않는다 (표본 잡음) */
export const HABIT_DEV_THRESHOLD = 12

const TYPE_KO: Record<string, string> = { drone: '드론', spitter: '스피터', brute: '브루트' }

/**
 * 지배 습관 판정. 웨이브 1은 데이터가 적어 관측만 하고 판정하지 않는다.
 * 편향이 임계 미만이면 null — 룰은 아예 개입하지 않는다.
 */
export function dominantHabit(digest: TelemetryDigest): DominantHabit | null {
  const wave = digest.wave + 1
  if (wave < 2) return null
  const dodgeDev = Math.abs(digest.dodgeLeftPct - 50)
  const weaponDev = Math.abs(digest.meleeUsePct - 50)
  if (dodgeDev < HABIT_DEV_THRESHOLD && weaponDev < HABIT_DEV_THRESHOLD) return null
  if (dodgeDev >= HABIT_DEV_THRESHOLD && dodgeDev >= weaponDev) {
    const left = digest.dodgeLeftPct > 50
    return { kind: 'dodge', side: left ? 'left' : 'right', pct: Math.max(digest.dodgeLeftPct, digest.dodgeRightPct) }
  }
  if (digest.meleeUsePct > 50) return { kind: 'melee', pct: digest.meleeUsePct }
  return { kind: 'kite', pct: digest.rangedUsePct }
}

/**
 * 설계가 이미 그 습관을 겨냥했는가 — 룰의 '거부권' 판정.
 * 겨냥했으면 룰은 손대지 않는다(LLM이 어떤 부품 조합으로 겨냥했든 존중).
 * 런타임에 실제로 발동하는 조합만 인정한다 — 예: shielded_front는 브루트에만 붙어야
 * 효과가 있다(enemies.ts 생성자가 그 외 타입에선 제거). 그래야 화면 문구가 거짓이 되지 않는다.
 */
export function addressesHabit(d: WaveDesign, habit: DominantHabit): boolean {
  const mods = new Set<Modifier>(d.spawns.flatMap((s) => s.modifiers ?? []))
  const hazards = d.hazards ?? []
  const hasUnits = d.spawns.some((s) => s.count > 0)
  switch (habit.kind) {
    case 'dodge': {
      // 회피 편향: 그쪽으로 스폰을 몰았거나 · 그쪽에 해저드를 깔았거나 · 회피 자체에 반응하는 mirror_dash
      const placement = habit.side === 'left' ? 'player_left' : 'player_right'
      return (
        (d.spawnBias === habit.side && hasUnits) ||
        hazards.some((h) => h.placement === placement) ||
        (mods.has('mirror_dash') && hasUnits)
      )
    }
    case 'melee':
      // 근접 집착: 정면 차단(브루트 한정) · 밀착 반격 가시 · 근접 처치 처벌 자폭
      return d.spawns.some(
        (s) =>
          s.count > 0 &&
          ((s.type === 'brute' && (s.modifiers ?? []).includes('shielded_front')) ||
            (s.modifiers ?? []).some((m) => m === 'thorns' || m === 'explode_on_death')),
      )
    case 'kite':
      // 거리 유지: 멀수록 가속하는 추격
      return d.spawns.some((s) => s.count > 0 && (s.modifiers ?? []).includes('enrage_far'))
  }
}

/** 상한을 지키면서 모디파이어를 붙인다 — 이미 상한이면 마지막 것을 밀어내 우리 것이 반드시 살아남게 한다 */
function attachModifier(group: { modifiers?: Modifier[] }, mod: Modifier, maxMods: number): boolean {
  if (maxMods <= 0) return false
  const mods = uniq(group.modifiers ?? [])
  if (mods.includes(mod)) return true
  if (mods.length >= maxMods) mods.splice(maxMods - 1)
  mods.push(mod)
  group.modifiers = mods
  return true
}

/**
 * 최소 개입 — 빗나간 설계에 '빠진 카운터 부품'만 보충한다.
 * 전면 재구성(적 타입 교체·해저드 전멸)은 하지 않는다. 실제로 보충한 내용을 note로 돌려주어
 * 화면 문구가 실제 구성과 어긋나지 않게 한다. 보충할 자리가 없으면 null(개입 없음).
 */
function patchMissingCounter(d: WaveDesign, habit: DominantHabit, wave: number): { design: WaveDesign; note: string } | null {
  const spawns = d.spawns.map((s) => ({ ...s, modifiers: [...(s.modifiers ?? [])] }))
  const maxMods = maxModsForWave(wave)
  const live = spawns.filter((s) => s.count > 0)

  if (habit.kind === 'dodge') {
    const placement = habit.side === 'left' ? 'player_left' : 'player_right'
    const opposite = habit.side === 'left' ? 'player_right' : 'player_left'
    // 반대쪽에 깔린 해저드만 정정하고 나머지 LLM 해저드는 그대로 둔다
    const hazards = (d.hazards ?? []).filter((h) => h.placement !== opposite)
    const added: string[] = []
    let bias = d.spawnBias
    if (bias !== habit.side && live.length) {
      bias = habit.side
      added.push('스폰을 그쪽으로')
    }
    if (!hazards.some((h) => h.placement === placement) && maxHazardsForWave(wave) > 0) {
      hazards.unshift({ type: 'spike_zone', placement })
      added.push('가시 봉쇄')
    }
    if (!added.length) return null
    return {
      design: { ...d, spawns, hazards, spawnBias: bias },
      note: `회피 ${habit.side === 'left' ? '왼쪽' : '오른쪽'} ${habit.pct}% — ${added.join('·')} 보강`,
    }
  }

  if (habit.kind === 'melee') {
    // 방패는 브루트에만 유효 — 브루트가 있으면 방패, 없으면 선두 그룹에 가시(타입은 바꾸지 않는다)
    const brute = live.find((s) => s.type === 'brute')
    if (brute && attachModifier(brute, 'shielded_front', maxMods)) {
      return { design: { ...d, spawns }, note: `근접 ${habit.pct}% — 브루트에 정면 방패 부착` }
    }
    const target = live[0]
    if (target && attachModifier(target, 'thorns', maxMods)) {
      return { design: { ...d, spawns }, note: `근접 ${habit.pct}% — ${TYPE_KO[target.type] ?? target.type}에 반격 가시 부착` }
    }
    return null
  }

  // 카이팅 — 드론이 있으면 드론 전체, 없으면 선두 그룹에 가속 추격
  const drones = live.filter((s) => s.type === 'drone')
  const targets = drones.length ? drones : live.slice(0, 1)
  let attached = false
  for (const t of targets) attached = attachModifier(t, 'enrage_far', maxMods) || attached
  if (!attached) return null
  return {
    design: { ...d, spawns },
    note: `거리 유지 ${habit.pct}% — ${drones.length ? '드론' : TYPE_KO[targets[0].type] ?? targets[0].type}에 가속 추격 부착`,
  }
}

/**
 * 설계 최종화 (LLM·폴백 공통).
 *
 * 과거엔 편향이 큰 순간마다 룰이 구성·해저드·화면 문구까지 전부 덮어써서, 플레이어가
 * 습관을 보일수록 오버마인드가 룰 템플릿 3~5개만 반복하는 '스크립트'가 됐다.
 * 지금은 거부권 모델이다 — LLM 설계가 지배 습관을 이미 겨냥했으면 그대로 통과시키고,
 * 빗나갔을 때만 빠진 부품을 보충한다. LLM의 counterReason은 절대 지우지 않고,
 * 룰이 실제로 손댔을 때만 그 사실을 짧게 덧붙인다(화면 문구 = 실제 구성).
 */
function finalizeDesign(raw: WaveDesign, digest: TelemetryDigest, origin: 'llm' | 'fallback'): WaveDesign {
  const wave = digest.wave + 1
  const baseSource: WaveDesign['source'] = origin === 'fallback' ? 'fallback' : 'llm'
  // 상한(적 수·모디파이어·해저드)을 먼저 적용해야, 이후 판정이 '실제로 나갈 구성'을 본다
  const clamped = sanitize(raw, wave)
  const habit = dominantHabit(digest)
  if (!habit || addressesHabit(clamped, habit)) return { ...clamped, source: baseSource }

  const patched = patchMissingCounter(clamped, habit, wave)
  if (!patched) return { ...clamped, source: baseSource }
  // 보충분을 포함해 난이도 상한을 다시 적용 (모디파이어 비용만큼 수량이 조정된다)
  const final = sanitize(patched.design, wave)
  // 보충이 상한에 잘려 살아남지 못했다면 개입 사실을 주장하지 않는다 (도구는 거짓말하지 않는다)
  if (!addressesHabit(final, habit)) return { ...final, source: baseSource }
  const llmReason = origin === 'llm' ? (raw.counterReason ?? '').trim() : ''
  return {
    ...final,
    source: origin === 'fallback' ? 'fallback' : 'llm+adjusted',
    counterReason: llmReason ? `${llmReason} (룰 보정: ${patched.note})` : patched.note,
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
  const dodgeRight = digest.dodgeRightPct > 60
  const dodgeSpike = wave >= 3 && (dodgeLeft || dodgeRight)
  const base: WaveDesign = {
    spawns,
    // 방향 가시는 회피 편향이 뚜렷할 때만 (중립인데 엉뚱한 방향에 가시 까는 것 방지)
    hazards: dodgeSpike ? [{ type: 'spike_zone', placement: dodgeLeft ? 'player_left' : 'player_right' }] : [],
    spawnBias: dodgeLeft ? 'left' : dodgeRight ? 'right' : 'surround',
    // 폴백 문구는 '실제로 한 것'만 말한다 — 회피 편향을 실제로 겨냥한 판에서만 그 문장을 쓴다
    counterReason:
      dodgeLeft || dodgeRight
        ? `회피 ${dodgeLeft ? '왼쪽' : '오른쪽'} ${dodgeLeft ? digest.dodgeLeftPct : digest.dodgeRightPct}% — 그쪽으로 몰아붙인다${dodgeSpike ? ' + 가시 봉쇄' : ''}`
        : melee
          ? '근접 위주 전투 감지 — 원거리 유닛으로 거리를 벌린다'
          : '원거리 위주 전투 감지 — 돌격 유닛으로 압박한다',
    taunt: TAUNT_POOL[wave % TAUNT_POOL.length],
    profileUpdate: '', // 폴백은 기억을 갱신하지 않음 (기존 프로파일 유지)
    mood: digest.playerHpPct < 35 ? 'confident' : 'angry',
    aggression: Math.min(5, 3 + Math.floor(wave / 2)) as WaveDesign['aggression'], // 공격성 상향
  }
  // 폴백도 LLM 경로와 동일하게 상한(적 수·모디파이어) → 거부권 레이어를 거친다.
  // 폴백엔 LLM 문장이 없으므로 룰이 보충하면 문구도 룰 것으로 대체된다(거짓말 없음).
  return finalizeDesign(base, digest, 'fallback')
}

const TAUNT_POOL = [
  '패턴 분석 완료. 다음 수는 이미 정해져 있다.',
  '너의 습관이 너를 배신할 것이다.',
  '흥미롭군. 하지만 예측 가능해.',
  '재구성한다. 이번엔 다를 것이다.',
  '네 움직임은 전부 기록되고 있다.',
]
