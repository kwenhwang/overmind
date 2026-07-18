import { chromium } from 'playwright'
const url = process.argv[2] ?? 'http://localhost:5233/?autostart'
const b = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
await p.goto(url)
await p.waitForTimeout(1500)
console.log('early errors:', errs.slice(0,8))
console.log('early dbg:', JSON.stringify(await p.evaluate(() => window.__dbg ? window.__dbg() : 'no __dbg')))
try {
  await p.waitForFunction(() => document.getElementById('wave-label')?.textContent?.includes('WAVE'), { timeout: 30000 })
  console.log('WAVE reached')
} catch { console.log('WAVE not reached in 30s') }
await p.waitForFunction(() => (window.__dbg?.().enemies ?? 0) >= 3, { timeout: 15000 }).catch(()=>{})
await p.keyboard.down('KeyA'); await p.waitForTimeout(2500); await p.keyboard.up('KeyA')
const dbg = await p.evaluate(() => window.__dbg())
console.log('final dbg:', JSON.stringify({state:dbg.state, wave:dbg.wave, enemies:dbg.enemies, hp:dbg.hp, nearest:dbg.nearest, onScreen:dbg.onScreen}))
console.log('errors total:', errs.length ? errs.slice(0,8) : 'none')
await b.close()
