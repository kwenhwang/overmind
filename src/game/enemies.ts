import * as THREE from 'three'
import { ARENA_RADIUS, ENEMY_TYPES, type EnemyType } from './config'
import { events } from './events'
import type { Player } from './player'
import type { ProjectilePool } from './projectiles'
import type { Directive } from '../ai/schema'

const _toPlayer = new THREE.Vector3()
const _steer = new THREE.Vector3()
const _side = new THREE.Vector3()

type ActionName = 'chase' | 'strafe' | 'attack' | 'keepDistance'
/** 공격 연출 단계 — 모든 피해는 예고(windup) 후에만 발생 (읽고 피할 수 있는 전투) */
type AttackPhase = 'none' | 'windup' | 'lunge'

/**
 * L1 전술 계층: 유틸리티 점수로 행동 선택.
 * L2(LLM) 디렉티브는 여기의 가중치·성향을 바꾸는 데이터일 뿐, 프레임 제어는 하지 않는다.
 */
export class Enemy {
  mesh: THREE.Mesh
  pos: THREE.Vector3
  hp: number
  dead = false
  private attackCooldown = 0
  private action: ActionName = 'chase'
  private thinkTimer = 0
  private strafeSign = Math.random() < 0.5 ? -1 : 1
  private knockback = new THREE.Vector3()
  private phase: AttackPhase = 'none'
  private phaseTimer = 0
  private lungeDir = new THREE.Vector3()
  private lungeHit = false
  private baseEmissive: number
  /** L2 디렉티브가 조정하는 공격성 (1~5) */
  aggression = 3

