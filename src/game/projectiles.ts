import * as THREE from 'three'
import { ARENA_RADIUS } from './config'

export interface Projectile {
  mesh: THREE.Mesh
  pos: THREE.Vector3
  vel: THREE.Vector3
  radius: number
  damage: number
  fromPlayer: boolean
  dead: boolean
}

const playerGeo = new THREE.SphereGeometry(0.18, 8, 8)
const enemyGeo = new THREE.SphereGeometry(0.24, 8, 8)
const playerMat = new THREE.MeshBasicMaterial({ color: 0xa5f3fc })
const enemyMat = new THREE.MeshBasicMaterial({ color: 0xf0abfc })

export class ProjectilePool {
  list: Projectile[] = []

  constructor(private scene: THREE.Scene) {}

  spawn(pos: THREE.Vector3, dir: THREE.Vector3, speed: number, damage: number, fromPlayer: boolean): void {
    const mesh = new THREE.Mesh(fromPlayer ? playerGeo : enemyGeo, fromPlayer ? playerMat : enemyMat)
    mesh.position.copy(pos).setY(0.9)
    this.scene.add(mesh)
    this.list.push({
      mesh,
      pos: pos.clone(),
      vel: dir.clone().normalize().multiplyScalar(speed),
      radius: fromPlayer ? 0.18 : 0.24,
      damage,
      fromPlayer,
      dead: false,
    })
  }

  update(dt: number): void {
    for (const p of this.list) {
      if (p.dead) continue
      p.pos.addScaledVector(p.vel, dt)
      p.mesh.position.copy(p.pos).setY(0.9)
      if (p.pos.length() > ARENA_RADIUS + 1) p.dead = true
    }
    this.sweep()
  }

  private sweep(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]
      if (p.dead) {
        this.scene.remove(p.mesh)
        this.list.splice(i, 1)
      }
    }
  }

  clear(): void {
    for (const p of this.list) this.scene.remove(p.mesh)
    this.list.length = 0
  }
}
