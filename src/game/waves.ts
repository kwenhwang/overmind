import * as THREE from 'three'
import { ARENA_RADIUS } from './config'
import { Enemy } from './enemies'
import type { WaveDesign } from '../ai/schema'

/**
 * 웨이브 실행기 — L2가 설계한 WaveDesign(데이터)을 실제 스폰으로 실행하는 결정론 계층.
 */
export function executeWaveDesign(
  design: WaveDesign,
  playerPos: THREE.Vector3,
  playerFacing: THREE.Vector3,
  scene: THREE.Scene,
): Enemy[] {
  const enemies: Enemy[] = []
  const flat: Enemy['type'][] = []
  for (const s of design.spawns) for (let i = 0; i < s.count; i++) flat.push(s.type)

  const baseAngle = biasAngle(design.spawnBias, playerPos, playerFacing)
  const spread = design.spawnBias === 'surround' ? Math.PI * 2 : Math.PI / 2.5

  flat.forEach((type, i) => {
    const t = flat.length > 1 ? i / (flat.length - 1) : 0.5
    const angle = baseAngle + (t - 0.5) * spread + (Math.random() - 0.5) * 0.2
    const dist = ARENA_RADIUS * (0.55 + Math.random() * 0.35)
    const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist)
    // 플레이어 바로 위 스폰 방지
    if (pos.distanceTo(playerPos) < 5) pos.multiplyScalar(-0.8)
    const enemy = new Enemy(type, pos, scene)
    enemy.aggression = design.aggression
    enemies.push(enemy)
  })
  return enemies
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
