import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js'

export type ModelName = 'player' | 'drone' | 'spitter' | 'brute' | 'boss'

interface ModelEntry {
  scene: THREE.Object3D
  animations: THREE.AnimationClip[]
}
const registry = new Map<ModelName, ModelEntry>()

/**
 * 유닛별 목표 시각 크기(수평 최대변) + 정면 회전(Y, 라디안).
 * CC0 외부 모델(Quaternius)은 크기·원점·정면이 제각각이라 로드 시 정규화한다.
 * 게임 코드는 원점=시각 중심, 정면 -Z 를 가정하므로 그에 맞춘다.
 */
/** 적 종류별 정체성 색 — CC0 모델이 전부 같은 황금 팔레트라 종류 구분이 안 됨.
 *  채도 높은(몸통) 머티리얼만 이 색으로 교체하고 회색·검정 디테일은 유지. */
const ENEMY_TINT: Partial<Record<ModelName, number>> = {
  // 적은 난색 계열로 통일 → 플레이어(핑크)와 확실히 분리. 서로는 명도/채도로 구분.
  drone: 0xe8402a, // 선명 빨강 — 돌격
  spitter: 0xf5c518, // 노랑 — 원거리 (보라는 플레이어 핑크와 헷갈려서 변경)
  brute: 0xe87a1a, // 주황 — 탱커
  boss: 0xb01010, // 암적 — 보스
}

/** 유닛별 림라이트(프레넬 외곽 발광) 색 — 어두운 아레나에서 실루엣을 띄우고 가시성을 확보.
 *  정체성 색의 밝은 버전. 셰이더 내부 계산이라 emissive 맵의 ANGLE 문제와 무관. */
const RIM_COLOR: Record<ModelName, number> = {
  player: 0xff6ab0, // 핑크
  drone: 0xff5a3a, // 빨강
  spitter: 0xffe14d, // 노랑
  brute: 0xffa040, // 주황
  boss: 0xff2f2f, // 적
}

/**
 * 프레넬 림라이트를 표준 머티리얼에 주입 (onBeforeCompile). 시야각에 스치는 외곽이
 * rimColor로 발광 → 로우폴리 실루엣이 살고 어두운 배경에서 확실히 분리된다.
 */
function addRim(mat: THREE.MeshStandardMaterial, hex: number): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: new THREE.Color(hex) }
    shader.fragmentShader =
      'uniform vec3 uRimColor;\n' +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `float _rim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.5);
         outgoingLight += uRimColor * _rim * 0.35;
         #include <opaque_fragment>`,
      )
  }
  mat.needsUpdate = true
}

/**
 * 발광 피크 상한 — glb 저작 강도(보스 눈동자 16·홍채 5)가 ACES 톤매핑에서 전부 1.0 근처로
 * 뭉개져 눈·장갑·궤도링의 형태 구분이 사라진다(제출 영상 36초의 '흰 덩어리'). 색조는 살리고
 * 강도만 낮춘다 — 채널 피크(=emissive의 최대 성분 × intensity)가 이 값을 넘지 않게.
 * 1.4 = ACES 후 약 0.86(선형) → 하이라이트로는 충분히 밝고 형태는 남는 지점.
 */
export const EMISSIVE_PEAK = 1.4

/** 머티리얼의 발광 채널 피크를 EMISSIVE_PEAK 이하로 (색조 보존, 강도만 축소) */
export function clampEmissive(mat: THREE.MeshStandardMaterial): void {
  const peak = Math.max(mat.emissive.r, mat.emissive.g, mat.emissive.b)
  if (peak <= 0) return
  mat.emissiveIntensity = Math.min(mat.emissiveIntensity, EMISSIVE_PEAK / peak)
}

/**
 * 게임과 업로드 뷰어가 공유하는 머티리얼 처리 — 로드 시·미리보기 시 동일한 룩 보장.
 * (metalness/roughness 정규화 + 종류별 tint + 플레이어 플랫핑크 + 프레넬 림)
 */
export function configureMaterial(mat: THREE.MeshStandardMaterial, name: ModelName): void {
  mat.metalness = Math.min(mat.metalness, 0.15)
  mat.roughness = Math.max(mat.roughness, 0.55)
  clampEmissive(mat)
  const tint = ENEMY_TINT[name]
  if (tint) {
    const hsl = { h: 0, s: 0, l: 0 }
    mat.color.getHSL(hsl)
    if (hsl.s > 0.25) mat.color.setHex(tint)
  }
  addRim(mat, RIM_COLOR[name])
}

export const NORMALIZE: Record<ModelName, { size: number; faceY: number }> = {
  player: { size: 2.8, faceY: 0 }, // Quaternius CC0 전투기: 노즈가 이미 -Z(전방)
  drone: { size: 2.2, faceY: 0 },
  spitter: { size: 2.5, faceY: 0 },
  brute: { size: 3.5, faceY: 0 },
  boss: { size: 6.5, faceY: 0 }, // 자체 절차 생성 '눈' 코어 (정면 -Z에 눈)
}

