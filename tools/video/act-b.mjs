/**
 * 테이크 B 연기: 복귀 인사(기억) 장면.
 * PRESET_LS로 직전 판 사망 기록을 주입하고, 프로파일은 테이크 A가 남긴 localStorage 사용.
 * 텍스트(기억 행 + "돌아왔군…" 타이핑)가 주인공 — 연기는 최소한의 생존 움직임만.
 */
let state = 'unknown'
let held = new Set()

async function hold(api, key) {
  if (!held.has(key)) {
    held.add(key)
    await api.down(key)
  }
}
async function release(api, key) {
  if (held.has(key)) {
    held.delete(key)
    await api.up(key)
  }
}

export default async function act(frame, page, api) {
  if (frame % 15 === 0) state = (await api.dbg())?.state ?? 'unknown'

  if (state !== 'playing') {
    for (const k of [...held]) await release(api, k)
    return
  }
  // 가벼운 원형 무빙 (조준·공격은 autoaim)
  const cycle = frame % 180
  if (cycle === 0) await hold(api, 'KeyD')
  if (cycle === 60) {
    await release(api, 'KeyD')
    await hold(api, 'KeyW')
  }
  if (cycle === 100) await hold(api, 'Space')
  if (cycle === 108) await release(api, 'Space')
  if (cycle === 120) {
    await release(api, 'KeyW')
    await hold(api, 'KeyA')
  }
  if (cycle === 179) await release(api, 'KeyA')
}
