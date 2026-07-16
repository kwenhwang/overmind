import * as THREE from 'three'
import { ARENA_RADIUS, type EnemyType } from './config'
import { Enemy } from './enemies'
import type { Modifier, WaveDesign } from '../ai/schema'

export interface SpawnPlan {
  type: EnemyType
  pos: THREE.Vector3
  modifiers: Modifier[]
}

/**
 * 웨이브 실행기 1단계 — L2가 설계한 WaveDesign(데이터)을 스폰 좌표 목록으로 변환.
 * 실제 스폰은 경고 링 텔레그래프 후 Game이 spawnEnemies로 실행.
 */
export function planWaveSpawns(
  design: WaveDesign,
  playerPos: THREE.Vector3,
  playerFacing: THREE.Vector3,
): SpawnPlan[] {
  const flat: { type: EnemyType; modifiers: Modifier[] }[] = []
  for (const s of design.spawns)
    for (let i = 0; i < s.count; i++) flat.push({ type: s.type, modifiers: s.modifiers ?? [] })

  const baseAngle = biasAngle(design.spawnBias, playerPos, playerFacing)
  const spread = design.spawnBias === 'surround' ? Math.PI * 2 : Math.PI / 2.5

  return flat.map(({ type, modifiers }, i) => {
    const t = flat.length > 1 ? i / (flat.length - 1) : 0.5
    const angle = baseAngle + (t - 0.5) * spread + (Math.random() - 0.5) * 0.2
    const dist = ARENA_RADIUS * (0.55 + Math.random() * 0.35)
    const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist)
    // 플레이어 바로 위 스폰 방지
    if (pos.distanceTo(playerPos) < 5) pos.multiplyScalar(-0.8)
    return { type, pos, modifiers }
  })
}

/** 웨이브 실행기 2단계 — 계획된 좌표에 실제 스폰 */
export function spawnEnemies(plan: SpawnPlan[], aggression: number, scene: THREE.Scene): Enemy[] {
  return plan.map(({ type, pos, modifiers }) => {
    const enemy = new Enemy(type, pos, scene, modifiers)
    enemy.aggression = aggression
    return enemy
  })
}

/** 스폰 예고 마커 — 붉은 경고 링 */
export function createSpawnMarkers(plan: SpawnPlan[], scene: THREE.Scene): THREE.Mesh[] {
  return plan.map(({ pos }) => {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.8, 24),
      new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.copy(pos).setY(0.08)
    scene.add(ring)
    return ring
  })
}

/** 스폰 편향 → 월드 각도. left/right는 플레이어 시선 기준 */
function biasAngle(bias: WaveDesign['spawnBias'], playerPos: THREE.Vector3, facing: THREE.Vector3): number {
  const facingAngle = Math.atan2(facing.z, facing.x)
  switch (bias) {
    case 'front':
      return facingAngle
    case 'behind':
      return facingAngle + Math.PI
    case 'left':
      return facingAngle - Math.PI / 2
    case 'right':
      return facingAngle + Math.PI / 2
    case 'surround':
      return Math.atan2(playerPos.z, playerPos.x) + Math.PI
  }
}
