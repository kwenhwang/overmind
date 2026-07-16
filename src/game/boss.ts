import * as THREE from 'three'
import { ARENA_RADIUS, BOSS } from './config'
import { instantiate, collectMats, flashMats } from './models'
import { sfx } from './sfx'
import type { Player } from './player'
import type { ProjectilePool } from './projectiles'
import type { Effects } from './effects'
import type { BossDesign } from '../ai/schema'

const _toPlayer = new THREE.Vector3()
const _dir = new THREE.Vector3()

interface Slam {
  ring: THREE.Mesh
  pos: THREE.Vector3
  timer: number
}

/**
 * 오버마인드 본체 — 중앙 코어가 내려와 싸운다.
 * 페이즈 구성(공격 패턴·미니언·해저드·대사)은 LLM 설계(BossDesign) 데이터,
 * 실행은 전부 이 결정론 코드. HP 임계(균등 분할)마다 다음 페이즈로.
 */
export class Boss {
  root: THREE.Group
  private core: THREE.Object3D
  private ring: THREE.Object3D
  private ring2: THREE.Object3D | null = null
  private shards: THREE.Object3D | null = null
  private mats: THREE.MeshStandardMaterial[] = []
  private baseIntensities: number[] = []
  pos = new THREE.Vector3(0, 0, -8)
  hp: number = BOSS.hp
  dead = false
  phaseIndex = 0
  /** 페이즈 전환 무적 (연출 + 미니언 스폰 타이밍) */
  private invulnTimer = 0
  private attackCooldown = 2
  private chargeState: 'none' | 'windup' | 'dash' = 'none'
  private chargeTimer = 0
  private chargeDir = new THREE.Vector3()
  private chargeHit = false
  private slams: Slam[] = []
  private time = 0
  private contactCooldown = 0
  /** 페이즈 진입 콜백 (Game이 미니언·해저드·대사 처리) */
  onPhase?: (phaseIndex: number) => void

