import * as THREE from 'three'

/** 터치 기기 여부 — 모바일은 가상 조이스틱 + 자동 조준/공격 */
export const IS_TOUCH = matchMedia('(pointer: coarse)').matches

export class Input {
  private keys = new Set<string>()
  private mouseNdc = new THREE.Vector2()
  private ray = new THREE.Raycaster()
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  /** 마우스가 가리키는 지면(XZ) 위치 */
  aimPoint = new THREE.Vector3()
  meleePressed = false
  rangedHeld = false

  // ── 터치 조이스틱 상태 ──
  private joyId: number | null = null
  private joyOrigin = new THREE.Vector2()
  private joyVector = new THREE.Vector2() // -1..1
  private touchDashRequested = false

  constructor(private camera: THREE.Camera) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.keys.add(e.code)
    })
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('mousemove', (e) => {
      this.mouseNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
    })
    // 슈터 관습: 좌클릭 = 원거리 주력(연사), 우클릭 = 근접(고위험 고보상)
    addEventListener('mousedown', (e) => {
      if (e.button === 0) this.rangedHeld = true
      if (e.button === 2) this.meleePressed = true
    })
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.rangedHeld = false
    })
    addEventListener('contextmenu', (e) => e.preventDefault())
    addEventListener('blur', () => this.keys.clear())

    if (IS_TOUCH) this.bindTouch()
  }

  /**
   * 왼쪽 절반 = 이동 조이스틱 (터치 시작점이 스틱 원점),
   * 오른쪽 절반 탭 = 대시. 조준·공격은 자동(게임이 최근접 적 대상).
   */
  private bindTouch(): void {
    const joyBase = document.getElementById('joy-base')!
    const joyKnob = document.getElementById('joy-knob')!
    const MAX_R = 56

    addEventListener(
      'touchstart',
      (e) => {
        // 오버레이(START/RETRY 버튼 등) 위 터치는 게임 입력으로 먹지 않음
        if ((e.target as HTMLElement).closest('#screen')) return
        for (const t of e.changedTouches) {
          if (t.clientX < innerWidth / 2 && this.joyId === null) {
            this.joyId = t.identifier
            this.joyOrigin.set(t.clientX, t.clientY)
            joyBase.style.left = `${t.clientX}px`
            joyBase.style.top = `${t.clientY}px`
            joyBase.classList.remove('hidden')
          } else {
            this.touchDashRequested = true
          }
        }
        e.preventDefault()
      },
      { passive: false },
    )
    addEventListener(
      'touchmove',
      (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier !== this.joyId) continue
          const dx = t.clientX - this.joyOrigin.x
          const dy = t.clientY - this.joyOrigin.y
          const len = Math.hypot(dx, dy)
          const clamped = Math.min(len, MAX_R)
          const nx = len > 0 ? dx / len : 0
          const ny = len > 0 ? dy / len : 0
          this.joyVector.set((nx * clamped) / MAX_R, (ny * clamped) / MAX_R)
          joyKnob.style.transform = `translate(${nx * clamped}px, ${ny * clamped}px)`
        }
        e.preventDefault()
      },
      { passive: false },
    )
    const endTouch = (e: TouchEvent): void => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.joyId) {
          this.joyId = null
          this.joyVector.set(0, 0)
          joyKnob.style.transform = 'translate(0,0)'
          joyBase.classList.add('hidden')
        }
      }
    }
    addEventListener('touchend', endTouch)
    addEventListener('touchcancel', endTouch)
  }

  /** WASD/조이스틱 → 월드 XZ 방향 (정규화, 입력 없으면 0벡터) */
  moveDir(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0)
    if (this.joyVector.lengthSq() > 0.04) {
      out.set(this.joyVector.x, 0, this.joyVector.y)
      return out.normalize()
    }
    if (this.keys.has('KeyW')) out.z -= 1
    if (this.keys.has('KeyS')) out.z += 1
    if (this.keys.has('KeyA')) out.x -= 1
    if (this.keys.has('KeyD')) out.x += 1
    return out.lengthSq() > 0 ? out.normalize() : out
  }

  get dashPressed(): boolean {
    if (this.touchDashRequested) return true
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
    this.touchDashRequested = false
  }
}
