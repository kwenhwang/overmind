import * as THREE from 'three'
import { ARENA_RADIUS, ENEMY_TYPES, type EnemyType } from './config'
import { events } from './events'
import { instantiate, collectMats, flashMats, getAnimations, findClip } from './models'
import type { Player } from './player'
import type { ProjectilePool } from './projectiles'
import type { Directive, Modifier } from '../ai/schema'

const _toPlayer = new THREE.Vector3()
const _steer = new THREE.Vector3()
const _side = new THREE.Vector3()
const _toAttacker = new THREE.Vector3()

type ActionName = 'chase' | 'strafe' | 'attack' | 'keepDistance'
/** 공격 연출 단계 — 모든 피해는 예고(windup) 후에만 발생 (읽고 피할 수 있는 전투) */
type AttackPhase = 'none' | 'windup' | 'lunge'

export interface EnemyVariant {
  scaleMul?: number
  hpMul?: number
}

/**
 * L1 전술 계층: 유틸리티 점수로 행동 선택.
 * L2(LLM)는 구성·모디파이어·공격성(데이터)만 설계하고, 프레임 제어는 하지 않는다.
 */
export class Enemy {
  /** 위치·제거의 기준 노드 (본체 회전과 분리) */
  root: THREE.Group
  private body: THREE.Object3D
  private mats: THREE.MeshStandardMaterial[] = []
  private baseIntensities: number[] = []
  /** 드론 모델의 회전 블레이드 노드 */
  private blades: THREE.Object3D | null = null
  private shieldBadge: THREE.Object3D | null = null
  private orbitBadges: THREE.Object3D[] = []
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
  private baseEmissive = 0.45
  /** 실드 방향 — 플레이어를 천천히 추적 (등 뒤 침투의 여지) */
  private facingDir = new THREE.Vector3(1, 0, 0)
  private time = Math.random() * 10
  private scaleMul: number
  /** 스폰 팝 연출 (오버슛 스케일-인) */
  private spawnTimer = 0.32
  private mixer: THREE.AnimationMixer | null = null
  private clips: { idle: THREE.AnimationClip | null; move: THREE.AnimationClip | null; attack: THREE.AnimationClip | null }
  private curAction: THREE.AnimationAction | null = null
  /** L2 디렉티브가 조정하는 공격성 (1~5) */
  aggression = 3

