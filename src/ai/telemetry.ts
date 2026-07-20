import * as THREE from 'three'
import { ARENA_RADIUS, type EnemyType } from '../game/config'
import type {
  AnomalyEvaluation,
  BehaviorEvidence,
  BehaviorTarget,
  PredictionContract,
  TelemetryDigest,
} from './schema'

type DamageKind = 'melee' | 'ranged'

interface Stats {
  dodgeLeft: number
  dodgeRight: number
  meleeDamage: number
  rangedDamage: number
  damageTaken: number
  kills: Partial<Record<EnemyType, number>>
  distWeightedSum: number
  positionSeconds: number
  centerSeconds: number
  edgeSeconds: number
  elapsed: number
}

const emptyStats = (): Stats => ({
  dodgeLeft: 0,
  dodgeRight: 0,
  meleeDamage: 0,
  rangedDamage: 0,
  damageTaken: 0,
  kills: {},
  distWeightedSum: 0,
  positionSeconds: 0,
  centerSeconds: 0,
  edgeSeconds: 0,
  elapsed: 0,
})

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const share = (part: number, total: number): number => (total > 0 ? part / total : 0.5)

export const PREDICTION_THRESHOLDS = {
  minDeviation: 0.12,
  dodgeSeconds: 2.5,
  weaponDamage: 80,
  zoneSeconds: 5,
  breakTargetShare: 0.4,
  centerBreakDistance: 0.55,
  edgeBreakDistance: 0.45,
} as const

interface Candidate {
  target: BehaviorTarget
  observedShare: number
  deviation: number
}

/** 충분한 표본 중 50:50에서 가장 멀리 벗어난 습관 하나를 다음 웨이브 예측으로 고정한다. */
export function buildPredictionContract(sourceWave: number, evidence: BehaviorEvidence): PredictionContract | null {
  const candidates: Candidate[] = []
  let hasSufficientEvidence = false

  const dodgeTotal = evidence.dodgeLeftSeconds + evidence.dodgeRightSeconds
  if (dodgeTotal >= PREDICTION_THRESHOLDS.dodgeSeconds) {
    hasSufficientEvidence = true
    const leftShare = share(evidence.dodgeLeftSeconds, dodgeTotal)
    candidates.push({
      target: leftShare >= 0.5 ? 'dodge_left' : 'dodge_right',
      observedShare: Math.max(leftShare, 1 - leftShare),
      deviation: Math.abs(leftShare - 0.5),
    })
  }

  const weaponTotal = evidence.meleeDamage + evidence.rangedDamage
  if (weaponTotal >= PREDICTION_THRESHOLDS.weaponDamage) {
    hasSufficientEvidence = true
    const meleeShare = share(evidence.meleeDamage, weaponTotal)
    candidates.push({
      target: meleeShare >= 0.5 ? 'melee' : 'ranged',
      observedShare: Math.max(meleeShare, 1 - meleeShare),
      deviation: Math.abs(meleeShare - 0.5),
    })
  }

  const zoneTotal = evidence.centerSeconds + evidence.edgeSeconds
  if (zoneTotal >= PREDICTION_THRESHOLDS.zoneSeconds) {
    hasSufficientEvidence = true
    const centerShare = share(evidence.centerSeconds, zoneTotal)
    candidates.push({
      target: centerShare >= 0.5 ? 'center' : 'edge',
      observedShare: Math.max(centerShare, 1 - centerShare),
      deviation: Math.abs(centerShare - 0.5),
    })
  }

  if (!hasSufficientEvidence) return null
  const dominant = candidates.reduce<Candidate | null>(
    (best, candidate) => (!best || candidate.deviation > best.deviation ? candidate : best),
    null,
  )
  if (!dominant || dominant.deviation < PREDICTION_THRESHOLDS.minDeviation - 1e-9) {
    return { target: 'unreadable', observedPct: 50, sourceWave }
  }
  return {
    target: dominant.target,
    observedPct: Math.round(dominant.observedShare * 100),
    sourceWave,
  }
}

