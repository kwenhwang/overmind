/**
 * 테이크 A 연기: 습관(왼쪽 대시) → 관찰 리포트 → 처벌 웨이브.
 * 상태 적응형 — 웨이브 전환 타이밍이 매번 달라서 프레임 고정 대신 __dbg 폴링.
 * 조준·공격은 ?autoaim, 여기선 이동·대시만 연기.
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
  if (frame % 15 === 0) {
    const dbg = await api.dbg()
    state = dbg?.state ?? 'unknown'
  }

  if (state !== 'playing') {
    // 인터미션·리포트: 정지 (리포트가 화면 주인공)
    for (const k of [...held]) await release(api, k)
    return
  }

  // 전투: 접근(W) 유지 + 120프레임 주기로 "왼쪽(A) 대시" — 왼쪽 회피 편향을 각인
  const cycle = frame % 120
  if (cycle === 0) await hold(api, 'KeyW')
  if (cycle === 40) {
    await hold(api, 'KeyA')
    await release(api, 'KeyW')
  }
  if (cycle === 50) await hold(api, 'Space')
  if (cycle === 58) await release(api, 'Space')
  if (cycle === 90) {
    await release(api, 'KeyA')
    await hold(api, 'KeyW')
  }
}
