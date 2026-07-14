import * as THREE from 'three'
import { ARENA_RADIUS } from './config'

/** 씬·카메라·렌더러·아레나 지오메트리 — 게임 로직과 무관한 표시 계층 */
export class World {
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  private camOffset = new THREE.Vector3(0, 26, 14)
  private camTarget = new THREE.Vector3()

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.scene.background = new THREE.Color(0x0a0b0f)
    this.scene.fog = new THREE.Fog(0x0a0b0f, 40, 90)

    this.camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200)
    this.camera.position.copy(this.camOffset)
    this.camera.lookAt(0, 0, 0)

    this.buildLights()
    this.buildArena()

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(innerWidth, innerHeight)
    })
  }

  private buildLights(): void {
    this.scene.add(new THREE.AmbientLight(0x334, 1.2))
    const key = new THREE.DirectionalLight(0xfff4e0, 2.2)
    key.position.set(14, 30, 8)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    const s = ARENA_RADIUS + 4
    key.shadow.camera.left = -s
    key.shadow.camera.right = s
    key.shadow.camera.top = s
    key.shadow.camera.bottom = -s
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0x7dd3fc, 0.6)
    rim.position.set(-10, 12, -16)
    this.scene.add(rim)
  }

  private buildArena(): void {
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS + 0.6, 0.6, 64),
      new THREE.MeshStandardMaterial({ color: 0x181a22, roughness: 0.85 }),
    )
    floor.position.y = -0.3
    floor.receiveShadow = true
    this.scene.add(floor)

    const ringGeo = new THREE.TorusGeometry(ARENA_RADIUS, 0.12, 8, 96)
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
    )
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.05
    this.scene.add(ring)

    const grid = new THREE.PolarGridHelper(ARENA_RADIUS, 12, 6, 64, 0x2a2d3a, 0x22242e)
    grid.position.y = 0.02
    this.scene.add(grid)
  }

  /** 플레이어를 부드럽게 추적하는 카메라 */
  followCamera(target: THREE.Vector3, dt: number): void {
    this.camTarget.lerp(target, Math.min(1, dt * 4))
    this.camera.position.copy(this.camTarget).add(this.camOffset)
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z)
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }
}
