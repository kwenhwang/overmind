import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0,300)))
await page.goto('http://localhost:5199/')
await page.waitForFunction(() => typeof window.__designFor === 'function', undefined, { timeout: 20000 })
const base = { playerHpPct: 80, avgDistToCenter: 0.5, damageTakenThisWave: 10, killsByType: {}, waveClearSeconds: 20 }
const cases = {
  'W1 left-dodge (관측만)': { wave: 0, dodgeLeftPct: 90, dodgeRightPct: 10, meleeUsePct: 50, rangedUsePct: 50 },
  'W2 left-dodge': { wave: 1, dodgeLeftPct: 85, dodgeRightPct: 15, meleeUsePct: 50, rangedUsePct: 50 },
  'W3 right-dodge': { wave: 2, dodgeLeftPct: 20, dodgeRightPct: 80, meleeUsePct: 50, rangedUsePct: 50 },
  'W3 melee-lover': { wave: 2, dodgeLeftPct: 52, dodgeRightPct: 48, meleeUsePct: 82, rangedUsePct: 18 },
  'W3 kiter(ranged)': { wave: 2, dodgeLeftPct: 51, dodgeRightPct: 49, meleeUsePct: 15, rangedUsePct: 85 },
  'W3 neutral(개입X)': { wave: 2, dodgeLeftPct: 54, dodgeRightPct: 46, meleeUsePct: 55, rangedUsePct: 45 },
}
for (const [name, d] of Object.entries(cases)) {
  const r = await page.evaluate((dig) => { const x = window.__designFor(dig); return { bias: x.spawnBias, reason: x.counterReason, hazards: (x.hazards||[]).map(h=>h.placement), spawns: x.spawns.map(s=>`${s.type}x${s.count}${(s.modifiers||[]).length?'('+s.modifiers.join(',')+')':''}`) } }, { ...base, ...d })
  console.log('\n['+name+']\n  bias:', r.bias, '| hazards:', JSON.stringify(r.hazards), '\n  reason:', r.reason, '\n  spawns:', JSON.stringify(r.spawns))
}
await browser.close()
console.log('\nDONE')
