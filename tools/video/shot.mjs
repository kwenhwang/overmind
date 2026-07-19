import { chromium } from 'playwright'
const [,,html,out] = process.argv
const b = await chromium.launch({ args:['--no-sandbox','--force-color-profile=srgb'] })
const p = await b.newPage()
await p.setViewportSize({ width:1920, height:1080 })
await p.goto('file://'+html, { waitUntil:'networkidle' })
await p.screenshot({ path: out })
await b.close(); console.log('SHOT '+out)
