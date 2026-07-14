import * as THREE from 'three'
import { ARENA_RADIUS, ENEMY_TYPES, type EnemyType } from './config'
import type { Player } from './player'
import type { ProjectilePool } from './projectiles'
import type { Directive } from '../ai/schema'

const _toPlayer = new THREE.Vector3()
const _steer = new THREE.Vector3()
const _side = new THREE.Vector3()

type ActionName = 'chase' | 'strafe' | 'attack' | 'keepDistance'

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
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.5 }))
    this.mesh.position.copy(this.pos).setY(0.9)
    this.mesh.castShadow = true
    scene.add(this.mesh)
  }

  update(dt: number, player: Player, projectiles: ProjectilePool): void {
    if (this.dead) return
    const spec = ENEMY_TYPES[this.type]
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)

    // 100~300ms 주기로만 행동 재평가 (L1 틱)
    this.thinkTimer -= dt
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.1 + Math.random() * 0.2
      this.action = this.chooseAction(player)
    }

    _toPlayer.copy(player.pos).sub(this.pos)
    _toPlayer.y = 0
    const dist = _toPlayer.length()
    if (dist > 0.001) _toPlayer.normalize()

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
        this.tryAttack(dist, player, projectiles, spec)
        break
    }

    if (_steer.lengthSq() > 0) {
      this.pos.addScaledVector(_steer.normalize(), spec.speed * dt)
      const r = this.pos.length()
      if (r > ARENA_RADIUS - spec.radius) this.pos.multiplyScalar((ARENA_RADIUS - spec.radius) / r)
    }

    this.mesh.position.copy(this.pos).setY(this.type === 'brute' ? 0.9 : 0.9)
    this.mesh.rotation.y += dt * 1.5
  }

  /** 유틸리티 점수 — 각 행동의 매력을 상황 함수로 계산 */
  private chooseAction(player: Player): ActionName {
    const spec = ENEMY_TYPES[this.type]
    const dist = this.pos.distanceTo(player.pos)
    const aggro = this.aggression / 3 // 1.0 = 기본

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

  private tryAttack(
    dist: number,
    player: Player,
    projectiles: ProjectilePool,
    spec: (typeof ENEMY_TYPES)[EnemyType],
  ): void {
    if (this.attackCooldown > 0 || dist > spec.attackRange) return
    this.attackCooldown = spec.attackCooldown
    if (this.type === 'spitter') {
      projectiles.spawn(this.pos, _toPlayer, ENEMY_TYPES.spitter.projectileSpeed, spec.damage, false)
    } else {
      player.takeDamage(spec.damage)
    }
  }

  takeDamage(amount: number): void {
    this.hp -= amount
    if (this.hp <= 0) this.dead = true
    else {
      const mat = this.mesh.material as THREE.MeshStandardMaterial
      mat.emissive.setHex(0xffffff)
      setTimeout(() => mat.emissive.setHex(0x000000), 60)
    }
  }

  applyDirective(directive: Directive): void {
    this.aggression = directive.aggression
  }
}
