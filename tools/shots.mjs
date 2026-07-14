// 검증용 스크린샷 3종: 인터미션 리포트 / 게임플레이 / 모바일(iPhone 에뮬)
import { chromium, devices } from 'playwright'
const OUT = process.env.OUT ?? '.'
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })

// 1) 데스크톱: 인터미션 관찰 리포트 (웨이브1 클리어까지는 못 가니 웨이브0 리포트 + 웨이브1 진입)
const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await desktop.goto('http://localhost:5199/?autostart&nobloom')
await desktop.waitForSelector('#report:not(.hidden)', { timeout: 30000 })
await desktop.screenshot({ path: `${OUT}/shot-report.png` })
await desktop.waitForFunction(() => document.getElementById('wave-label')?.textContent?.includes('WAVE'), { timeout: 60000 })
await desktop.waitForTimeout(3500)
await desktop.screenshot({ path: `${OUT}/shot-play.png` })
await desktop.close()

// 2) 모바일 에뮬레이션: 타이틀 + 조이스틱
const iphone = devices['iPhone 13']
const ctx = await browser.newContext({ ...iphone })
const mob = await ctx.newPage()
await mob.goto('http://localhost:5199/?nobloom')
await mob.waitForTimeout(1500)
await mob.screenshot({ path: `${OUT}/shot-mobile-title.png` })
await mob.tap('#screen-btn')
await mob.waitForTimeout(1200)
// 왼쪽 드래그로 조이스틱 표시
await mob.touchscreen.tap(100, 500) // joystick down 위치 확인용
const cdp = await ctx.newCDPSession(mob)
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: 480, id: 1 }] })
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 130, y: 440, id: 1 }] })
await mob.waitForTimeout(600)
await mob.screenshot({ path: `${OUT}/shot-mobile-play.png` })
await browser.close()
console.log('SHOTS_DONE')
