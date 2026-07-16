import * as THREE from 'three'
import { ARENA_RADIUS, PLAYER } from './config'
import { IS_TOUCH, type Input } from './input'
import { instantiate, collectMats, flashMats } from './models'

const _move = new THREE.Vector3()
const _aim = new THREE.Vector3()

export class Player {
  mesh: THREE.Group
  pos = new THREE.Vector3(0, 0, 6)
  facing = new THREE.Vector3(0, 0, -1)
  hp: number = PLAYER.hp
  /** 해저드(감속 지대 등)가 조정하는 이동 배율 — Game이 매 프레임 설정 */
  speedMul = 1
  /** 이번 프레임의 이동 방향 (정규화, 정지 시 0) — 텔레메트리가 상시 회피 성향 측정에 사용 */
  moveDir = new THREE.Vector3()
  private dashTimer = 0
  private dashCooldown = 0
  private dashDir = new THREE.Vector3()
  private meleeCooldown = 0
  private rangedCooldown = 0
  private hurtFlash = 0
  private bodyMat: THREE.MeshStandardMaterial

  /** 이번 프레임에 발생한 공격 요청 — Game이 소비 */
  wantsMelee = false
  wantsRanged = false
  /** 텔레메트리 훅 */
  onDash?: (dir: THREE.Vector3) => void

  private mats: THREE.MeshStandardMaterial[] = []

  constructor(scene: THREE.Scene) {
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x4ade80,
      roughness: 0.35,
      emissive: 0x22c55e,
      emissiveIntensity: 0.5,
    })
    this.mesh = new THREE.Group()
    const model = instantiate('player')
    if (model) {
      model.position.y = 0.9
      this.mesh.add(model)
      this.mats = collectMats(model)
    } else {
      // 모델 로드 실패 폴백 — 기본 도형
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER.radius, 0.7, 4, 12), this.bodyMat)
      body.position.y = 0.9
      body.castShadow = true
      const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 0.55, 8),
        new THREE.MeshStandardMaterial({ color: 0xe8e8ec }),
      )
      nose.rotation.x = Math.PI / 2
      nose.position.set(0, 0.9, -0.65)
      this.mesh.add(body, nose)
      this.mats = [this.bodyMat]
    }
    scene.add(this.mesh)
  }

  get isDashing(): boolean {
    return this.dashTimer > 0
  }

  /**
   * 모바일 자동 전투: 최근접 적 방향으로 조준하고 사거리에 맞는 공격을 자동 발동.
   * 데스크톱과 동일한 쿨다운을 쓰므로 밸런스 왜곡 없음.
   */
  autoCombat(nearestDir: THREE.Vector3 | null, nearestDist: number): void {
    if (!nearestDir) return
    this.facing.copy(nearestDir)
    if (nearestDist <= PLAYER.melee.range && this.meleeCooldown <= 0) {
      this.meleeCooldown = PLAYER.melee.cooldown
      this.wantsMelee = true
    } else if (nearestDist > PLAYER.melee.range && this.rangedCooldown <= 0) {
      this.rangedCooldown = PLAYER.ranged.cooldown
      this.wantsRanged = true
    }
  }

  update(dt: number, input: Input): void {
    this.dashCooldown = Math.max(0, this.dashCooldown - dt)
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt)
    this.rangedCooldown = Math.max(0, this.rangedCooldown - dt)

    const move = input.moveDir(_move)
    this.moveDir.copy(move)

    // 대시: 이동 방향으로 짧은 무적 돌진
    if (this.dashTimer > 0) {
      this.dashTimer -= dt
      this.pos.addScaledVector(this.dashDir, PLAYER.dashSpeed * dt)
    } else {
      if (input.dashPressed && this.dashCooldown <= 0 && move.lengthSq() > 0) {
        this.dashTimer = PLAYER.dashDuration
        this.dashCooldown = PLAYER.dashCooldown
        this.dashDir.copy(move)
        this.onDash?.(this.dashDir)
      }
      this.pos.addScaledVector(move, PLAYER.speed * this.speedMul * dt)
    }

    // 아레나 경계
    const r = this.pos.length()
    if (r > ARENA_RADIUS - PLAYER.radius) {
      this.pos.multiplyScalar((ARENA_RADIUS - PLAYER.radius) / r)
    }

    // 조준 방향 = 마우스 지면 포인트 (터치 모드는 autoCombat이 최근접 적으로 조준)
    if (!IS_TOUCH) {
      _aim.copy(input.aimPoint).sub(this.pos)
      _aim.y = 0
      if (_aim.lengthSq() > 0.01) this.facing.copy(_aim).normalize()
    }

    // 공격 요청
    if ((input.meleePressed || input.meleeKeyHeld) && this.meleeCooldown <= 0) {
      this.meleeCooldown = PLAYER.melee.cooldown
      this.wantsMelee = true
    }
    if ((input.rangedHeld || input.rangedKeyHeld) && this.rangedCooldown <= 0) {
      this.rangedCooldown = PLAYER.ranged.cooldown
      this.wantsRanged = true
    }

    // 표시 갱신
    this.mesh.position.copy(this.pos)
    this.mesh.rotation.y = Math.atan2(-this.facing.x, -this.facing.z) + Math.PI
    if (this.hurtFlash > 0) this.hurtFlash -= dt
  }

  takeDamage(amount: number): void {
    if (this.isDashing) return // 대시 중 무적
    this.hp = Math.max(0, this.hp - amount)
    if (this.hurtFlash <= 0) {
      this.hurtFlash = 0.15
      flashMats(this.mats)
    }
  }

  consumeAttacks(): { melee: boolean; ranged: boolean } {
    const out = { melee: this.wantsMelee, ranged: this.wantsRanged }
    this.wantsMelee = false
    this.wantsRanged = false
    return out
  }
}
