import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { ARENA_RADIUS } from './config'

/** 씬·카메라·렌더러·아레나 지오메트리 — 게임 로직과 무관한 표시 계층 */
export class World {
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  private composer: EffectComposer
  private camOffset = new THREE.Vector3(0, 19, 11)
  private camTarget = new THREE.Vector3()
  private ring!: THREE.Mesh
  private time = 0
  /**
   * 블룸 기본 OFF — 강하면 적 모델(밝은 흰 부분)을 하얗게 태워 형체가 사라짐(실측).
   * 배경 발광은 환경맵 + 링 emissive로 충분. ?bloom 으로만 켜는 실험 옵션으로 격하.
   */
  private useBloom = new URLSearchParams(location.search).has('bloom')
  private noRender = new URLSearchParams(location.search).has('norender')

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    // 필름 톤매핑 — 발광부는 부드럽게 말리고 중간톤 대비가 살아남 (플랫한 로우폴리 인상 탈출의 1순위)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene.background = new THREE.Color(0x07080c)
    this.scene.fog = new THREE.Fog(0x07080c, 40, 95)

    // 환경맵 — 금속 재질(metalness)이 반사할 소스. 없으면 금속 모델이 새까맣게 렌더된다.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

    this.camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200)
    this.camera.position.copy(this.camOffset)
    this.camera.lookAt(0, 0, 0)

    // 네온 발광 — 아주 밝은 픽셀(링 네온 등)만 은은히 번짐.
    // strength/threshold를 약하게: 과하면 적 모델까지 하얗게 태워 형체가 사라진다(실측).
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.4, 0.92)
    this.composer.addPass(bloom)

    this.buildLights()
    this.buildArena()

    // 검증용: 렌더 런타임 토글 (norender로 고속 진행 → 순간 렌더 → 스크린샷)
    ;(window as unknown as Record<string, unknown>).__setNoRender = (v: boolean) => {
      this.noRender = v
    }

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(innerWidth, innerHeight)
      this.composer.setSize(innerWidth, innerHeight)
    })
  }

  private buildLights(): void {
    // 반구광: 하늘(차가운 청회색)→바닥(따뜻한 암갈색) 그라디언트 — 균일 앰비언트보다 입체가 살아남
    this.scene.add(new THREE.HemisphereLight(0x8fa3c7, 0x241a12, 0.95))
    const key = new THREE.DirectionalLight(0xfff0dd, 2.4)
    key.position.set(14, 30, 8)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.bias = -0.0004
    const s = ARENA_RADIUS + 4
    key.shadow.camera.left = -s
    key.shadow.camera.right = s
    key.shadow.camera.top = s
    key.shadow.camera.bottom = -s
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0x38bdf8, 0.7)
    rim.position.set(-10, 12, -16)
    this.scene.add(rim)
  }

  /** 중앙이 밝고 가장자리로 어두워지는 방사 그라디언트 — 유닛 대비 확보 + 시선 유도 */
  private makeFloorTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = c.height = 512
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(256, 256, 40, 256, 256, 256)
    g.addColorStop(0, '#1d2333')
    g.addColorStop(0.55, '#12161f')
    g.addColorStop(1, '#080a10')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 512, 512)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private buildArena(): void {
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS + 0.8, 0.8, 96),
      new THREE.MeshStandardMaterial({ map: this.makeFloorTexture(), roughness: 0.75, metalness: 0.15 }),
    )
    floor.position.y = -0.4
    floor.receiveShadow = true
    this.scene.add(floor)

    // 외곽 링 — 시안 네온 (블룸 대상)
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(ARENA_RADIUS, 0.14, 12, 128),
      new THREE.MeshStandardMaterial({
        color: 0x0a2733,
        emissive: 0x22d3ee,
        emissiveIntensity: 3.6,
      }),
    )
    this.ring.rotation.x = Math.PI / 2
    this.ring.position.y = 0.06
    this.scene.add(this.ring)

    // 내부 링 2개 — 은은한 가이드
    for (const [r, opacity] of [
      [ARENA_RADIUS * 0.62, 0.35],
      [ARENA_RADIUS * 0.28, 0.25],
    ] as const) {
      const guide = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.05, 8, 96),
        new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity }),
      )
      guide.rotation.x = Math.PI / 2
      guide.position.y = 0.03
      this.scene.add(guide)
    }

    const grid = new THREE.PolarGridHelper(ARENA_RADIUS, 16, 6, 96, 0x1b2030, 0x161a26)
    grid.position.y = 0.02
    this.scene.add(grid)
    // (중앙 부유 코어 제거 — 정체 불명 장식이라 혼란. 오버마인드 존재감은 조롱 대사·리포트·
    //  아레나 링 색(mood)으로 전달하고, 보스는 상공에서 독립 강림한다.)
  }

  /** 플레이어를 부드럽게 추적하는 카메라 + 환경 애니메이션 */
  followCamera(target: THREE.Vector3, dt: number): void {
    this.time += dt
    this.camTarget.lerp(target, Math.min(1, dt * 4))
    this.camera.position.copy(this.camTarget).add(this.camOffset)
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z)

    const ringMat = this.ring.material as THREE.MeshStandardMaterial
    ringMat.emissiveIntensity = 3.4 + Math.sin(this.time * 2.1) * 0.7
  }

  /** (보스 강림은 독립 처리 — 코어 제거로 no-op 유지, 호출부 호환용) */
  setCoreVisible(_visible: boolean): void {}

  /** 오버마인드의 감정 상태 → 아레나 링 색 (confident 시안 / angry 적 / playful 초록 / desperate 보라) */
  setMood(mood: 'confident' | 'angry' | 'playful' | 'desperate'): void {
    const colors = { confident: 0x22d3ee, angry: 0xdc2626, playful: 0x4ade80, desperate: 0xa855f7 }
    ;(this.ring.material as THREE.MeshStandardMaterial).emissive.setHex(colors[mood])
  }

  /** 초반 실측 fps가 낮으면 Game이 호출 — 블룸 없이 기본 렌더로 전환 */
  disableBloom(): void {
    this.useBloom = false
  }

  render(): void {
    // ?norender — 헤드리스 로직 검증용 (소프트웨어 GL 렌더 병목 회피)
    if (this.noRender) return
    if (this.useBloom) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }
}