/** 공개된 예측의 대상 행동을 충분한 근거와 함께 반대로 바꾸었는지 판정한다. */
export function evaluatePrediction(
  contract: PredictionContract | null,
  evidence: BehaviorEvidence,
): AnomalyEvaluation | null {
  if (!contract) return null
  if (contract.target === 'unreadable') {
    return {
      status: 'unreadable',
      target: contract.target,
      targetPct: 50,
      progress: 1,
      sufficientEvidence: true,
    }
  }

  let sufficientEvidence = false
  let targetShare = 1
  let breakShare: number = PREDICTION_THRESHOLDS.breakTargetShare
  let evidenceProgress = 0
  let broken = false

  if (contract.target === 'dodge_left' || contract.target === 'dodge_right') {
    const total = evidence.dodgeLeftSeconds + evidence.dodgeRightSeconds
    sufficientEvidence = total >= PREDICTION_THRESHOLDS.dodgeSeconds
    evidenceProgress = clamp(total / PREDICTION_THRESHOLDS.dodgeSeconds, 0, 1)
    targetShare = share(
      contract.target === 'dodge_left' ? evidence.dodgeLeftSeconds : evidence.dodgeRightSeconds,
      total,
    )
    broken = sufficientEvidence && targetShare <= PREDICTION_THRESHOLDS.breakTargetShare
  } else if (contract.target === 'melee' || contract.target === 'ranged') {
    const total = evidence.meleeDamage + evidence.rangedDamage
    sufficientEvidence = total >= PREDICTION_THRESHOLDS.weaponDamage
    evidenceProgress = clamp(total / PREDICTION_THRESHOLDS.weaponDamage, 0, 1)
    targetShare = share(contract.target === 'melee' ? evidence.meleeDamage : evidence.rangedDamage, total)
    broken = sufficientEvidence && targetShare <= PREDICTION_THRESHOLDS.breakTargetShare
  } else {
    const total = evidence.centerSeconds + evidence.edgeSeconds
    sufficientEvidence = total >= PREDICTION_THRESHOLDS.zoneSeconds
    evidenceProgress = clamp(total / PREDICTION_THRESHOLDS.zoneSeconds, 0, 1)
    const avgDistance = clamp(evidence.avgDistToCenter, 0, 1)
    targetShare = contract.target === 'center' ? 1 - avgDistance : avgDistance
    breakShare =
      contract.target === 'center'
        ? 1 - PREDICTION_THRESHOLDS.centerBreakDistance
        : PREDICTION_THRESHOLDS.edgeBreakDistance
    broken =
      sufficientEvidence &&
      (contract.target === 'center'
        ? avgDistance >= PREDICTION_THRESHOLDS.centerBreakDistance
        : avgDistance <= PREDICTION_THRESHOLDS.edgeBreakDistance)
  }

  return {
    status: !sufficientEvidence ? 'insufficient' : broken ? 'broken' : 'tracking',
    target: contract.target,
    targetPct: Math.round(targetShare * 100),
    progress: broken ? 1 : clamp((1 - targetShare) / (1 - breakShare), 0, 1) * evidenceProgress,
    sufficientEvidence,
  }
}

/**
 * 플레이어 행동 관찰기 — 오버마인드의 "눈".
 * 게임 코드가 이벤트를 밀어넣고, 웨이브가 끝나면 digest()로 요약을 뽑아 L2에 보낸다.
 */
export class Telemetry {
  private wave = emptyStats()
  private run = emptyStats()
  private active = false

  /**
   * 매 프레임 호출 — 위치 + 이동 방향 샘플링.
   * 회피 성향 = 화면 기준 좌/우 (카메라가 고정 탑다운이라 월드 -X = 화면 왼쪽 = A키).
   * 플레이어 체감("왼쪽으로 피했다")과 측정을 일치시킴 — 위협 상대 기준은 체감과 어긋났음.
   */
  tick(dt: number, playerPos: THREE.Vector3, moveDir: THREE.Vector3): void {
    if (!this.active || !Number.isFinite(dt) || dt <= 0) return
    const normalizedDistance = clamp(playerPos.length() / ARENA_RADIUS, 0, 1)
    for (const stats of [this.wave, this.run]) {
      stats.elapsed += dt
      stats.distWeightedSum += normalizedDistance * dt
      stats.positionSeconds += dt
      if (normalizedDistance <= 0.5) stats.centerSeconds += dt
      else stats.edgeSeconds += dt
      if (moveDir.x < -0.1) stats.dodgeLeft += dt
      else if (moveDir.x > 0.1) stats.dodgeRight += dt
    }
  }

