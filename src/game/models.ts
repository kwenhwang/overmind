import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export type ModelName = 'player' | 'drone' | 'spitter' | 'brute' | 'boss'

const registry = new Map<ModelName, THREE.Group>()

/**
 * Blender 파이프라인 산출물(public/models/*.glb) 로드.
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
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true
          }
        })
        registry.set(name, gltf.scene)
      } catch (err) {
        console.warn(`model load failed: ${name}`, err)
      }
    }),
  )
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
