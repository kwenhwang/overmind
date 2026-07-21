import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { ARENA_RADIUS } from './config'

/** 씬·카메라·렌더러·아레나 지오메트리 — 게임 로직과 무관한 표시 계층 */
export class World {
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  /** 선택적 블룸: 블룸 레이어 객체만 발광 버퍼에 렌더 → 유닛 몸통은 안 탐 */
  private static readonly BLOOM_LAYER = 1
  private bloomComposer!: EffectComposer
  private finalComposer!: EffectComposer
  private baseOffset = new THREE.Vector3(0, 19, 11)
  private camOffset = new THREE.Vector3(0, 19, 11)
  private camTarget = new THREE.Vector3()
  private ring!: THREE.Mesh
  /** 반응형 바닥 오버레이 (가산 발광 에너지 그리드 + 파동) */
  private fxMat!: THREE.ShaderMaterial
  /** 활성 파동 — 대시·타격·강림이 만든 물결 (월드 XZ, 경과시간) */
  private ripples: { x: number; z: number; t: number }[] = []
  private moodColor = new THREE.Color(0x22d3ee)
  /** 공중 부유 먼지 — 분위기(살아있는 공간감). 느린 상승 + 래핑 */
  private motes!: THREE.Points
  private moteVel!: Float32Array
  private time = 0
  /**
   * 후처리(블룸+그레이딩+비네트+그레인+색수차) 기본 ON — 발광 요소(림·링·바닥·파티클)를
   * 네온으로 살리는 프로 룩의 핵심. 블룸은 threshold 높게(밝은 것만) 튜닝해 적 모델이
   * 하얗게 타지 않게. 저사양 자동 비활성(disableBloom) + ?nobloom 탈출구.
   */
  // 후처리 기본 ON, 단 터치기기(모바일/태블릿)는 OFF — 선택적 블룸의 float 렌더타깃·
  // 커스텀 셰이더가 모바일 GPU에서 깨지거나 이상하게 렌더되는 사례 대응(안전 우선).
  private usePost =
    !new URLSearchParams(location.search).has('nobloom') &&
    !('ontouchstart' in window || navigator.maxTouchPoints > 0)
  private gradePass!: ShaderPass
  private noRender = new URLSearchParams(location.search).has('norender')

  constructor(canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer: 진단 캡처(toDataURL)가 검은 화면이 아닌 실제 프레임을 담게 함
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap // 부드러운 접지 그림자 (PCF→PCFSoft)
    // 필름 톤매핑 — 발광부는 부드럽게 말리고 중간톤 대비가 살아남 (플랫한 로우폴리 인상 탈출의 1순위)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.98 // 블룸과 합쳐 흰 blowout 방지 (기존 1.05)

    this.scene.background = this.makeSkyGradient() // 단색 대신 은은한 상하 그라디언트 (공간감·깊이)
    this.scene.fog = new THREE.Fog(0x07080c, 40, 95)

    // 환경맵 — 금속 재질(metalness)이 반사할 소스. 없으면 금속 모델이 새까맣게 렌더된다.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

    this.camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200)
    this.camera.position.copy(this.camOffset)
    this.camera.lookAt(0, 0, 0)

