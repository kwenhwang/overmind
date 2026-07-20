// 보스전 검증: 스폰 → 전투 20초 (이동+원거리) → 상태·스크린샷
import { chromium } from 'playwright'
const OUT = process.env.OUT ?? '.'
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)))
await page.goto('http://localhost:5199/?autostart&boss&nobloom&timescale=3')
await page.waitForFunction(() => Boolean(window.__dbg?.().boss), undefined, { timeout: 90000, polling: 500 })
console.log('boss spawned:', JSON.stringify(await page.evaluate(() => window.__dbg?.())))
console.log('boss bar:', await page.$eval('#boss-name', (el) => el.textContent))
await page.keyboard.down('KeyA')
for (let i = 0; i < 8; i++) {
  await page.keyboard.press('KeyK')
  await page.keyboard.press('Space')
  await page.waitForTimeout(1200)
  if (i === 4) { await page.keyboard.up('KeyA'); await page.keyboard.down('KeyW') }
}
await page.keyboard.up('KeyW')
console.log('after fight:', JSON.stringify(await page.evaluate(() => window.__dbg?.())))
await page.screenshot({ path: `${OUT}/boss-fight.png` })
await browser.close()
console.log('BOSS_CHECK_DONE')
