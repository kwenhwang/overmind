import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { configureMaterial, NORMALIZE, type ModelName } from './game/models'

/**
 * OVERMIND 에셋 뷰어 — 생성한 GLB를 게임과 동일한 조명·환경맵·톤매핑·머티리얼 처리로
 * 미리보고, 통합에 필요한 파라미터(크기·정면·폴리·애니)를 표시한다. 완전 클라이언트 사이드.
 */
const canvas = document.getElementById('view') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.98

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x07080c)
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200)
camera.position.set(0, 5, 9)
const controls = new OrbitControls(camera, canvas)
controls.target.set(0, 1.2, 0)
controls.enableDamping = true

// 게임(world.ts)과 동일한 조명 구성
scene.add(new THREE.HemisphereLight(0x8fa3c7, 0x241a12, 0.95))
const key = new THREE.DirectionalLight(0xfff0dd, 2.4)
key.position.set(14, 30, 8)
key.castShadow = true
key.shadow.mapSize.set(2048, 2048)
key.shadow.bias = -0.0004
scene.add(key)
const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.7)
rimLight.position.set(-10, 12, -16)
scene.add(rimLight)

// 맥락용 바닥 + 네온 링
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(9, 64),
  new THREE.MeshStandardMaterial({ color: 0x12161f, roughness: 0.8, metalness: 0.1 }),
)
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)
const ring = new THREE.Mesh(
  new THREE.TorusGeometry(6, 0.08, 12, 96),
  new THREE.MeshStandardMaterial({ color: 0x0a2733, emissive: 0x22d3ee, emissiveIntensity: 3 }),
)
ring.rotation.x = Math.PI / 2
ring.position.y = 0.05
scene.add(ring)

const slotSel = document.getElementById('slot') as HTMLSelectElement
const clipSel = document.getElementById('clip') as HTMLSelectElement
const spinChk = document.getElementById('spin') as HTMLInputElement
const rawChk = document.getElementById('raw') as HTMLInputElement
const info = document.getElementById('info') as HTMLDivElement
const drop = document.getElementById('drop') as HTMLDivElement
const sendBtn = document.getElementById('send') as HTMLButtonElement

/** 개발자가 curl로 받아 통합하는 업로드 엔드포인트 (게임 LLM 프록시 재사용) */
const PROXY = 'https://overmind-proxy.kwenhwang.workers.dev'

const loader = new GLTFLoader()
let current: THREE.Object3D | null = null
let mixer: THREE.AnimationMixer | null = null
let clips: THREE.AnimationClip[] = []
let lastBuffer: ArrayBuffer | null = null
let lastName = 'model.glb'

function triCount(obj: THREE.Object3D): number {
  let t = 0
  obj.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.geometry) {
      const g = m.geometry as THREE.BufferGeometry
      t += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3
    }
  })
  return Math.round(t)
}

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