/**
 * CC0 glTF 모델(public/models/*.glb) 로드 + 정규화.
 * 실패해도 게임은 기본 도형으로 동작해야 하므로 절대 throw하지 않는다.
 */
export async function loadModels(): Promise<void> {
  const loader = new GLTFLoader()
  const base = `${import.meta.env.BASE_URL}models`
  const names: ModelName[] = ['player', 'drone', 'spitter', 'brute', 'boss']
  await Promise.all(
    names.map(async (name) => {
      try {
        const gltf = await loader.loadAsync(`${base}/${name}.glb`)
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.castShadow = true
          const mat = mesh.material as THREE.MeshStandardMaterial
          // (emissive 부여 안 함 — ANGLE/D3D11에서 렌더 깨짐. 가시성은 조명+환경맵+림으로.)
          if (mat?.isMeshStandardMaterial) configureMaterial(mat, name)
        })
        registry.set(name, { scene: normalize(gltf.scene, NORMALIZE[name]), animations: gltf.animations })
      } catch (err) {
        console.warn(`model load failed: ${name}`, err)
      }
    }),
  )
}

/** 모델을 목표 크기로 스케일 + 시각 중심을 원점으로 이동 + 정면 회전. 래퍼 그룹 반환. */
function normalize(scene: THREE.Object3D, cfg: { size: number; faceY: number }): THREE.Group {
  const box = new THREE.Box3().setFromObject(scene)
  const size = new THREE.Vector3()
  box.getSize(size)
  const maxHoriz = Math.max(size.x, size.z) || 1
  const s = cfg.size / maxHoriz
  scene.scale.setScalar(s)
  // 스케일 적용 후 중심 재계산해 원점으로 이동
  const box2 = new THREE.Box3().setFromObject(scene)
  const center = new THREE.Vector3()
  box2.getCenter(center)
  scene.position.sub(center)
  // 정면 회전은 래퍼에 적용 (내부 offset과 분리)
  const wrapper = new THREE.Group()
  wrapper.add(scene)
  wrapper.rotation.y = cfg.faceY
  const outer = new THREE.Group()
  outer.add(wrapper)
  return outer
}

/**
 * 인스턴스 생성. 스킨드 메시는 SkeletonUtils.clone으로 복제해야 뼈대가 안 깨짐
 * (일반 clone은 스켈레톤 미복제 → ANGLE/D3D11에서 렌더 실패). 머티리얼도 개체 복제.
 */
export function instantiate(name: ModelName): THREE.Object3D | null {
  const src = registry.get(name)
  if (!src) return null
  const root = skeletonClone(src.scene)
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) mesh.material = (mesh.material as THREE.Material).clone()
  })
  return root
}

/** 모델의 애니메이션 클립 (mixer 재생용). 이름 예: 'CharacterArmature|Run' */
export function getAnimations(name: ModelName): THREE.AnimationClip[] {
  return registry.get(name)?.animations ?? []
}

/** 클립 이름에서 논리 동작 매칭 (모델마다 Run/Walk, Dead/Death 등 이름 다름) */
export function findClip(
  clips: THREE.AnimationClip[],
  kind: 'idle' | 'move' | 'attack' | 'death',
): THREE.AnimationClip | null {
  const pats: Record<typeof kind, RegExp> = {
    idle: /idle/i,
    move: /run|walk/i,
    attack: /attack|shoot/i,
    death: /death|dead/i,
  }
  return clips.find((c) => pats[kind].test(c.name)) ?? null
}

/** 그룹 내 모든 표준 머티리얼 수집 — 피격 플래시·윈드업 발광 제어용 */
export function collectMats(group: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const mats: THREE.MeshStandardMaterial[] = []
  group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && (mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      mats.push(mesh.material as THREE.MeshStandardMaterial)
    }
  })
  return mats
}

/** 진행 중인 플래시 — 머티리얼별 '원래 발광색'과 복구 타이머 */
const flashing = new WeakMap<THREE.MeshStandardMaterial, { hex: number; timer: ReturnType<typeof setTimeout> }>()

/**
 * 피격 흰색 플래시 (60ms).
 * 60ms 안에 두 번째 피격이 겹치면 예전 구현은 '이미 흰색'을 원본으로 기억해 흰색으로 복구했다
 * → 유닛이 영구히 흰 덩어리로 고착(보스는 난타당하므로 사실상 항상 발생). 머티리얼별로
 * 최초 원본만 보관하고 타이머를 새로 걸어, 겹쳐도 마지막 플래시 후 60ms에 원래 색으로 돌아온다.
 */
export function flashMats(mats: THREE.MeshStandardMaterial[]): void {
  for (const m of mats) {
    const prev = flashing.get(m)
    if (prev) clearTimeout(prev.timer)
    const hex = prev ? prev.hex : m.emissive.getHex()
    m.emissive.setHex(0xffffff)
    const timer = setTimeout(() => {
      m.emissive.setHex(hex)
      flashing.delete(m)
    }, 60)
    flashing.set(m, { hex, timer })
  }
}
