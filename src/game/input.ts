import * as THREE from 'three'

export class Input {
  private keys = new Set<string>()
  private mouseNdc = new THREE.Vector2()
  private ray = new THREE.Raycaster()
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  /** 마우스가 가리키는 지면(XZ) 위치 */
  aimPoint = new THREE.Vector3()
  meleePressed = false
  rangedHeld = false

  constructor(private camera: THREE.Camera) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.keys.add(e.code)
    })
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('mousemove', (e) => {
      this.mouseNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
    })
    addEventListener('mousedown', (e) => {
      if (e.button === 0) this.meleePressed = true
      if (e.button === 2) this.rangedHeld = true
    })
    addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rangedHeld = false
    })
    addEventListener('contextmenu', (e) => e.preventDefault())
    addEventListener('blur', () => this.keys.clear())
  }

  /** WASD → 월드 XZ 방향 (정규화, 입력 없으면 0벡터) */
  moveDir(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0)
    if (this.keys.has('KeyW')) out.z -= 1
    if (this.keys.has('KeyS')) out.z += 1
    if (this.keys.has('KeyA')) out.x -= 1
    if (this.keys.has('KeyD')) out.x += 1
    return out.lengthSq() > 0 ? out.normalize() : out
  }

  get dashPressed(): boolean {
    return this.keys.has('Space') || this.keys.has('ShiftLeft')
  }

  /** 키보드 대체 공격 (마우스 없는 환경) */
  get meleeKeyHeld(): boolean {
    return this.keys.has('KeyJ')
  }
  get rangedKeyHeld(): boolean {
    return this.keys.has('KeyK')
  }

  updateAim(): void {
    this.ray.setFromCamera(this.mouseNdc, this.camera)
    this.ray.ray.intersectPlane(this.ground, this.aimPoint)
  }

  /** 프레임 끝에서 1회성 입력 소거 */
  endFrame(): void {
    this.meleePressed = false
  }
}
