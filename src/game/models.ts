import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export type ModelName = 'player' | 'drone' | 'spitter' | 'brute' | 'boss'

const registry = new Map<ModelName, THREE.Group>()

/**
 * 유닛별 목표 시각 크기(수평 최대변) + 정면 회전(Y, 라디안).
 * CC0 외부 모델(Quaternius)은 크기·원점·정면이 제각각이라 로드 시 정규화한다.
 * 게임 코드는 원점=시각 중심, 정면 -Z 를 가정하므로 그에 맞춘다.
 */
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
            // 자체발광 부여: 조명·환경맵이 약한 기기에서도 형체가 확실히 보이게.
            // (실측: 조명 의존 몸통은 일부 GPU에서 어둡게 죽고 emissive 눈만 보였음)
            if (mat.emissive.getHex() === 0x000000) {
              mat.emissive.copy(mat.color)
              mat.emissiveIntensity = 0.5
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
