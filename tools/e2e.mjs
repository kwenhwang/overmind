/**
 * E2E 검증: 게임 → 프록시 → LLM → 웨이브 반영 사슬을 실브라우저로 확인.
 * 사용: node tools/e2e.mjs [gameUrl]
 * 전제: vite(:5199 기본)와 프록시가 떠 있을 것. LLM 대사(수치 인용)와
 *       폴백 풀 대사를 구분해 LLM 경로가 실제로 쓰였는지 판정한다.
 */
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:5199/?autostart'
const FALLBACK_TAUNTS = [
  '패턴 분석 완료. 다음 수는 이미 정해져 있다.',
  '너의 습관이 너를 배신할 것이다.',
  '흥미롭군. 하지만 예측 가능해.',
  '재구성한다. 이번엔 다를 것이다.',
  '네 움직임은 전부 기록되고 있다.',
]

const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[browser error]', m.text())
})
await page.goto(url)

// 웨이브 1 시작 대기 (LLM 왕복 포함 — 넉넉히 60초)
await page.waitForFunction(
  () => document.getElementById('wave-label')?.textContent?.includes('WAVE'),
  { timeout: 60_000 },
)
const taunt = await page.$eval('#taunt', (el) => el.textContent ?? '')
const dbg = await page.evaluate(() => window.__dbg?.())
console.log('wave-label:', await page.$eval('#wave-label', (el) => el.textContent))
console.log('taunt:', taunt)
console.log('state:', JSON.stringify(dbg))

// 전투를 좀 굴려서 (이동+공격) 텔레메트리가 편향을 갖게 함 — 웨이브 2 설계에 반영되는지 관찰
await page.keyboard.down('KeyA')
for (let i = 0; i < 8; i++) {
  await page.keyboard.press('Space')
  await page.keyboard.press('KeyJ')
  await page.waitForTimeout(700)
}
await page.keyboard.up('KeyA')

const fromLlm = taunt.length > 0 && !FALLBACK_TAUNTS.includes(taunt)
console.log(fromLlm ? 'E2E_OK: LLM 대사 확인' : 'E2E_FALLBACK: 폴백 대사 — LLM 경로 미사용')
await page.screenshot({ path: process.env.SHOT ?? 'e2e-shot.png' })
await browser.close()
process.exit(fromLlm ? 0 : 1)