  constructor(
    public type: EnemyType,
    spawnPos: THREE.Vector3,
    scene: THREE.Scene,
    public modifiers: Modifier[] = [],
    variant: EnemyVariant = {},
  ) {
    const spec = ENEMY_TYPES[type]
    this.scaleMul = variant.scaleMul ?? 1
    this.hp = Math.round(spec.hp * (variant.hpMul ?? 1))
    this.pos = spawnPos.clone()

    const model = instantiate(type)
    if (model) {
      this.body = model
      this.blades = model.getObjectByName('blades') ?? null
      this.mats = collectMats(model)
      // 애니메이션 믹서 — 이동/공격/대기 클립 재생
      const anims = getAnimations(type)
      if (anims.length) {
        this.mixer = new THREE.AnimationMixer(model)
        this.clips = {
          idle: findClip(anims, 'idle'),
          move: findClip(anims, 'move'),
          attack: findClip(anims, 'attack'),
        }
      } else {
        this.clips = { idle: null, move: null, attack: null }
      }
    } else {
      // 모델 로드 실패 폴백 — 기본 도형
      const geo =
        type === 'brute'
          ? new THREE.BoxGeometry(spec.radius * 1.8, 1.8, spec.radius * 1.8)
          : new THREE.OctahedronGeometry(spec.radius * 1.15)
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: spec.color,
          roughness: 0.35,
          metalness: 0.3,
          emissive: spec.color,
          emissiveIntensity: this.baseEmissive,
        }),
      )
      mesh.castShadow = true
      this.body = mesh
      this.mats = [mesh.material as THREE.MeshStandardMaterial]
      this.clips = { idle: null, move: null, attack: null }
    }
    this.baseIntensities = this.mats.map((m) => m.emissiveIntensity)
    this.body.position.y = 0.9

    this.root = new THREE.Group()
    this.root.add(this.body)
    this.root.scale.setScalar(this.scaleMul)
    this.buildBadges()
    this.root.position.copy(this.pos)
    scene.add(this.root)
  }

  get radius(): number {
    return ENEMY_TYPES[this.type].radius * this.scaleMul
  }
  get color(): number {
    return ENEMY_TYPES[this.type].color
  }
  has(mod: Modifier): boolean {
    return this.modifiers.includes(mod)
  }

  /** 모디파이어별 시각 배지 — 에셋 없이 형태·색으로 구분 */
  private buildBadges(): void {
    if (this.has('thorns')) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xfca5a5, emissive: 0xef4444, emissiveIntensity: 0.9 })
      for (let i = 0; i < 4; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 6), mat)
        const a = (i / 4) * Math.PI * 2
        spike.position.set(Math.cos(a) * 0.85, 0.9, Math.sin(a) * 0.85)
        spike.rotation.z = -Math.PI / 2
        spike.rotation.y = -a
        this.root.add(spike)
      }
    }
    if (this.has('shielded_front')) {
      const arc = new THREE.Mesh(
        new THREE.CylinderGeometry(1.15, 1.15, 1.3, 16, 1, true, -Math.PI / 3, (Math.PI * 2) / 3),
        new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      )
      arc.position.y = 0.9
      this.shieldBadge = arc
      this.root.add(arc)
    }
    if (this.has('split_on_death')) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xf0abfc })
      for (let i = 0; i < 2; i++) {
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), mat)
        this.orbitBadges.push(orb)
        this.root.add(orb)
      }
    }
    if (this.has('explode_on_death')) {
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x7c2d12, emissive: 0xf97316, emissiveIntensity: 2 }),
      )
      core.position.y = 1.9
      core.name = 'explode-core'
      this.root.add(core)
    }
    if (this.has('mirror_dash')) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.9, 0.05, 6, 24),
        new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.7 }),
      )
      ring.rotation.x = Math.PI / 2
      ring.position.y = 0.15
      this.root.add(ring)
    }
    if (this.has('enrage_far')) {
      const fin = new THREE.Mesh(
        new THREE.ConeGeometry(0.16, 0.6, 6),
        new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xfacc15, emissiveIntensity: 1.2 }),
      )
      fin.position.y = 1.8
      this.root.add(fin)
    }
  }

  /** 애니메이션 클립 전환 (크로스페이드) */
  private playClip(clip: THREE.AnimationClip | null): void {
    if (!this.mixer || !clip) return
    const next = this.mixer.clipAction(clip)
    if (next === this.curAction) return
    next.reset().fadeIn(0.2).play()
    this.curAction?.fadeOut(0.2)
    this.curAction = next
  }

  update(dt: number, player: Player, projectiles: ProjectilePool): void {
    if (this.dead) return
    this.time += dt
    this.mixer?.update(dt)
    const spec = ENEMY_TYPES[this.type]
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)

    _toPlayer.copy(player.pos).sub(this.pos)
    _toPlayer.y = 0
    const dist = _toPlayer.length()
    if (dist > 0.001) _toPlayer.normalize()

    // 실드 방향은 플레이어를 '천천히' 추적 — 대시로 등 뒤를 잡을 수 있게
    this.facingDir.lerp(_toPlayer, Math.min(1, dt * 2.2)).normalize()

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
      this.action = this.chooseAction(dist)
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
      // enrage_far: 플레이어가 거리를 벌리면 가속 (카이팅 처벌)
      const enraged = this.has('enrage_far') && dist > 8
      this.pos.addScaledVector(_steer.normalize(), spec.speed * (enraged ? 1.7 : 1) * dt)
    }
    this.applyDisplay(dt)
  }

  /** mirror_dash: 플레이어의 대시를 감지해 같은 방향으로 돌진 (Game이 호출) */
  mirrorDash(dir: THREE.Vector3): void {
    if (!this.has('mirror_dash') || this.dead || this.phase !== 'none') return
    this.phase = 'lunge'
    this.phaseTimer = 0.3
    this.lungeDir.copy(dir).setY(0).normalize()
    this.lungeHit = false
  }

  /** 공격 개시 = 예고 단계 진입 (즉발 피해 없음) */
  private beginAttack(dist: number, spec: (typeof ENEMY_TYPES)[EnemyType]): void {
    if (this.attackCooldown > 0 || dist > spec.attackRange) return
    this.attackCooldown = spec.attackCooldown
    this.phase = 'windup'
    this.phaseTimer = this.type === 'drone' ? ENEMY_TYPES.drone.windup : 0.4
    if (this.type === 'drone') events.emit('lungeWarn', { pos: this.pos })
  }

  /** 예고 발광 — 모든 머티리얼의 기준 강도에 델타를 더함 */
  private setGlow(delta: number): void {
    this.mats.forEach((m, i) => {
      m.emissiveIntensity = this.baseIntensities[i] + delta
    })
  }

  private updateWindup(dt: number, player: Player, projectiles: ProjectilePool, dist: number): void {
    this.phaseTimer -= dt
    this.setGlow((1 - Math.max(0, this.phaseTimer) / 0.45) * 2.2)
    if (this.phaseTimer > 0) return

    this.setGlow(0)
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
    if (!this.lungeHit && this.pos.distanceTo(player.pos) < this.radius + 0.7) {
      this.lungeHit = true
      player.takeDamage(spec.damage)
    }
    if (this.phaseTimer <= 0) this.phase = 'none'
  }

  private applyDisplay(dt: number): void {
    const r = this.pos.length()
    if (r > ARENA_RADIUS - this.radius) this.pos.multiplyScalar((ARENA_RADIUS - this.radius) / r)
    this.root.position.copy(this.pos)

    // 스폰 팝: 오버슛 스케일-인
    if (this.spawnTimer > 0) {
      this.spawnTimer -= dt
      const t = Math.min(1, 1 - this.spawnTimer / 0.32)
      const c1 = 1.70158
      const back = 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
      this.root.scale.setScalar(this.scaleMul * Math.max(0.01, back))
    }
    // 모든 적은 플레이어를 바라봄 (스킨 애니가 다리·팔 움직임을 담당)
    this.body.rotation.y = Math.atan2(-this.facingDir.x, -this.facingDir.z) + Math.PI
    if (this.blades) this.blades.rotation.y += dt * 9 // 폴백 도형용

    // 애니메이션 상태: 공격 단계=attack, 그 외=이동(move) → 없으면 idle
    if (this.mixer) {
      if (this.phase !== 'none') this.playClip(this.clips.attack ?? this.clips.move)
      else this.playClip(this.clips.move ?? this.clips.idle)
    }

    if (this.shieldBadge) {
      this.root.rotation.y = 0
      this.shieldBadge.rotation.y = Math.atan2(-this.facingDir.z, this.facingDir.x) - Math.PI / 2 + Math.PI / 3
    }
    for (let i = 0; i < this.orbitBadges.length; i++) {
      const a = this.time * 2.4 + i * Math.PI
      this.orbitBadges[i].position.set(Math.cos(a) * 1.1, 1.3, Math.sin(a) * 1.1)
    }
    const explodeCore = this.root.getObjectByName('explode-core') as THREE.Mesh | undefined
    if (explodeCore) {
      const pulse = 1 + Math.sin(this.time * 6) * 0.35
      explodeCore.scale.setScalar(pulse)
    }
  }

  /** 유틸리티 점수 — 각 행동의 매력을 상황 함수로 계산 */
  private chooseAction(dist: number): ActionName {
    const spec = ENEMY_TYPES[this.type]
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

  /**
   * 피해 적용. attackerPos가 주어지고 shielded_front가 정면을 막으면 false(차단) 반환.
   */
  takeDamage(amount: number, knockDir?: THREE.Vector3, knockForce = 0, attackerPos?: THREE.Vector3): boolean {
    if (attackerPos && this.has('shielded_front')) {
      _toAttacker.copy(attackerPos).sub(this.pos).setY(0).normalize()
      if (_toAttacker.dot(this.facingDir) > 0.35) return false // 정면 차단 — 등 뒤를 노려라
    }
    this.hp -= amount
    if (knockDir && knockForce > 0) this.knockback.addScaledVector(knockDir, knockForce)
    if (this.hp <= 0) this.dead = true
    else flashMats(this.mats)
    return true
  }

  applyDirective(directive: Directive): void {
    this.aggression = directive.aggression
  }
}