  constructor(
    public design: BossDesign,
    private scene: THREE.Scene,
    private effects: Effects,
  ) {
    this.root = new THREE.Group()
    const model = instantiate('boss')
    if (model) {
      this.root.add(model)
      this.core = model.getObjectByName('core') ?? model
      this.ring = model.getObjectByName('ring1') ?? model
      this.ring2 = model.getObjectByName('ring2') ?? null
      this.shards = model.getObjectByName('shards') ?? null
      this.mats = collectMats(model)
    } else {
      // 모델 로드 실패 폴백 — 기본 도형
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(BOSS.radius),
        new THREE.MeshStandardMaterial({
          color: 0x1a0b0b,
          emissive: 0xff5f2e,
          emissiveIntensity: 1.8,
          roughness: 0.3,
          metalness: 0.5,
        }),
      )
      core.castShadow = true
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(BOSS.radius * 1.5, 0.09, 8, 48),
        new THREE.MeshBasicMaterial({ color: 0xffb86b, transparent: true, opacity: 0.8 }),
      )
      this.core = core
      this.ring = ring
      this.mats = [core.material as THREE.MeshStandardMaterial]
      this.root.add(core, ring)
    }
    this.baseIntensities = this.mats.map((m) => m.emissiveIntensity)
    this.root.position.copy(this.pos).setY(BOSS.hoverY)
    scene.add(this.root)
  }

  private setGlow(delta: number): void {
    this.mats.forEach((m, i) => {
      m.emissiveIntensity = this.baseIntensities[i] + delta
    })
  }

  get hpPct(): number {
    return (this.hp / BOSS.hp) * 100
  }

  private get phase() {
    return this.design.phases[Math.min(this.phaseIndex, this.design.phases.length - 1)]
  }

  update(dt: number, player: Player, projectiles: ProjectilePool): void {
    if (this.dead) return
    this.time += dt
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)

    _toPlayer.copy(player.pos).sub(this.pos)
    _toPlayer.y = 0
    const dist = _toPlayer.length()
    if (dist > 0.001) _toPlayer.normalize()

    if (this.invulnTimer > 0) {
      this.invulnTimer -= dt
      this.applyDisplay(dt, true)
      this.updateSlams(dt, player)
      return
    }

    if (this.chargeState !== 'none') {
      this.updateCharge(dt, player)
      this.applyDisplay(dt, false)
      this.updateSlams(dt, player)
      return
    }

    // 평시: 플레이어와 중거리 유지하며 부유 이동
    const preferred = 8
    _dir.copy(_toPlayer).multiplyScalar(dist > preferred ? 1 : -0.6)
    this.pos.addScaledVector(_dir, BOSS.speed * dt)
    const r = this.pos.length()
    const maxR = ARENA_RADIUS - BOSS.radius
    if (r > maxR) this.pos.multiplyScalar(maxR / r)

    // 접촉 피해 (몸통 박치기 방지 압박) — 0.6초 틱
    this.contactCooldown = Math.max(0, this.contactCooldown - dt)
    if (dist < BOSS.radius + 0.7 && !player.isDashing && this.contactCooldown <= 0) {
      this.contactCooldown = 0.6
      player.takeDamage(BOSS.contactDamage)
    }

    if (this.attackCooldown <= 0) this.beginAttack(player, projectiles)

    this.applyDisplay(dt, false)
    this.updateSlams(dt, player)
  }

  private beginAttack(player: Player, projectiles: ProjectilePool): void {
    const attack = this.phase.attack
    if (attack === 'radial_burst') {
      this.attackCooldown = BOSS.radialBurst.cooldown
      const n = BOSS.radialBurst.count
      const offset = Math.random() * Math.PI * 2
      for (let i = 0; i < n; i++) {
        const a = offset + (i / n) * Math.PI * 2
        _dir.set(Math.cos(a), 0, Math.sin(a))
        projectiles.spawn(this.pos, _dir, BOSS.radialBurst.speed, BOSS.radialBurst.damage, false)
      }
      sfx.shoot()
    } else if (attack === 'targeted_slam') {
      this.attackCooldown = BOSS.targetedSlam.cooldown
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(BOSS.targetedSlam.radius * 0.85, BOSS.targetedSlam.radius, 40),
        new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.copy(player.pos).setY(0.08)
      this.scene.add(ring)
      this.slams.push({ ring, pos: player.pos.clone(), timer: BOSS.targetedSlam.warnSec })
      sfx.lungeWarn()
    } else {
      // charge
      this.attackCooldown = BOSS.charge.cooldown
      this.chargeState = 'windup'
      this.chargeTimer = BOSS.charge.windup
      sfx.lungeWarn()
    }
  }

  private updateCharge(dt: number, player: Player): void {
    this.chargeTimer -= dt
    if (this.chargeState === 'windup') {
      this.setGlow((BOSS.charge.windup - this.chargeTimer) * 4)
      if (this.chargeTimer <= 0) {
        this.chargeState = 'dash'
        this.chargeTimer = BOSS.charge.duration
        this.chargeDir.copy(player.pos).sub(this.pos).setY(0).normalize()
        this.chargeHit = false
      }
      return
    }
    // dash
    this.pos.addScaledVector(this.chargeDir, BOSS.charge.speed * dt)
    const r = this.pos.length()
    const maxR = ARENA_RADIUS - BOSS.radius
    if (r > maxR) {
      this.pos.multiplyScalar(maxR / r)
      this.chargeTimer = 0
    }
    if (!this.chargeHit && this.pos.distanceTo(player.pos) < BOSS.radius + 0.8) {
      this.chargeHit = true
      player.takeDamage(BOSS.charge.damage)
    }
    if (this.chargeTimer <= 0) {
      this.chargeState = 'none'
      this.setGlow(0)
    }
  }

  private updateSlams(dt: number, player: Player): void {
    for (let i = this.slams.length - 1; i >= 0; i--) {
      const s = this.slams[i]
      s.timer -= dt
      ;(s.ring.material as THREE.MeshBasicMaterial).opacity = 0.4 + Math.sin(this.time * 20) * 0.3
      s.ring.scale.setScalar(1 + Math.max(0, s.timer / BOSS.targetedSlam.warnSec) * 0.2)
      if (s.timer <= 0) {
        if (s.pos.distanceTo(player.pos) < BOSS.targetedSlam.radius) {
          player.takeDamage(BOSS.targetedSlam.damage)
        }
        this.effects.burst(s.pos, 0xef4444, 16, 9)
        this.effects.shake(0.4)
        sfx.meleeHit()
        this.scene.remove(s.ring)
        this.slams.splice(i, 1)
      }
    }
  }

  private applyDisplay(dt: number, invuln: boolean): void {
    this.root.position.copy(this.pos).setY(BOSS.hoverY + Math.sin(this.time * 1.6) * 0.3)
    this.core.rotation.y += dt * (this.chargeState === 'windup' ? 8 : 1.2)
    this.core.rotation.x = Math.sin(this.time * 0.8) * 0.4
    this.ring.rotation.y += dt * 1.4
    if (this.ring2) this.ring2.rotation.y -= dt * 0.9
    if (this.shards) this.shards.rotation.y += dt * 2.2
    if (invuln) this.setGlow(1.2 + Math.sin(this.time * 15) * 1.5)
  }

  /** 피해 적용. 페이즈 전환 무적 중엔 false */
  takeDamage(amount: number): boolean {
    if (this.dead || this.invulnTimer > 0) return false
    this.hp -= amount
    flashMats(this.mats)

    // 페이즈 전환: HP를 페이즈 수로 균등 분할한 임계마다
    const phaseCount = this.design.phases.length
    const nextThreshold = BOSS.hp * (1 - (this.phaseIndex + 1) / phaseCount)
    if (this.hp <= 0) {
      if (this.phaseIndex < phaseCount - 1) {
        // 마지막 페이즈 전이라면 최소 1 HP로 페이즈 강제 진행 (스킵 방지)
        this.hp = 1
      } else {
        this.dead = true
        return true
      }
    }
    if (this.phaseIndex < phaseCount - 1 && this.hp <= nextThreshold) {
      this.phaseIndex++
      this.invulnTimer = BOSS.phaseInvulnSec
      this.chargeState = 'none'
      this.onPhase?.(this.phaseIndex)
    }
    return true
  }

  dispose(): void {
    for (const s of this.slams) this.scene.remove(s.ring)
    this.slams = []
    this.scene.remove(this.root)
  }
}