async function sendToServer(): Promise<void> {
  if (!lastBuffer) return
  const sizeMB = lastBuffer.byteLength / 1024 / 1024
  if (sizeMB > 16) {
    sendBtn.textContent = `너무 큼(${sizeMB.toFixed(1)}MB) — 폴리·텍스처 낮추세요`
    sendBtn.classList.add('err')
    return
  }
  sendBtn.disabled = true
  sendBtn.textContent = '전송 중…'
  sendBtn.classList.remove('err', 'sent')
  try {
    const res = await fetch(`${PROXY}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: slotSel.value, name: lastName, glb: abToBase64(lastBuffer) }),
    })
    const ok = res.ok && (await res.json()).ok
    sendBtn.textContent = ok ? `전송됨 ✓ (${slotSel.value})` : '전송 실패'
    sendBtn.classList.toggle('sent', !!ok)
    sendBtn.classList.toggle('err', !ok)
  } catch {
    sendBtn.textContent = '전송 실패(네트워크)'
    sendBtn.classList.add('err')
  }
  sendBtn.disabled = false
}
sendBtn.onclick = sendToServer

function loadGLB(buffer: ArrayBuffer, fname: string): void {
  lastBuffer = buffer
  lastName = fname
  sendBtn.disabled = false
  sendBtn.classList.remove('sent', 'err')
  sendBtn.textContent = '🎮 서버로 전송'
  loader.parse(
    buffer,
    '',
    (gltf) => {
      if (current) {
        scene.remove(current)
        current = null
      }
      mixer = null
      clips = []
      const slot = slotSel.value as ModelName
      const root = gltf.scene
      let mats = 0
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.castShadow = true
          const mat = m.material as THREE.MeshStandardMaterial
          if (mat?.isMeshStandardMaterial) {
            mats++
            if (rawChk.checked) mat.metalness = Math.min(mat.metalness, 0.3)
            else configureMaterial(mat, slot)
          }
        }
      })
      // 게임 크기로 정규화(수평 최대변) + xz 중심 + 발을 바닥(y=0)에
      const cfg = NORMALIZE[slot]
      const box = new THREE.Box3().setFromObject(root)
      const size = new THREE.Vector3()
      box.getSize(size)
      const maxH = Math.max(size.x, size.z) || 1
      const s = cfg.size / maxH
      root.scale.setScalar(s)
      const box2 = new THREE.Box3().setFromObject(root)
      const c = new THREE.Vector3()
      box2.getCenter(c)
      root.position.set(-c.x, -box2.min.y, -c.z)
      const wrap = new THREE.Group()
      wrap.rotation.y = cfg.faceY
      wrap.add(root)
      scene.add(wrap)
      current = wrap
      clips = gltf.animations ?? []
      if (clips.length) {
        mixer = new THREE.AnimationMixer(root)
        clipSel.innerHTML = clips.map((cl, i) => `<option value="${i}">${cl.name}</option>`).join('')
        playClip(0)
      } else {
        clipSel.innerHTML = '<option value="-1">없음</option>'
      }
      showInfo(slot, fname, triCount(root), mats, size, s)
    },
    (err) => {
      info.innerHTML = `<span class="err">로드 실패: ${String(err).slice(0, 200)}</span>`
    },
  )
}

function playClip(i: number): void {
  if (!mixer || !clips[i]) return
  mixer.stopAllAction()
  mixer.clipAction(clips[i]).reset().play()
}

function showInfo(slot: string, fname: string, tris: number, mats: number, rawSize: THREE.Vector3, scale: number): void {
  const heavy = tris > 40000 ? ' <span class="warn">(폴리 많음 — 데시메이트 권장)</span>' : ''
  const anim = clips.length
    ? clips.map((cl) => cl.name).join(', ')
    : '없음 (정적 — 절차 애니 슬롯 player/boss에 적합, 걷는 적엔 리깅 필요)'
  info.innerHTML =
    `<b>${fname}</b> → 슬롯 <b>${slot}</b>\n` +
    `삼각형 ${tris.toLocaleString()}${heavy} · 머티리얼 ${mats}\n` +
    `원본 크기 ${rawSize.x.toFixed(2)} × ${rawSize.y.toFixed(2)} × ${rawSize.z.toFixed(2)} (게임 크기로 ×${scale.toFixed(3)})\n` +
    `애니메이션: ${anim}\n` +
    `<span class="norm">→ 마음에 들면 위 <b>🎮 서버로 전송</b> 버튼을 누르세요 (슬롯 ${slot}로 업로드 → 개발자가 게임에 통합). 정면이 틀어져 보이면 알려주세요(faceY).</span>`
}

slotSel.onchange = () => lastBuffer && loadGLB(lastBuffer, lastName)
rawChk.onchange = () => lastBuffer && loadGLB(lastBuffer, lastName)
clipSel.onchange = () => playClip(Number(clipSel.value))
;(document.getElementById('file') as HTMLInputElement).onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) f.arrayBuffer().then((b) => loadGLB(b, f.name))
}
addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('hint')
})
addEventListener('dragleave', () => drop.classList.remove('hint'))
addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('hint')
  const f = e.dataTransfer?.files?.[0]
  if (f) f.arrayBuffer().then((b) => loadGLB(b, f.name))
})
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const clock = new THREE.Clock()
function frame(): void {
  const dt = clock.getDelta()
  mixer?.update(dt)
  if (current && spinChk.checked) current.rotation.y += dt * 0.6
  ;(ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.6 + Math.sin(performance.now() * 0.002) * 0.6
  controls.update()
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
frame()
