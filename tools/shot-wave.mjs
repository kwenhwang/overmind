import { chromium } from 'playwright'
const OUT = process.env.OUT ?? '.'
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
await page.goto('http://localhost:5199/?autostart&nobloom&timescale=4')
await page.waitForFunction(() => window.__dbg?.().enemies > 0, undefined, { timeout: 90000, polling: 500 })
await page.waitForTimeout(2500)
console.log(JSON.stringify(await page.evaluate(() => window.__dbg?.())))
await page.screenshot({ path: `${OUT}/models-wave.png` })
await browser.close()
console.log('DONE')
