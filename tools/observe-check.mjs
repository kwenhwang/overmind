// 관측 HUD 수용 기준 자동 검증 — 좌회피 주입 시 좌편향 게이지가 실제로 치우치는지.
// 구동: npm run dev -- --port 5199 띄운 뒤 `node tools/observe-check.mjs`
import { chromium } from 'playwright'
const PORT = process.env.PORT || '5199'
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
let errs = 0
page.on('pageerror', (e) => { errs++; console.log('[pageerror]', String(e).slice(0, 300)) })
await page.goto(`http://localhost:${PORT}/?autostart&record&norender`)
await page.waitForFunction(() => typeof window.__step === 'function' && typeof window.__dbg === 'function', undefined, { timeout: 20000 })

const readPanel = () => page.evaluate(() => {
  const track = document.querySelector('#observe .observe-row[data-axis="dodge"] .observe-track')
  const row = document.querySelector('#observe .observe-row[data-axis="dodge"]')
  const redesign = document.getElementById('observe-redesign-track')
  return {
    visible: !document.getElementById('observe')?.classList.contains('hidden'),
    dodgeNow: Number(track?.getAttribute('aria-valuenow')),
    sampling: row?.classList.contains('is-sampling') ?? null,
    locked: row?.classList.contains('is-locked') ?? null,
    status: document.getElementById('observe-status')?.textContent ?? '',
    redesignNow: Number(redesign?.getAttribute('aria-valuenow')),
  }
})

// 1) 스폰 텔레그래프 통과 — 적이 실제로 등장할 때까지 스텝 (고정 시간 가정 대신 상태 폴링)
for (let i = 0; i < 600; i++) {
  await page.evaluate(() => window.__step(1 / 60))
  const d = await page.evaluate(() => window.__dbg())
  if (d.enemies > 0) break
}

// 2) 초기 상태 — 패널 노출 + 회피 게이지 중앙(50) + 표본 미달 상태
const initial = await readPanel()
console.log('[초기]', initial)
const initOk = initial.visible && initial.dodgeNow === 50 && initial.sampling === true

// 3) 좌회피 주입 — KeyA 홀드 + 60프레임 간격 Space 대시 5회 포함 300프레임(게임시간 5초)
await page.keyboard.down('KeyA')
const redesignSamples = []
const statusesSeen = new Set()
for (let i = 0; i < 300; i++) {
  if (i % 60 === 30) await page.keyboard.press('Space') // 이동키 홀드 상태라 대시 발동
  await page.evaluate(() => window.__step(1 / 60))
  if (i % 20 === 19) {
    const p = await readPanel()
    statusesSeen.add(p.status)
    if (i % 100 === 99) redesignSamples.push(p.redesignNow)
  }
}
await page.keyboard.up('KeyA')

// 4) 판정
const after = await readPanel()
const dbg = await page.evaluate(() => window.__dbg())
console.log('[주입 후]', after, '| __dbg().dodge =', dbg.dodge, '| 재설계 샘플 =', redesignSamples)
console.log('[status 이력]', [...statusesSeen])

const biasOk = after.dodgeNow >= 65
// 포착 문구는 프리페치 발화 시 '카운터 재설계 중'으로 전이하는 게 정상 — 이력으로 검사, 락 글로우는 유지되어야 함
const lockOk = after.locked === true && [...statusesSeen].some((s) => s.startsWith('습관 포착'))
const sourceOk = Math.abs(after.dodgeNow - dbg.dodge.left) <= 2 // 스로틀 1틱 오차 허용
const redesignOk = redesignSamples.every((v, i) => Number.isFinite(v) && v >= 0 && v <= 100 && (i === 0 || v >= redesignSamples[i - 1]))

console.log(`[판정] 초기중앙=${initOk} 좌편향≥65=${biasOk}(${after.dodgeNow}) 락+문구=${lockOk} 원천정합=${sourceOk} 재설계단조=${redesignOk} pageerrors=${errs}`)
await browser.close()
console.log(initOk && biasOk && lockOk && sourceOk && redesignOk && errs === 0 ? 'PASS' : 'CHECK')
