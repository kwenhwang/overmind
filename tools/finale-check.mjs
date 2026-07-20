// 보스 강림→저체력 파괴→승리 시퀀스 관통 검증
import { chromium } from 'playwright'
const OUT = process.env.OUT ?? '.'
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
await page.goto('http://localhost:5199/?autostart&boss&nobloom&timescale=3')
await page.waitForFunction(() => Boolean(window.__dbg?.().boss), undefined, { timeout: 90000, polling: 500 })
console.log('spawned:', JSON.stringify(await page.evaluate(() => window.__dbg?.())))
// 강림 동안 대기 후 원거리 연사 (오버마인드가 접근해오므로 명중 기대)
await page.waitForTimeout(2500)
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => window.__killBoss?.())
  await page.waitForTimeout(1500)
  const dbg = await page.evaluate(() => window.__dbg?.())
  console.log('t:', JSON.stringify(dbg))
  if (!dbg.boss || dbg.state === 'victory') break
}
// 승리 화면 대기
await page.waitForFunction(() => window.__dbg?.().state === 'victory', undefined, { timeout: 30000, polling: 500 })
console.log('victory! desc:', (await page.$eval('#screen-desc', (el) => el.textContent))?.slice(0, 80))
await page.screenshot({ path: `${OUT}/victory.png` })
await browser.close()
console.log('FINALE_OK')
