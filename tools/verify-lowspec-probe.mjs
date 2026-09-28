// 저사양 자동 강등 프로브 검증 (헤드리스, swiftshader = 실측 저사양 환경)
//  A) 타이틀 화면에서는 측정 창이 열리지 않는다 (구조 결함 회귀 방지)
//  B) 전투(적 실재) 프레임에서 3초 창이 닫히고 블룸+그림자가 동시에 내려간다 (positive)
// 정상 fps 미발동(negative)은 헤드리스 원리적 불가 — 실기기 몫.
// UA에 naru-probe 마커 + umami.disabled 주입 — 점검이 방문자 통계에 섞이지 않게(T-2026W32-122).
import { chromium } from 'playwright'
import { appendFileSync } from 'fs'

const URL = process.env.URL || 'http://localhost:5199'
const OUT = process.env.OUT || '/tmp/lowspec'
const w = (s) => appendFileSync(`${OUT}.log`, s + '\n')

const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const errors = []
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36 naru-probe/1.0 bot',
})
await page.addInitScript(() => {
  try { localStorage.setItem('umami.disabled', '1') } catch { /* noop */ }
})
page.on('pageerror', (e) => errors.push(String(e)))

const dbg = () => page.evaluate(() => (window.__dbg ? window.__dbg() : null))
const waitDbg = () => page.waitForFunction(() => typeof window.__dbg === 'function', undefined, { timeout: 60000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── A) 타이틀 8초 방치 ──
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' })
await waitDbg()
await sleep(8000)
const title = await dbg()
w(`[A] title state=${title.state} probe=${JSON.stringify(title.perf.probe)} usePost=${title.perf.usePost} shadowMap=${title.perf.shadowMap}`)
const aPass = title.state === 'title' && title.perf.probe.done === false && title.perf.probe.start === 0 && title.perf.probe.frames === 0
w(`[A] ${aPass ? 'PASS' : 'FAIL'} — 타이틀은 창을 소진하지 않아야 함`)

// ── B) ?autostart 실전투 ──
await page.goto(`${URL}/?autostart`, { waitUntil: 'domcontentloaded' })
await waitDbg()
let sawEnemiesBeforeDone = false
let fired = null
for (let t = 0; t < 150; t++) {
  const d = await dbg()
  if (!d) break
  if (!d.perf.probe.done && d.enemies > 0) sawEnemiesBeforeDone = true
  if (t % 10 === 0) w(`[B] t=${t}s state=${d.state} enemies=${d.enemies} probe=${JSON.stringify(d.perf.probe)} usePost=${d.perf.usePost} shadowMap=${d.perf.shadowMap}`)
  if (d.perf.probe.done) { fired = d; break }
  await sleep(1000)
}
w(`[B] final=${JSON.stringify(fired && { state: fired.state, enemies: fired.enemies, probe: fired.perf.probe, usePost: fired.perf.usePost, shadowMap: fired.perf.shadowMap })}`)
const bPass = !!fired && sawEnemiesBeforeDone && fired.perf.usePost === false && fired.perf.shadowMap === false
w(`[B] ${bPass ? 'PASS' : 'FAIL'} — 전투 중 발동 + 블룸/그림자 동시 강등 (적 관측=${sawEnemiesBeforeDone})`)

// 강등 이후에도 렌더가 살아있는지 (셰이더 재컴파일 후 프레임 진행 확인)
await sleep(3000)
await page.screenshot({ path: `${OUT}.png` })
const after = await dbg()
w(`[C] 강등 후 3초: state=${after.state} enemies=${after.enemies} hp=${after.hp} usePost=${after.perf.usePost} shadowMap=${after.perf.shadowMap}`)
w(`[pageerror] ${errors.length ? errors.join(' | ') : 'NONE'}`)
w(`RESULT ${aPass && bPass && errors.length === 0 ? 'ALL-PASS' : 'FAIL'}`)
await browser.close()
