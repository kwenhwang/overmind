import mitt from 'mitt'
import type * as THREE from 'three'

/** 엔티티 내부 → 연출 계층(사운드·이펙트)으로 흐르는 게임 이벤트 */
export type GameEvents = {
  lungeWarn: { pos: THREE.Vector3 }
  spitterShot: { pos: THREE.Vector3 }
}

export const events = mitt<GameEvents>()
