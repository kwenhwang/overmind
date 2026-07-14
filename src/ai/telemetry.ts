import * as THREE from 'three'
import { ARENA_RADIUS, type EnemyType } from '../game/config'
import type { TelemetryDigest } from './schema'

/**
 * 플레이어 행동 관찰기 — 오버마인드의 "눈".
 * 게임 코드가 이벤트를 밀어넣고, 웨이브가 끝나면 digest()로 요약을 뽑아 L2에 보낸다.
 */
export class Telemetry {
  private dodgeLeft = 0
  private dodgeRight = 0
  private meleeCount = 0
  private rangedCount = 0
  private damageTaken = 0
  private kills: Partial<Record<EnemyType, number>> = {}
  private distSamples = 0
  private distSum = 0
  private waveStartTime = 0
  private now = 0

  tick(dt: number, playerPos: THREE.Vector3): void {
    this.now += dt
    this.distSum += playerPos.length()
    this.distSamples++
  }

  /** 대시 방향을 시선 기준 좌/우로 분류 — "넌 항상 왼쪽으로 구르더군"의 근거 */
  recordDash(dir: THREE.Vector3, facing: THREE.Vector3): void {
    const cross = facing.x * dir.z - facing.z * dir.x
    if (cross > 0.15) this.dodgeLeft++
    else if (cross < -0.15) this.dodgeRight++
  }

  recordMelee(): void {
    this.meleeCount++
  }
  recordRanged(): void {
    this.rangedCount++
  }
  recordDamageTaken(amount: number): void {
    this.damageTaken += amount
  }
  recordKill(type: EnemyType): void {
    this.kills[type] = (this.kills[type] ?? 0) + 1
  }

  startWave(): void {
    this.waveStartTime = this.now
  }

  digest(wave: number, playerHpPct: number): TelemetryDigest {
    const dodges = this.dodgeLeft + this.dodgeRight
    const attacks = this.meleeCount + this.rangedCount
    return {
      wave,
      playerHpPct: Math.round(playerHpPct),
      dodgeLeftPct: dodges ? Math.round((this.dodgeLeft / dodges) * 100) : 50,
      dodgeRightPct: dodges ? Math.round((this.dodgeRight / dodges) * 100) : 50,
      meleeUsePct: attacks ? Math.round((this.meleeCount / attacks) * 100) : 50,
      rangedUsePct: attacks ? Math.round((this.rangedCount / attacks) * 100) : 50,
      avgDistToCenter: this.distSamples
        ? Math.round(((this.distSum / this.distSamples) / ARENA_RADIUS) * 100) / 100
        : 0.5,
      damageTakenThisWave: Math.round(this.damageTaken),
      killsByType: { ...this.kills },
      waveClearSeconds: Math.round(this.now - this.waveStartTime),
    }
  }

  /** 웨이브 단위 통계 초기화 (누적 편향은 유지) */
  resetWaveStats(): void {
    this.damageTaken = 0
    this.kills = {}
  }
}
