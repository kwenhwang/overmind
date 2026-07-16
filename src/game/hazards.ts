import * as THREE from 'three'
import { ARENA_RADIUS } from './config'
import type { HazardSpec } from '../ai/schema'
import type { Player } from './player'

const HAZARD_RADIUS = 4.2
const SPIKE_DPS = 9

/**
 * 아레나 해저드 — L2가 배치를 설계하고(플레이어 습관 기준 상대 위치),
 * 실행·판정은 결정론 코드. 웨이브 시작 시 생성, 종료 시 제거.
 */
export class Hazard {
  mesh: THREE.Mesh
  private tickAccum = 0

  constructor(
    public spec: HazardSpec,
    public pos: THREE.Vector3,
    scene: THREE.Scene,
  ) {
    const spike = spec.type === 'spike_zone'
    this.mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(HAZARD_RADIUS, HAZARD_RADIUS, 0.1, 40),
      new THREE.MeshStandardMaterial({
        color: spike ? 0x450a0a : 0x082f49,
        emissive: spike ? 0xdc2626 : 0x0ea5e9,
        emissiveIntensity: 0.7,
        transparent: true,
        opacity: 0.5,
      }),
    )
    this.mesh.position.copy(pos).setY(0.05)
    scene.add(this.mesh)
  }

  /** 플레이어가 안에 있으면 효과 적용. spike는 0.5초마다 피해, slow는 감속 배율 반환 */
  update(dt: number, player: Player): number {
    const inside = this.pos.distanceTo(player.pos) < HAZARD_RADIUS
    const mat = this.mesh.material as THREE.MeshStandardMaterial
    mat.emissiveIntensity = inside ? 1.6 : 0.6 + Math.sin(performance.now() * 0.003) * 0.15

    if (!inside) {
      this.tickAccum = 0
      return 1
    }
    if (this.spec.type === 'spike_zone') {
      this.tickAccum += dt
      if (this.tickAccum >= 0.5) {
        this.tickAccum -= 0.5
        player.takeDamage(Math.round(SPIKE_DPS * 0.5))
      }
      return 1
    }
    return 0.55 // slow_field
  }
}

/** 배치 enum → 월드 좌표 (웨이브 시작 시점의 플레이어 기준) */
export function resolveHazardPos(
  placement: HazardSpec['placement'],
  playerPos: THREE.Vector3,
  facing: THREE.Vector3,
): THREE.Vector3 {
  const out = new THREE.Vector3()
  const left = new THREE.Vector3(facing.z, 0, -facing.x)
  switch (placement) {
    case 'center':
      out.set(0, 0, 0)
      break
    case 'player_left':
      out.copy(playerPos).addScaledVector(left, 7)
      break
    case 'player_right':
      out.copy(playerPos).addScaledVector(left, -7)
      break
    case 'front':
      out.copy(playerPos).addScaledVector(facing, 8)
      break
    case 'behind':
      out.copy(playerPos).addScaledVector(facing, -8)
      break
  }
  const r = out.length()
  const max = ARENA_RADIUS - HAZARD_RADIUS * 0.6
  if (r > max) out.multiplyScalar(max / r)
  return out
}