  /** 대시는 의도적 회피 신호 — 강하게 가중 (0.5초치 이동에 해당) */
  recordDash(dir: THREE.Vector3): void {
    if (!this.active) return
    for (const stats of [this.wave, this.run]) {
      if (dir.x < -0.1) stats.dodgeLeft += 0.5
      else if (dir.x > 0.1) stats.dodgeRight += 0.5
    }
  }

  /** @deprecated 공격 요청 횟수는 성향 계산에 사용하지 않는다. 실제 적중 피해를 기록하라. */
  recordMelee(): void {
    // 호출 호환성만 유지한다.
  }
  /** @deprecated 공격 요청 횟수는 성향 계산에 사용하지 않는다. 실제 적중 피해를 기록하라. */
  recordRanged(): void {
    // 호출 호환성만 유지한다.
  }
  recordDamageDealt(kind: DamageKind, amount: number): void {
    if (!this.active || !Number.isFinite(amount) || amount <= 0) return
    for (const stats of [this.wave, this.run]) {
      if (kind === 'melee') stats.meleeDamage += amount
      else stats.rangedDamage += amount
    }
  }
  recordDamageTaken(amount: number): void {
    if (!this.active || !Number.isFinite(amount) || amount <= 0) return
    for (const stats of [this.wave, this.run]) stats.damageTaken += amount
  }
  recordKill(type: EnemyType): void {
    if (!this.active) return
    for (const stats of [this.wave, this.run]) stats.kills[type] = (stats.kills[type] ?? 0) + 1
  }

  startWave(): void {
    this.wave = emptyStats()
    this.active = true
  }

  endWave(): void {
    this.active = false
  }

  private makeDigest(stats: Stats, wave: number, playerHpPct: number): TelemetryDigest {
    const dodges = stats.dodgeLeft + stats.dodgeRight
    const damageDealt = stats.meleeDamage + stats.rangedDamage
    return {
      wave,
      playerHpPct: Math.round(clamp(playerHpPct, 0, 100)),
      dodgeLeftPct: dodges >= 1 ? Math.round(share(stats.dodgeLeft, dodges) * 100) : 50,
      dodgeRightPct: dodges >= 1 ? Math.round(share(stats.dodgeRight, dodges) * 100) : 50,
      meleeUsePct: damageDealt > 0 ? Math.round(share(stats.meleeDamage, damageDealt) * 100) : 50,
      rangedUsePct: damageDealt > 0 ? Math.round(share(stats.rangedDamage, damageDealt) * 100) : 50,
      avgDistToCenter: stats.positionSeconds
        ? Math.round((stats.distWeightedSum / stats.positionSeconds) * 100) / 100
        : 0.5,
      damageTakenThisWave: Math.round(stats.damageTaken),
      killsByType: { ...stats.kills },
      waveClearSeconds: Math.round(stats.elapsed),
    }
  }

  waveDigest(wave: number, playerHpPct: number): TelemetryDigest {
    return this.makeDigest(this.wave, wave, playerHpPct)
  }

  runDigest(wave: number, playerHpPct: number): TelemetryDigest {
    return this.makeDigest(this.run, wave, playerHpPct)
  }

  /** @deprecated waveDigest를 사용한다. */
  digest(wave: number, playerHpPct: number): TelemetryDigest {
    return this.waveDigest(wave, playerHpPct)
  }

  currentEvidence(): BehaviorEvidence {
    return {
      dodgeLeftSeconds: this.wave.dodgeLeft,
      dodgeRightSeconds: this.wave.dodgeRight,
      meleeDamage: this.wave.meleeDamage,
      rangedDamage: this.wave.rangedDamage,
      centerSeconds: this.wave.centerSeconds,
      edgeSeconds: this.wave.edgeSeconds,
      avgDistToCenter: this.wave.positionSeconds
        ? clamp(this.wave.distWeightedSum / this.wave.positionSeconds, 0, 1)
        : 0.5,
    }
  }

  /** 검증용 — 현재 좌/우 회피 성향 스냅샷 */
  debugDodge(): { left: number; right: number } {
    const d = this.wave.dodgeLeft + this.wave.dodgeRight
    return d >= 1
      ? { left: Math.round((this.wave.dodgeLeft / d) * 100), right: Math.round((this.wave.dodgeRight / d) * 100) }
      : { left: 50, right: 50 }
  }

  /** 웨이브 단위 통계만 초기화하며 run 누적은 유지한다. */
  resetWaveStats(): void {
    this.wave = emptyStats()
    this.active = false
  }
}
