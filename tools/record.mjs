/**
 * 헤드리스 프레임 단위 녹화 — 실시간 성능과 무관하게 60fps 영상 생성.
 * 사용: node tools/record.mjs <url> <초> <출력.mp4> [입력스크립트.mjs]
 * 입력스크립트: export default async function(frame, page, api) — 프레임별 연기 지시.
 */
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const [url, secondsArg, out, actScript] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: node tools/record.mjs <url> <seconds> <out.mp4> [act.mjs]')
  process.exit(1)
}
const FPS = 60
const totalFrames = Math.round(Number(secondsArg || 10) * FPS)
const act = actScript ? (await import(resolve(actScript))).default : null

const dir = join(tmpdir(), `ovm-rec-${Date.now()}`)
mkdirSync(dir, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
await page.goto(url)
await page.waitForFunction(() => typeof window.__step === 'function', undefined, { timeout: 30000 })

// 연기 헬퍼: 키 누름/뗌 + LLM 응답 대기(게임 시간 정지 상태에서 실시간 대기)
const api = {
  down: (key) => page.keyboard.down(key),
  up: (key) => page.keyboard.up(key),
  waitReal: (ms) => page.waitForTimeout(ms),
  dbg: () => page.evaluate(() => window.__dbg?.()),
  eval: (fn) => page.evaluate(fn),
}

const t0 = Date.now()
for (let f = 0; f < totalFrames; f++) {
  if (act) await act(f, page, api)
  await page.evaluate(() => window.__step())
  await page.screenshot({
    path: join(dir, `f${String(f).padStart(5, '0')}.png`),
    clip: { x: 0, y: 0, width: 1280, height: 720 },
  })
  if (f % 120 === 0) {
    const el = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(`frame ${f}/${totalFrames} (${el}s elapsed)`)
  }
}
await browser.close()

// 시스템 ffmpeg로 인코딩 (playwright 동봉판은 x264 미포함)
const r = spawnSync('ffmpeg', [
  '-y', '-framerate', String(FPS), '-i', join(dir, 'f%05d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', out,
], { stdio: ['ignore', 'ignore', 'pipe'] })
if (r.status !== 0) {
  console.error('ffmpeg failed:', r.stderr?.toString().slice(-500))
  process.exit(1)
}
rmSync(dir, { recursive: true, force: true })
console.log(`RECORDED ${out} (${totalFrames} frames)`)
