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

  /**
   * 매 프레임 호출 — 위치 + 이동 방향을 상시 샘플링.
   * 회피 성향 = '가장 가까운 위협을 두고 어느 쪽으로 도는가'(스트레이프 방향).
   * 조준(facing)이 아니라 위협 방향 기준이라 자동조준·마우스 무관하게 안정적.
   * (기존 버그: 대시할 때만·조준 기준으로 기록 → 영원히 50:50)
   */
  tick(dt: number, playerPos: THREE.Vector3, moveDir: THREE.Vector3, threatDir: THREE.Vector3): void {
    this.now += dt
    this.distSum += playerPos.length()
    this.distSamples++
    if (moveDir.lengthSq() > 0.01 && threatDir.lengthSq() > 0.01) {
      // 위협 기준 이동의 좌/우 성분 (cross>0 = 위협의 왼쪽으로 회전). 프레임 시간 가중.
      const cross = threatDir.x * moveDir.z - threatDir.z * moveDir.x
      if (cross > 0.1) this.dodgeLeft += dt
      else if (cross < -0.1) this.dodgeRight += dt
    }
  }

  /** 대시는 의도적 회피 신호 — 강하게 가중 (0.5초치 이동에 해당) */
  recordDash(dir: THREE.Vector3, threatDir: THREE.Vector3): void {
    if (threatDir.lengthSq() < 0.01) return
    const cross = threatDir.x * dir.z - threatDir.z * dir.x
    if (cross > 0.1) this.dodgeLeft += 0.5
    else if (cross < -0.1) this.dodgeRight += 0.5
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
    // 최소 표본(누적 1초) 미만이면 아직 판단 보류 → 50:50
    const enough = dodges >= 1
    return {
      wave,
      playerHpPct: Math.round(playerHpPct),
      dodgeLeftPct: enough ? Math.round((this.dodgeLeft / dodges) * 100) : 50,
      dodgeRightPct: enough ? Math.round((this.dodgeRight / dodges) * 100) : 50,
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

  /** 검증용 — 현재 좌/우 회피 성향 스냅샷 */
  debugDodge(): { left: number; right: number } {
    const d = this.dodgeLeft + this.dodgeRight
    return d >= 1
      ? { left: Math.round((this.dodgeLeft / d) * 100), right: Math.round((this.dodgeRight / d) * 100) }
      : { left: 50, right: 50 }
  }

  /** 웨이브 단위 통계 초기화 (누적 편향은 유지) */
  resetWaveStats(): void {
    this.damageTaken = 0
    this.kills = {}
  }
}