  constructor(
    public type: EnemyType,
    spawnPos: THREE.Vector3,
    scene: THREE.Scene,
  ) {
    const spec = ENEMY_TYPES[type]
    this.hp = spec.hp
    this.pos = spawnPos.clone()
    const geo =
      type === 'brute'
        ? new THREE.BoxGeometry(spec.radius * 1.8, 1.8, spec.radius * 1.8)
        : new THREE.OctahedronGeometry(spec.radius * 1.15)
    this.baseEmissive = 0.45
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: spec.color,
        roughness: 0.35,
        metalness: 0.3,
        emissive: spec.color,
        emissiveIntensity: this.baseEmissive,
      }),
    )
    this.mesh.position.copy(this.pos).setY(0.9)
    this.mesh.castShadow = true
    scene.add(this.mesh)
  }

  get color(): number {
    return ENEMY_TYPES[this.type].color
  }

  update(dt: number, player: Player, projectiles: ProjectilePool): void {
    if (this.dead) return
    const spec = ENEMY_TYPES[this.type]
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)

    _toPlayer.copy(player.pos).sub(this.pos)
    _toPlayer.y = 0
    const dist = _toPlayer.length()
    if (dist > 0.001) _toPlayer.normalize()

    // 넉백은 조종 불가 관성 — 어떤 단계에서도 적용
    if (this.knockback.lengthSq() > 0.01) {
      this.pos.addScaledVector(this.knockback, dt)
      this.knockback.multiplyScalar(Math.max(0, 1 - dt * 7))
    }

    // ── 공격 연출 단계가 조종권을 가짐 ──
    if (this.phase === 'windup') {
      this.updateWindup(dt, player, projectiles, dist)
      this.applyDisplay(dt)
      return
    }
    if (this.phase === 'lunge') {
      this.updateLunge(dt, player, spec)
      this.applyDisplay(dt)
      return
    }

    // ── 평시: L1 유틸리티 (100~300ms 틱) ──
    this.thinkTimer -= dt
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.1 + Math.random() * 0.2
      this.action = this.chooseAction(player, dist)
    }

    _steer.set(0, 0, 0)
    switch (this.action) {
      case 'chase':
        _steer.copy(_toPlayer)
        break
      case 'strafe':
        _side.set(-_toPlayer.z, 0, _toPlayer.x).multiplyScalar(this.strafeSign)
        _steer.copy(_side).addScaledVector(_toPlayer, 0.25)
        break
      case 'keepDistance': {
        const preferred = 'preferredRange' in spec ? spec.preferredRange : 6
        _steer.copy(_toPlayer).multiplyScalar(dist > preferred ? 1 : -1)
        break
      }
      case 'attack':
        this.beginAttack(dist, spec)
        break
    }

    if (_steer.lengthSq() > 0) {
      this.pos.addScaledVector(_steer.normalize(), spec.speed * dt)
    }
    this.applyDisplay(dt)
  }

  /** 공격 개시 = 예고 단계 진입 (즉발 피해 없음) */
  private beginAttack(dist: number, spec: (typeof ENEMY_TYPES)[EnemyType]): void {
    if (this.attackCooldown > 0 || dist > spec.attackRange) return
    this.attackCooldown = spec.attackCooldown
    this.phase = 'windup'
    this.phaseTimer = this.type === 'drone' ? ENEMY_TYPES.drone.windup : 0.4
    if (this.type === 'drone') events.emit('lungeWarn', { pos: this.pos })
  }

  private updateWindup(
    dt: number,
    player: Player,
    projectiles: ProjectilePool,
    dist: number,
  ): void {
    this.phaseTimer -= dt
    // 예고 연출: 밝아지며 수축
    const mat = this.mesh.material as THREE.MeshStandardMaterial
    mat.emissiveIntensity = this.baseEmissive + (1 - Math.max(0, this.phaseTimer) / 0.45) * 2.2
    if (this.phaseTimer > 0) return

    mat.emissiveIntensity = this.baseEmissive
    if (this.type === 'drone') {
      this.phase = 'lunge'
      this.phaseTimer = ENEMY_TYPES.drone.lungeDuration
      this.lungeDir.copy(player.pos).sub(this.pos).setY(0).normalize()
      this.lungeHit = false
    } else if (this.type === 'spitter') {
      this.phase = 'none'
      events.emit('spitterShot', { pos: this.pos })
      projectiles.spawn(
        this.pos,
        _toPlayer.copy(player.pos).sub(this.pos).setY(0).normalize(),
        ENEMY_TYPES.spitter.projectileSpeed,
        ENEMY_TYPES.spitter.damage,
        false,
      )
    } else {
      // brute: 예고 후 아직 근접해 있으면 강타
      this.phase = 'none'
      if (dist <= ENEMY_TYPES.brute.attackRange * 1.25) player.takeDamage(ENEMY_TYPES.brute.damage)
    }
  }

  private updateLunge(dt: number, player: Player, spec: (typeof ENEMY_TYPES)[EnemyType]): void {
    this.phaseTimer -= dt
    this.pos.addScaledVector(this.lungeDir, ENEMY_TYPES.drone.lungeSpeed * dt)
    // 돌진 중 접촉 시에만 피해 (1회)
    if (!this.lungeHit && this.pos.distanceTo(player.pos) < spec.radius + 0.7) {
      this.lungeHit = true
      player.takeDamage(spec.damage)
    }
    if (this.phaseTimer <= 0) this.phase = 'none'
  }

  private applyDisplay(dt: number): void {
    const spec = ENEMY_TYPES[this.type]
    const r = this.pos.length()
    if (r > ARENA_RADIUS - spec.radius) this.pos.multiplyScalar((ARENA_RADIUS - spec.radius) / r)
    this.mesh.position.copy(this.pos).setY(0.9)
    this.mesh.rotation.y += dt * (this.phase === 'windup' ? 6 : 1.5)
  }

  /** 유틸리티 점수 — 각 행동의 매력을 상황 함수로 계산 */
  private chooseAction(player: Player, dist: number): ActionName {
    const spec = ENEMY_TYPES[this.type]
    const aggro = this.aggression / 3 // 1.0 = 기본
    void player

    const scores: Record<ActionName, number> = {
      chase: dist > spec.attackRange ? 0.6 * aggro : 0.1,
      attack: dist <= spec.attackRange && this.attackCooldown <= 0 ? 1.0 * aggro : 0,
      strafe: dist < spec.attackRange * 2.5 ? 0.35 / aggro : 0.1,
      keepDistance: 0,
    }
    if (this.type === 'spitter') {
      scores.keepDistance = 0.7
      scores.chase = dist > spec.attackRange ? 0.8 : 0.05
      scores.attack = dist <= spec.attackRange && this.attackCooldown <= 0 ? 1.2 * aggro : 0
    }

    let best: ActionName = 'chase'
    let bestScore = -1
    for (const [name, score] of Object.entries(scores) as [ActionName, number][]) {
      if (score > bestScore) {
        best = name
        bestScore = score
      }
    }
    return best
  }

  takeDamage(amount: number, knockDir?: THREE.Vector3, knockForce = 0): void {
    this.hp -= amount
    if (knockDir && knockForce > 0) this.knockback.addScaledVector(knockDir, knockForce)
    if (this.hp <= 0) this.dead = true
    else {
      const mat = this.mesh.material as THREE.MeshStandardMaterial
      mat.emissive.setHex(0xffffff)
      setTimeout(() => {
        if (!this.dead) mat.emissive.setHex(ENEMY_TYPES[this.type].color)
      }, 60)
    }
  }

  applyDirective(directive: Directive): void {
    this.aggression = directive.aggression
  }
}
