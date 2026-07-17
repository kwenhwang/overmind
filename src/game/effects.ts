import * as THREE from 'three'

interface Particle {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  life: number
  maxLife: number
  /** 고스트류 — 중력·이동 없이 제자리에서 페이드 */
  still?: boolean
}

interface ArcFx {
  mesh: THREE.Mesh
  life: number
}

const particleGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16)

/**
 * 타격감 계층: 파티클·데미지 숫자·화면 흔들림·히트스톱·근접 궤적.
 * 게임 로직과 분리 — 어디서든 이벤트처럼 호출.
 */
export class Effects {
  private particles: Particle[] = []
  private arcs: ArcFx[] = []
  private shakeAmp = 0
  /** 히트스톱 잔여 시간(초) — Game이 dt에 곱할 배율을 조회 */
  private hitstopTimer = 0
  private numbersRoot: HTMLDivElement

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    this.numbersRoot = document.getElementById('numbers') as HTMLDivElement
  }

  /** 사망·타격 파편 */
  burst(pos: THREE.Vector3, color: number, count = 10, speed = 7): void {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(
        particleGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending }),
      )
      mesh.position.copy(pos).setY(0.9)
      const angle = Math.random() * Math.PI * 2
      const up = 2 + Math.random() * 4
      this.scene.add(mesh)
      this.particles.push({
        mesh,
        vel: new THREE.Vector3(
          Math.cos(angle) * speed * (0.4 + Math.random() * 0.6),
          up,
          Math.sin(angle) * speed * (0.4 + Math.random() * 0.6),
        ),
        life: 0.5 + Math.random() * 0.3,
        maxLife: 0.8,
      })
    }
  }

  private lastGhostAt = 0

  /** 대시 잔상 — 짧게 사라지는 발광 고스트 (매 프레임 호출해도 내부 스로틀) */
  dashGhost(pos: THREE.Vector3, color = 0x4ade80): void {
    const now = performance.now()
    if (now - this.lastGhostAt < 35) return
    this.lastGhostAt = now
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45 }),
    )
    mesh.position.copy(pos).setY(0.9)
    this.scene.add(mesh)
    this.particles.push({ mesh, vel: new THREE.Vector3(), life: 0.22, maxLife: 0.44, still: true })
  }

  /** 총구 섬광 — 사격 순간 짧고 밝은 발광 (가산, 작게 — 플레이어 위라 크면 washout) */
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, color = 0xfff1a8): void {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending }),
    )
    mesh.position.copy(pos).addScaledVector(dir, 1.0).setY(0.9)
    this.scene.add(mesh)
    this.particles.push({ mesh, vel: new THREE.Vector3(), life: 0.07, maxLife: 0.14, still: true })
  }

  /** 근접 휘두름 — 전방 부채꼴 잔상 */
  meleeArc(pos: THREE.Vector3, facing: THREE.Vector3, range: number, arcDeg: number): void {
    const geo = new THREE.RingGeometry(range * 0.35, range, 24, 1, 0, (arcDeg * Math.PI) / 180)
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xd9f99d,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      }),
    )
    mesh.rotation.x = -Math.PI / 2
    // RingGeometry의 0도(+X)를 facing 중심으로 회전
    mesh.rotation.z = Math.atan2(-facing.z, facing.x) - ((arcDeg / 2) * Math.PI) / 180
    mesh.position.copy(pos).setY(0.5)
    this.scene.add(mesh)
    this.arcs.push({ mesh, life: 0.14 })
  }

  /** 떠오르는 데미지 숫자 (DOM — 저사양에서도 선명) */
  damageNumber(worldPos: THREE.Vector3, text: string, cls = ''): void {
    const v = worldPos.clone().setY(1.6).project(this.camera)
    if (v.z > 1) return
    const el = document.createElement('div')
    el.className = `dmg ${cls}`
    el.textContent = text
    el.style.left = `${((v.x + 1) / 2) * innerWidth}px`
    el.style.top = `${((1 - v.y) / 2) * innerHeight}px`
    this.numbersRoot.appendChild(el)
    setTimeout(() => el.remove(), 750)
  }

  shake(strength: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, strength)
  }

  hitstop(seconds = 0.06): void {
    this.hitstopTimer = Math.max(this.hitstopTimer, seconds)
  }

  /** Game이 매 프레임 호출 — 히트스톱 중이면 전투 dt에 곱할 배율 반환 */
  timeScale(realDt: number): number {
    if (this.hitstopTimer > 0) {
      this.hitstopTimer -= realDt
      return 0.08
    }
    return 1
  }

  /** 카메라 흔들림 오프셋 — World.followCamera 뒤에 적용 */
  applyShake(camera: THREE.Camera, dt: number): void {
    if (this.shakeAmp <= 0.001) return
    camera.position.x += (Math.random() - 0.5) * this.shakeAmp
    camera.position.z += (Math.random() - 0.5) * this.shakeAmp
    this.shakeAmp *= Math.max(0, 1 - dt * 9)
  }

  update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.life -= dt
      if (p.life <= 0) {
        this.scene.remove(p.mesh)
        this.particles.splice(i, 1)
        continue
      }
      if (!p.still) {
        p.vel.y -= 18 * dt
        p.mesh.position.addScaledVector(p.vel, dt)
        if (p.mesh.position.y < 0.1) {
          p.mesh.position.y = 0.1
          p.vel.y = Math.abs(p.vel.y) * 0.4
        }
      }
      ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, p.life / (p.maxLife * 0.5))
    }
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i]
      a.life -= dt
      if (a.life <= 0) {
        this.scene.remove(a.mesh)
        this.arcs.splice(i, 1)
        continue
      }
      ;(a.mesh.material as THREE.MeshBasicMaterial).opacity = a.life / 0.14
    }
  }

  clear(): void {
    for (const p of this.particles) this.scene.remove(p.mesh)
    for (const a of this.arcs) this.scene.remove(a.mesh)
    this.particles.length = 0
    this.arcs.length = 0
    this.numbersRoot.innerHTML = ''
  }
}
