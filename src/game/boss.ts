import * as THREE from 'three'
import { ARENA_RADIUS, BOSS } from './config'
import { instantiate, collectMats, flashMats, getAnimations, findClip } from './models'
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
  // ── 스킨드 애니메이션 (보스 모델 = 캐릭터, 클립: Idle/Run/Attack/Shoot/Jump/Death) ──
  private mixer: THREE.AnimationMixer | null = null
  private clips: Record<'idle' | 'move' | 'attack' | 'shoot' | 'jump' | 'death', THREE.AnimationClip | null> = {
    idle: null, move: null, attack: null, shoot: null, jump: null, death: null,
  }
  private curAction: THREE.AnimationAction | null = null
  /** 현재 재생할 동작 (applyDisplay가 클립으로 변환) */
  private animKind: 'idle' | 'move' | 'attack' = 'idle'
  /** 공격 클립 유지 타이머 — 발사 후 잠깐 공격 자세 유지 */
  private attackAnimTimer = 0
  private attackClip: THREE.AnimationClip | null = null
  /** 몸통이 바라보는 방향 (플레이어 추적) */
  private facingDir = new THREE.Vector3(0, 0, 1)
  private deathPlayed = false
  /** 모델 중심이 원점이라 발이 바닥에 닿도록 올리는 보정 (지면 배치용) */
  private footOffset = 0
  /** 강림 연출 — 상공에서 내려오는 동안 무적·공격 없음 */
  private entranceTimer = 1.6
  private landed = false
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
      // 스킨드 캐릭터면 애니 믹서 연결 (기하학 폴백엔 클립 없음 → 절차적 회전 유지)
      const anims = getAnimations('boss')
      if (anims.length) {
        this.mixer = new THREE.AnimationMixer(model)
        this.clips = {
          idle: findClip(anims, 'idle'),
          move: findClip(anims, 'move'),
          attack: findClip(anims, 'attack'),
          shoot: anims.find((c) => /shoot/i.test(c.name)) ?? findClip(anims, 'attack'),
          jump: anims.find((c) => /jump/i.test(c.name)) ?? null,
          death: findClip(anims, 'death'),
        }
        // 발이 지면에 닿도록: 모델 bbox의 최저점을 원점으로 (중심 정규화 보정)
        const bbox = new THREE.Box3().setFromObject(model)
        this.footOffset = -bbox.min.y
      }
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
    // ?bosshp=N — 검증·영상 촬영용 체력 오버라이드
    const dbgHp = Number(new URLSearchParams(location.search).get('bosshp'))
    if (dbgHp > 0) this.hp = dbgHp
    this.root.position.copy(this.pos).setY(BOSS.hoverY + 16) // 상공에서 강림 시작
    scene.add(this.root)
  }

  private setGlow(delta: number): void {
    this.mats.forEach((m, i) => {
      m.emissiveIntensity = this.baseIntensities[i] + delta
    })
  }

  /** 부유 기준 높이 — 애니 캐릭터는 지면(작은 바운스), 기하학 폴백은 공중 부유 */
  private get baseY(): number {
    return this.mixer ? 0 : BOSS.hoverY
  }

  /** 클립 전환 (크로스페이드). once=사망처럼 1회 재생 후 정지 */
  private playClip(clip: THREE.AnimationClip | null, once = false): void {
    if (!this.mixer || !clip) return
    const next = this.mixer.clipAction(clip)
    if (next === this.curAction) return
    if (once) {
      next.setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
    }
    next.reset().fadeIn(0.18).play()
    this.curAction?.fadeOut(0.18)
    this.curAction = next
  }

  get hpPct(): number {
    return (this.hp / BOSS.hp) * 100
  }

  private get phase() {
    return this.design.phases[Math.min(this.phaseIndex, this.design.phases.length - 1)]
  }

  update(dt: number, player: Player, projectiles: ProjectilePool): void {
    this.time += dt
    this.mixer?.update(dt)
    this.attackAnimTimer = Math.max(0, this.attackAnimTimer - dt)

    // 사망: 데스 클립을 1회 재생하며 그 자리에 유지 (Game이 폭발 시퀀스 처리 중)
    if (this.dead) {
      if (this.mixer && !this.deathPlayed) {
        this.deathPlayed = true
        this.playClip(this.clips.death, true)
      }
      this.root.position.copy(this.pos).setY(this.baseY + this.footOffset)
      return
    }

    // 강림: 상공에서 하강 → 착지 충격 (애니: 점프/공중 자세)
    if (this.entranceTimer > 0) {
      this.entranceTimer -= dt
      const t = Math.max(0, this.entranceTimer / 1.6)
      const ease = t * t // 가속 하강
      this.root.position.copy(this.pos).setY(this.baseY + this.footOffset + ease * 16)
      if (this.mixer) this.playClip(this.clips.jump ?? this.clips.idle)
      else this.core.rotation.y += dt * 10
      if (this.entranceTimer <= 0 && !this.landed) {
        this.landed = true
        this.effects.burst(this.pos, 0xff5f2e, 26, 12)
        this.effects.shake(1.0)
        this.effects.hitstop(0.12)
        sfx.enemyDie()
      }
      return
    }

    this.attackCooldown = Math.max(0, this.attackCooldown - dt)

    _toPlayer.copy(player.pos).sub(this.pos)
    _toPlayer.y = 0
    const dist = _toPlayer.length()
    if (dist > 0.001) _toPlayer.normalize()
    // 몸통은 항상 플레이어를 향함 (부드럽게)
    this.facingDir.lerp(_toPlayer, Math.min(1, dt * 3)).normalize()

    if (this.invulnTimer > 0) {
      this.invulnTimer -= dt
      this.animKind = 'idle'
      this.applyDisplay(dt, true)
      this.updateSlams(dt, player)
      return
    }

    if (this.chargeState !== 'none') {
      this.animKind = 'attack'
      this.updateCharge(dt, player)
      this.applyDisplay(dt, false)
      this.updateSlams(dt, player)
      return
    }

    // 평시: 플레이어와 중거리 유지하며 이동
    const preferred = 8
    _dir.copy(_toPlayer).multiplyScalar(dist > preferred ? 1 : -0.6)
    this.pos.addScaledVector(_dir, BOSS.speed * dt)
    const r = this.pos.length()
    const maxR = ARENA_RADIUS - BOSS.radius
    if (r > maxR) this.pos.multiplyScalar(maxR / r)
    // 이동 중이면 걷기, 아니면 대기 (공격 자세 유지 중이 아닐 때만)
    this.animKind = this.attackAnimTimer > 0 ? 'attack' : dist > preferred + 0.5 ? 'move' : 'idle'

    // 접촉 피해 (몸통 박치기 방지 압박) — 0.6초 틱
    this.contactCooldown = Math.max(0, this.contactCooldown - dt)
    if (dist < BOSS.radius + 0.7 && !player.isDashing && this.contactCooldown <= 0) {
      this.contactCooldown = 0.6
      player.takeDamage(BOSS.contactDamage, "보스 접촉")
    }

    if (this.attackCooldown <= 0) this.beginAttack(player, projectiles)

    this.applyDisplay(dt, false)
    this.updateSlams(dt, player)
  }

  private beginAttack(player: Player, projectiles: ProjectilePool): void {
    const attack = this.phase.attack
    // 공격 애니: 원거리 탄막은 사격(Shoot), 근접/돌진은 공격(Attack) 클립
    this.attackClip = attack === 'radial_burst' ? this.clips.shoot : this.clips.attack
    this.attackAnimTimer = 0.7
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
      player.takeDamage(BOSS.charge.damage, "보스 돌진")
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
          player.takeDamage(BOSS.targetedSlam.damage, "보스 강타")
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
    if (this.mixer) {
      // 애니 캐릭터: 지면 바운스 + 플레이어를 바라봄 + 상태별 클립
      this.root.position.copy(this.pos).setY(this.baseY + this.footOffset + Math.abs(Math.sin(this.time * 2)) * 0.12)
      this.core.rotation.set(0, Math.atan2(-this.facingDir.x, -this.facingDir.z) + Math.PI, 0)
      const clip =
        this.animKind === 'attack'
          ? (this.attackClip ?? this.clips.attack ?? this.clips.idle)
          : this.animKind === 'move'
            ? (this.clips.move ?? this.clips.idle)
            : this.clips.idle
      this.playClip(clip)
    } else if (this.core === this.ring) {
      // 통짜 임포트 모델(Tripo 보스 코어): 팽이 X → 위압적 느린 Y회전 + 부유 바운스만
      this.root.position.copy(this.pos).setY(BOSS.hoverY + Math.sin(this.time * 1.6) * 0.35)
      this.core.rotation.set(0, this.core.rotation.y + dt * (this.chargeState === 'windup' ? 5 : 0.5), 0)
    } else {
      // 기하학 폴백 코어(코어+링+파편 분리): 절차적 다중 회전
      this.root.position.copy(this.pos).setY(BOSS.hoverY + Math.sin(this.time * 1.6) * 0.3)
      this.core.rotation.y += dt * (this.chargeState === 'windup' ? 8 : 1.2)
      this.core.rotation.x = Math.sin(this.time * 0.8) * 0.4
      this.ring.rotation.y += dt * 1.4
      if (this.ring2) this.ring2.rotation.y -= dt * 0.9
      if (this.shards) this.shards.rotation.y += dt * 2.2
    }
    if (invuln) this.setGlow(1.2 + Math.sin(this.time * 15) * 1.5)
    else if (this.chargeState !== 'windup') this.setGlow(0) // 무적/차지 종료 후 발광 원복
  }

  /** 피해 적용. 강림·페이즈 전환 무적 중엔 false */
  takeDamage(amount: number): boolean {
    if (this.dead || this.invulnTimer > 0 || this.entranceTimer > 0) return false
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
