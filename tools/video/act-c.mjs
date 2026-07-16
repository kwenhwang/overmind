/**
 * 테이크 C 연기: 보스전 — 판결문 → 강림 → 전투 → 파괴 시퀀스 → 승리.
 * ?boss&bosshp=220 로 파괴까지 압축. 원형 무빙 + 잦은 대시(잔상·긴장감).
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
  // 보스 주위 원형 스트레이프 + 90프레임 주기 대시
  const cycle = frame % 90
  if (cycle === 0) {
    await hold(api, 'KeyA')
    await hold(api, 'KeyW')
  }
  if (cycle === 45) await release(api, 'KeyW')
  if (cycle === 55) await hold(api, 'Space')
  if (cycle === 62) await release(api, 'Space')
  if (cycle === 89) await release(api, 'KeyA')
}
