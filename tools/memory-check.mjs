// 프로파일 기억 왕복 검증: 1판 → localStorage 저장 → 재로드(2판) → 기억 표시 + 복귀 인사
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
const url = 'http://localhost:5199/?autostart&nobloom&timescale=5'
await page.goto(url)
await page.waitForFunction(() => document.getElementById('wave-label')?.textContent?.includes('WAVE'), { timeout: 90000 })
const profile1 = await page.evaluate(() => localStorage.getItem('overmind-profile'))
console.log('1판 웨이브1 후 저장된 프로파일:', profile1?.slice(0, 100))
// 죽을 때까지 방치 (게임오버 → lastOutcome 기록)
await page.waitForFunction(() => !document.getElementById('screen')?.classList.contains('hidden'), { timeout: 120000 })
console.log('결말:', await page.$eval('#screen-title', (el) => el.textContent))
console.log('outcome:', await page.evaluate(() => localStorage.getItem('overmind-last-outcome')))
// 2판 시작
await page.goto(url)
await page.waitForFunction(() => document.querySelector('#report .report-memory') !== null, { timeout: 60000 })
console.log('2판 리포트 기억 표시:', await page.$eval('#report .report-memory', (el) => el.textContent?.slice(0, 90)))
await page.waitForFunction(() => document.getElementById('wave-label')?.textContent?.includes('WAVE'), { timeout: 90000 })
console.log('2판 복귀 인사:', await page.evaluate(() => new Promise((r) => setTimeout(() => r(document.getElementById('taunt')?.textContent), 4000))))
await browser.close()
console.log('MEMORY_CHECK_DONE')