    // ── 선택적 블룸: 블룸 레이어(링·에너지 바닥·파티클)만 발광 버퍼에 렌더 ──
    // 카메라가 블룸 레이어만 볼 때 렌더 → 유닛 몸통(레이어0만)은 검게 빠져 안 탐(blowout 방지).
    const renderScene = new RenderPass(this.scene, this.camera)
    this.bloomComposer = new EffectComposer(this.renderer)
    this.bloomComposer.renderToScreen = false
    this.bloomComposer.addPass(renderScene)
    this.bloomComposer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.6, 0.0))

    // 합성 패스: 원본 씬(tDiffuse) + 블룸 버퍼를 가산
    const mixPass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null }, uBloom: { value: this.bloomComposer.renderTarget2.texture } },
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D uBloom; varying vec2 vUv;
          void main(){ gl_FragColor = texture2D(tDiffuse, vUv) + texture2D(uBloom, vUv); }`,
      }),
      'tDiffuse',
    )

    // 그레이드: 색보정 + 비네트 + 그레인 + 색수차
    this.gradePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(innerWidth, innerHeight) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          vec2 uv = vUv;
          vec2 c = uv - 0.5;
          float d = dot(c, c);
          vec2 off = c * d * 0.09; // 색수차 (은은하게 — 강하면 밝은 요소에 무지개 프린지)
          vec3 col;
          col.r = texture2D(tDiffuse, uv - off).r;
          col.g = texture2D(tDiffuse, uv).g;
          col.b = texture2D(tDiffuse, uv + off).b;
          col = (col - 0.5) * 1.06 + 0.5; // 대비
          float l = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(vec3(l), col, 1.1); // 채도
          col += vec3(0.015, 0.0, -0.02) * (0.5 - l); // 청록 그림자/따뜻한 하이라이트
          float vig = smoothstep(1.15, 0.4, d * 1.6); // 비네트
          col *= mix(0.78, 1.0, vig);
          col += hash(uv * uRes + uTime) * 0.035 - 0.0175; // 그레인
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })

    this.finalComposer = new EffectComposer(this.renderer)
    this.finalComposer.addPass(renderScene)
    this.finalComposer.addPass(mixPass)
    this.finalComposer.addPass(this.gradePass)
    // 포스트-AA: 하드웨어 MSAA는 합성 결과(블룸·그레이드)를 커버 못 해 네온 엣지가 지글거림 →
    // 최종 결과에 SMAA 1패스. 무인자 생성자(자체 사이징)라 finalComposer.setSize가 resize를 전파.
    this.finalComposer.addPass(new SMAAPass())

    this.buildLights()
    this.buildArena()

    // 검증용: 렌더 런타임 토글 (norender로 고속 진행 → 순간 렌더 → 스크린샷)
    ;(window as unknown as Record<string, unknown>).__setNoRender = (v: boolean) => {
      this.noRender = v
    }

    addEventListener('resize', () => this.applyViewport())
    this.applyViewport()
  }

  /**
   * 종횡비 대응 — 세로가 납작한 창(예: 1518x466)에서 카메라 세로 시야가 좁아
   * 적이 위아래로 잘려 안 보이던 문제 해결. 납작할수록 카메라를 뒤로 물려 세로 확보.
   */
  /** 은은한 상하 그라디언트 하늘 — near-black 톤만 써 포그(0x07080c)와 이음새 없이 깊이감만 더한다. */
  private makeSkyGradient(): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 4
    c.height = 256
    const g = c.getContext('2d')!
    const grd = g.createLinearGradient(0, 0, 0, 256)
    grd.addColorStop(0, '#05060a') // 상단(먼 쪽) 가장 어둡게
    grd.addColorStop(0.55, '#080b12')
    grd.addColorStop(1, '#0b131d') // 하단(가까운 쪽) 살짝 청록 네이비
    g.fillStyle = grd
    g.fillRect(0, 0, 4, 256)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private applyViewport(): void {
    const aspect = innerWidth / innerHeight
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(innerWidth, innerHeight)
    if (this.bloomComposer) this.bloomComposer.setSize(innerWidth, innerHeight)
    if (this.finalComposer) this.finalComposer.setSize(innerWidth, innerHeight)
    if (this.gradePass) (this.gradePass.uniforms.uRes.value as THREE.Vector2).set(innerWidth, innerHeight)
    // 기준 16:9보다 납작하면(가로로 길면) 거리 스케일 ↑ (상한 2.4배)
    const scale = Math.min(2.4, Math.max(1, aspect / 1.78))
    this.camOffset.copy(this.baseOffset).multiplyScalar(scale)
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
    this.ring.layers.enable(World.BLOOM_LAYER) // 네온 링 → 블룸
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
      guide.layers.enable(World.BLOOM_LAYER) // 가이드 링 → 블룸
      this.scene.add(guide)
    }

    // 반응형 발광 오버레이 — 기존 바닥(그림자 수신) 위에 가산 블렌딩. 에너지 그리드가
    // 대시·타격·강림에 물결로 반응 → 화면의 큰 면적이 '살아있게'. (PolarGridHelper 대체)
    this.buildFxFloor()
    this.buildMotes()
    // (중앙 부유 코어 제거 — 정체 불명 장식이라 혼란. 오버마인드 존재감은 조롱 대사·리포트·
    //  아레나 링 색(mood)으로 전달하고, 보스는 상공에서 독립 강림한다.)
  }

  private static readonly MAX_RIPPLES = 10

  private buildFxFloor(): void {
    const disc = new THREE.CircleGeometry(ARENA_RADIUS, 120)
    this.fxMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: this.moodColor },
        uPlayer: { value: new THREE.Vector2(0, 0) },
        uRadius: { value: ARENA_RADIUS },
        uRipplePos: { value: Array.from({ length: World.MAX_RIPPLES }, () => new THREE.Vector2(0, 0)) },
        uRippleAge: { value: new Array(World.MAX_RIPPLES).fill(-1) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        #define MAXR ${World.MAX_RIPPLES}
        varying vec3 vWorld;
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec2 uPlayer;
        uniform float uRadius;
        uniform vec2 uRipplePos[MAXR];
        uniform float uRippleAge[MAXR];
        // 얇은 발광 라인 (반복 좌표 t를 0/1 근처에서 밝게)
        float line(float t, float w) {
          float f = abs(fract(t) - 0.5);
          return smoothstep(0.5, 0.5 - w, f);
        }
        void main() {
          vec2 p = vWorld.xz;
          float r = length(p);
          float ang = atan(p.y, p.x);
          float edgeFade = smoothstep(uRadius, uRadius * 0.9, r); // 경계 안쪽만
          // 극좌표 에너지 그리드: 동심원 + 방사선
          float rings = line(r / 3.0 - uTime * 0.06, 0.06);
          float spokes = line(ang / 6.2831853 * 24.0, 0.02) * smoothstep(0.0, 6.0, r);
          float grid = max(rings * 0.55, spokes * 0.35);
          // 중앙 코어 글로우 + 느린 맥동
          float core = exp(-r * 0.28) * (0.6 + 0.4 * sin(uTime * 1.5));
          // 플레이어 발밑 은은한 후광
          float pl = exp(-distance(p, uPlayer) * 0.9) * 0.5;
          // 파동 — 확장하는 밝은 링
          float ripple = 0.0;
          for (int i = 0; i < MAXR; i++) {
            float age = uRippleAge[i];
            if (age < 0.0) continue;
            float d = distance(p, uRipplePos[i]);
            float rad = age * 11.0;
            float band = exp(-abs(d - rad) * 1.6);
            ripple += band * (1.0 - clamp(age / 1.2, 0.0, 1.0));
          }
          float glow = (grid + core + pl + ripple * 0.6) * edgeFade;
          glow = min(glow, 0.85); // 과포화 방지 (겹친 파동이 하얗게 타는 것 차단)
          vec3 col = uColor * glow;
          gl_FragColor = vec4(col, clamp(glow, 0.0, 1.0));
        }
      `,
    })
    const mesh = new THREE.Mesh(disc, this.fxMat)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = 0.04
    mesh.renderOrder = 1
    // 바닥은 블룸 레이어에서 제외 — 면적이 커서 블룸하면 화면 전체가 발광 덩어리가 됨.
    // 자체 가산 블렌딩으로 은은히 빛나고, 블룸은 얇은 네온 링에만.
    this.scene.add(mesh)
  }

  /** 공중 부유 먼지 — 분위기용 발광 입자. 아레나 내 랜덤 배치, 느리게 상승·표류하며 래핑 */
  private buildMotes(): void {
    const N = 90
    const pos = new Float32Array(N * 3)
    this.moteVel = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * ARENA_RADIUS
      pos[i * 3] = Math.cos(a) * r
      pos[i * 3 + 1] = Math.random() * 12
      pos[i * 3 + 2] = Math.sin(a) * r
      this.moteVel[i * 3] = (Math.random() - 0.5) * 0.3
      this.moteVel[i * 3 + 1] = 0.3 + Math.random() * 0.5
      this.moteVel[i * 3 + 2] = (Math.random() - 0.5) * 0.3
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({
      color: 0x9fd8ff,
      size: 0.12,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
    this.motes = new THREE.Points(geo, mat)
    // 블룸 레이어 제외 — threshold 0 블룸 버퍼에서 카메라 앞 먼지가 플레이어 위로 발광 blob을 만듦.
    // 가산 블렌딩만으로도 충분히 반짝임.
    this.scene.add(this.motes)
  }

  /** 임팩트 파동 — 대시·타격·강림 등에서 호출 (월드 좌표) */
  ripple(pos: THREE.Vector3): void {
    // 가장 오래된(또는 비활성) 슬롯 재사용
    let slot = this.ripples.findIndex((r) => r.t < 0)
    if (this.ripples.length < World.MAX_RIPPLES) {
      this.ripples.push({ x: pos.x, z: pos.z, t: 0 })
    } else {
      if (slot < 0) {
        slot = 0
        for (let i = 1; i < this.ripples.length; i++) if (this.ripples[i].t > this.ripples[slot].t) slot = i
      }
      this.ripples[slot] = { x: pos.x, z: pos.z, t: 0 }
    }
  }

  /** 플레이어를 부드럽게 추적하는 카메라 + 환경 애니메이션 */
  followCamera(target: THREE.Vector3, dt: number): void {
    this.time += dt
    this.camTarget.lerp(target, Math.min(1, dt * 4))
    this.camera.position.copy(this.camTarget).add(this.camOffset)
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z)

    const ringMat = this.ring.material as THREE.MeshStandardMaterial
    ringMat.emissiveIntensity = 3.4 + Math.sin(this.time * 2.1) * 0.7

    // 반응형 바닥 uniform 갱신
    const u = this.fxMat.uniforms
    u.uTime.value = this.time
    ;(u.uPlayer.value as THREE.Vector2).set(target.x, target.z)
    const pos = u.uRipplePos.value as THREE.Vector2[]
    const age = u.uRippleAge.value as number[]
    for (let i = 0; i < World.MAX_RIPPLES; i++) {
      const rp = this.ripples[i]
      if (rp && rp.t >= 0) {
        rp.t += dt
        if (rp.t > 1.2) rp.t = -1
        pos[i].set(rp.x, rp.z)
        age[i] = rp.t
      } else {
        age[i] = -1
      }
    }

    // 부유 먼지 표류 + 상단 래핑
    const mp = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = mp.array as Float32Array
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += this.moteVel[i] * dt
      arr[i + 1] += this.moteVel[i + 1] * dt
      arr[i + 2] += this.moteVel[i + 2] * dt
      if (arr[i + 1] > 13) arr[i + 1] = 0 // 천장에서 바닥으로 순환
    }
    mp.needsUpdate = true
  }

  /** (보스 강림은 독립 처리 — 코어 제거로 no-op 유지, 호출부 호환용) */
  setCoreVisible(_visible: boolean): void {}

  /** 오버마인드의 감정 상태 → 아레나 링 색 (confident 시안 / angry 적 / playful 초록 / desperate 보라) */
  setMood(mood: 'confident' | 'angry' | 'playful' | 'desperate'): void {
    const colors = { confident: 0x22d3ee, angry: 0xdc2626, playful: 0x4ade80, desperate: 0xa855f7 }
    ;(this.ring.material as THREE.MeshStandardMaterial).emissive.setHex(colors[mood])
    this.moodColor.setHex(colors[mood]) // 반응형 바닥도 같은 감정색으로 물듦
  }

  /** 초반 실측 fps가 낮으면 Game이 호출 — 후처리 없이 기본 렌더로 전환 (저사양 심사 기기 대응) */
  disableBloom(): void {
    this.usePost = false
  }

  render(): void {
    // ?norender — 헤드리스 로직 검증용 (소프트웨어 GL 렌더 병목 회피)
    if (this.noRender) return
    if (this.usePost) {
      this.gradePass.uniforms.uTime.value = this.time
      // 1) 블룸 버퍼 — 카메라가 블룸 레이어만 보게 하고 배경은 검게 (몸통·배경 blowout 차단)
      const bg = this.scene.background
      this.scene.background = null
      this.camera.layers.set(World.BLOOM_LAYER)
      this.bloomComposer.render()
      // 2) 최종 — 전체 씬 + 블룸 가산 + 그레이드
      this.camera.layers.set(0)
      this.scene.background = bg
      this.finalComposer.render()
    } else {
      this.renderer.render(this.scene, this.camera)
    }
  }

  /** 진단 썸네일 — 고해상도 태블릿 캔버스가 20MB 상한을 넘겨 전송 실패하던 문제 대응.
   *  최대 1280px 폭으로 축소 + JPEG로 항상 작게. */
  private captureThumb(): string {
    const src = this.renderer.domElement
    const scale = Math.min(1, 1280 / src.width)
    const w = Math.max(1, Math.round(src.width * scale))
    const h = Math.max(1, Math.round(src.height * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) return this.renderer.domElement.toDataURL('image/jpeg', 0.6)
    ctx.drawImage(src, 0, 0, w, h)
    return c.toDataURL('image/jpeg', 0.72)
  }

  /** 진단용 — 현재 화면(축소 JPEG) + 렌더러/기기 정보 */
  captureDiag(): { img: string; info: Record<string, unknown> } {
    const gl = this.renderer.getContext()
    const dbgExt = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      img: this.captureThumb(),
      info: {
        gpu: dbgExt ? gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) : 'unknown',
        glVersion: gl.getParameter(gl.VERSION),
        usePost: this.usePost,
        pixelRatio: this.renderer.getPixelRatio(),
        size: `${innerWidth}x${innerHeight}`,
        ua: navigator.userAgent,
      },
    }
  }
}
