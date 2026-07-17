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
): SpawnPlan[] {
  const flat: { type: EnemyType; modifiers: Modifier[] }[] = []
  for (const s of design.spawns)
    for (let i = 0; i < s.count; i++) flat.push({ type: s.type, modifiers: s.modifiers ?? [] })

  const baseAngle = biasAngle(design.spawnBias)
  // 방향 편향은 좁게 뭉쳐야 "그쪽이 막혔다"가 읽힘 (기존 72° → 50°)
  const spread = design.spawnBias === 'surround' ? Math.PI * 2 : Math.PI / 3.6

  return flat.map(({ type, modifiers }, i) => {
    const t = flat.length > 1 ? i / (flat.length - 1) : 0.5
    const angle = baseAngle + (t - 0.5) * spread + (Math.random() - 0.5) * 0.2
    // 플레이어 기준 상대 링(9~13)에 스폰 → 카메라 시야 안에 확실히 들어옴.
    // (기존: 아레나 절대좌표라 플레이어 반대편 적이 화면 밖으로 사라졌음)
    const dist = 7 + Math.random() * 3.5
    const pos = new THREE.Vector3(
      playerPos.x + Math.cos(angle) * dist,
      0,
      playerPos.z + Math.sin(angle) * dist,
    )
    // 아레나 경계 안으로 클램프
    const r = pos.length()
    if (r > ARENA_RADIUS - 1.5) pos.multiplyScalar((ARENA_RADIUS - 1.5) / r)
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

/**
 * 스폰 편향 → 월드 각도. 카메라가 고정 탑다운이라 화면 절대 방향으로 고정:
 * 월드 -X = 화면 왼쪽(A키), +X = 오른쪽, -Z = 화면 위(먼 쪽), +Z = 화면 아래(가까운 쪽).
 * 텔레메트리(회피 방향)도 같은 기준이라 "왼쪽 회피 → 왼쪽 스폰"이 플레이어 체감과 일치한다.
 * (기존 버그: 조준 방향 기준이라 마우스로 계속 회전 → 편향이 매 순간 뒤집혔음)
 */
function biasAngle(bias: WaveDesign['spawnBias']): number {
  switch (bias) {
    case 'left':
      return Math.PI // 화면 왼쪽 (-X)
    case 'right':
      return 0 // 화면 오른쪽 (+X)
    case 'front':
      return -Math.PI / 2 // 화면 위 (-Z)
    case 'behind':
      return Math.PI / 2 // 화면 아래 (+Z)
    case 'surround':
      return 0 // 전방위 (spread=2π라 시작각 무관)
  }
}
