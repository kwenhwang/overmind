import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export type ModelName = 'player' | 'drone' | 'spitter' | 'brute' | 'boss'

const registry = new Map<ModelName, THREE.Group>()

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

const NORMALIZE: Record<ModelName, { size: number; faceY: number }> = {
  player: { size: 2.8, faceY: 0 }, // 전투기 노즈가 -Z(진행/조준 방향) 향하게 (PI는 앞뒤 반대였음)
  drone: { size: 2.2, faceY: 0 },
  spitter: { size: 2.5, faceY: 0 },
  brute: { size: 3.5, faceY: 0 },
  boss: { size: 6.5, faceY: 0 },
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
          if (mat?.isMeshStandardMaterial) {
            mat.metalness = Math.min(mat.metalness, 0.15)
            mat.roughness = Math.max(mat.roughness, 0.55)
            // (emissive 부여 안 함 — ANGLE/D3D11에서 렌더 깨짐. 가시성은 조명+환경맵으로.)
            // 종류별 색 구분: 채도 높은(몸통) 머티리얼만 정체성 색으로 교체
            const tint = ENEMY_TINT[name]
            if (tint) {
              const hsl = { h: 0, s: 0, l: 0 }
              mat.color.getHSL(hsl)
              if (hsl.s > 0.25) mat.color.setHex(tint)
            }
          }
        })
        registry.set(name, normalize(gltf.scene, NORMALIZE[name]))
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

/** 인스턴스 생성 — 머티리얼까지 복제해 개체별 이미시브 연출이 서로 간섭하지 않게 */
export function instantiate(name: ModelName): THREE.Group | null {
  const src = registry.get(name)
  if (!src) return null
  const clone = src.clone(true)
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) mesh.material = (mesh.material as THREE.Material).clone()
  })
  return clone
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

/** 피격 흰색 플래시 (60ms) */
export function flashMats(mats: THREE.MeshStandardMaterial[]): void {
  const originals = mats.map((m) => m.emissive.getHex())
  for (const m of mats) m.emissive.setHex(0xffffff)
  setTimeout(() => mats.forEach((m, i) => m.emissive.setHex(originals[i])), 60)
}
