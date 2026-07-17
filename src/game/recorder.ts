import * as THREE from 'three'
import { ARENA_RADIUS, PLAYER, type EnemyType } from './config'
import type { Player } from './player'
import type { Enemy } from './enemies'

/**
 * 게임플레이 로거 — 강화학습(RL) 데이터셋 + 플레이 분석용.
 * ?rl 모드에서만 활성(오버헤드 0). 매 틱 (관측 obs, 행동 action, 보상 reward)을 기록하고
 * 에피소드(판) 종료 시 서버(/rl)로 업로드한다.
 *
 * 설계:
 * - obs: 고정 스키마의 정규화 상태 (플레이어 + 최근접 적 K개 + 웨이브). RL env observation.
 * - action: 사람 입력 (모방학습) — 이동/대시/사격/근접/조준.
 * - reward: 이 틱의 델타 (처치 +, 피해 -, 생존 +ε, 클리어/승리 +, 사망 -).
 * 지금은 사람 플레이 기록이지만, 동일 obs/action/reward 정의 위에 나중에 정책(policy)을
 * 얹으면 그대로 학습 환경이 된다.
 */

const K_ENEMIES = 8 // obs에 담을 최근접 적 수
const ENEMY_TYPE_IDX: Record<EnemyType, number> = { drone: 0, spitter: 1, brute: 2 }
const TICK_HZ = 20 // 기록 주기 (60fps 중 20Hz로 다운샘플 — RL엔 충분, 용량 절감)

export interface RLStep {
  t: number
  obs: number[]
  action: number[]
  reward: number
}

const _v = new THREE.Vector3()

export class Recorder {
  private steps: RLStep[] = []
  private accum = 0
  private tickEvery = 1 / TICK_HZ
  private pendingReward = 0
  private t = 0
  private startedAt: string

  constructor() {
    this.startedAt = new Date().toISOString()
  }

  /** 이벤트 보상 누적 (Game이 처치·피격·클리어 시점에 호출) */
  addReward(r: number): void {
    this.pendingReward += r
  }

  /** 매 프레임 호출. 20Hz로 다운샘플해 스텝 기록 */
  tick(
    dt: number,
    player: Player,
    enemies: Enemy[],
    bossPos: THREE.Vector3 | null,
    wave: number,
    action: { move: THREE.Vector3; dash: boolean; fire: boolean; melee: boolean; aim: THREE.Vector3 },
  ): void {
    this.t += dt
    this.pendingReward += 0.001 // 생존 보상
    this.accum += dt
    if (this.accum < this.tickEvery) return
    this.accum = 0

    this.steps.push({
      t: Math.round(this.t * 1000) / 1000,
      obs: this.buildObs(player, enemies, bossPos, wave),
      action: [
        action.move.x, action.move.z,
        action.dash ? 1 : 0, action.fire ? 1 : 0, action.melee ? 1 : 0,
        action.aim.x, action.aim.z,
      ].map((n) => Math.round(n * 1000) / 1000),
      reward: Math.round(this.pendingReward * 1000) / 1000,
    })
    this.pendingReward = 0
  }

  /** 관측 벡터 — 플레이어 상태 + 최근접 적 K개(상대 좌표·타입 원핫·hp) + 보스 + 웨이브 */
  private buildObs(player: Player, enemies: Enemy[], bossPos: THREE.Vector3 | null, wave: number): number[] {
    const o: number[] = [
      player.pos.x / ARENA_RADIUS,
      player.pos.z / ARENA_RADIUS,
      player.hp / PLAYER.hp,
      player.facing.x,
      player.facing.z,
      player.isDashing ? 1 : 0,
      wave / 5,
    ]
    // 최근접 K개 적: [상대x, 상대z, drone?, spitter?, brute?, hp정규화]
    const sorted = [...enemies]
      .sort((a, b) => a.pos.distanceToSquared(player.pos) - b.pos.distanceToSquared(player.pos))
      .slice(0, K_ENEMIES)
    for (let i = 0; i < K_ENEMIES; i++) {
      const e = sorted[i]
      if (e) {
        _v.copy(e.pos).sub(player.pos)
        o.push(_v.x / ARENA_RADIUS, _v.z / ARENA_RADIUS)
        o.push(ENEMY_TYPE_IDX[e.type] === 0 ? 1 : 0, ENEMY_TYPE_IDX[e.type] === 1 ? 1 : 0, ENEMY_TYPE_IDX[e.type] === 2 ? 1 : 0)
        o.push(1) // 살아있음(hp 상세는 생략, 존재 플래그)
      } else {
        o.push(0, 0, 0, 0, 0, 0) // 패딩 (고정 크기 유지 — RL 입력 일관성)
      }
    }
    // 보스 상대 좌표 (없으면 0)
    if (bossPos) {
      _v.copy(bossPos).sub(player.pos)
      o.push(_v.x / ARENA_RADIUS, _v.z / ARENA_RADIUS, 1)
    } else {
      o.push(0, 0, 0)
    }
    return o.map((n) => Math.round(n * 1000) / 1000)
  }

  /** 에피소드 종료 — 기록을 반환 (Game이 업로드) */
  finish(outcome: 'victory' | 'died', wave: number, score: number): object {
    return {
      startedAt: this.startedAt,
      outcome,
      wave,
      score,
      tickHz: TICK_HZ,
      obsSchema: 'player(7)+enemies(8x6)+boss(3)',
      actionSchema: 'moveX,moveZ,dash,fire,melee,aimX,aimZ',
      steps: this.steps,
    }
  }

  get length(): number {
    return this.steps.length
  }
}
