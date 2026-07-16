/**
 * SFX 타임라인 → WAV 오프라인 합성 — src/game/sfx.ts의 신스 수식을 PCM으로 포팅.
 * 사용: node tools/render-audio.mjs <sfxlog.json> <초> <out.wav>
 * (레시피 테이블은 sfx.ts와 수동 동기화 — 변경 시 양쪽 모두 수정)
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [logPath, secondsArg, out] = process.argv.slice(2)
const SR = 44100
const MASTER = 0.35
const seconds = Number(secondsArg)
const buf = new Float64Array(Math.ceil(SR * (seconds + 1)))

function osc(type, phase) {
  const p = phase % 1
  switch (type) {
    case 'sine': return Math.sin(p * Math.PI * 2)
    case 'square': return p < 0.5 ? 1 : -1
    case 'sawtooth': return p * 2 - 1
    default: return 4 * Math.abs(p - 0.5) - 1 // triangle
  }
}

function tone(at, freq, duration, { type = 'square', slideTo = 0, volume = 0.5, delay = 0 } = {}) {
  const start = Math.floor((at + delay) * SR)
  const n = Math.floor(duration * SR)
  let phase = 0
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const t = i / n
    const f = slideTo ? freq * Math.pow(Math.max(1, slideTo) / freq, t) : freq
    phase += f / SR
    const gain = volume * Math.pow(0.001 / volume, t) // exponentialRamp to 0.001
    buf[start + i] += osc(type, phase) * gain * MASTER
  }
}

function noise(at, duration, { volume = 0.5, filterFrom = 3000, filterTo = 200 } = {}) {
  const start = Math.floor(at * SR)
  const n = Math.floor(duration * SR)
  let y = 0
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const t = i / n
    const fc = filterFrom * Math.pow(filterTo / filterFrom, t)
    const alpha = 1 - Math.exp((-2 * Math.PI * fc) / SR)
    y += alpha * (Math.random() * 2 - 1 - y)
    const gain = volume * Math.pow(0.001 / volume, t)
    buf[start + i] += y * gain * MASTER
  }
}

// sfx.ts 레시피 미러
const RECIPES = {
  shoot: (t) => tone(t, 880, 0.08, { type: 'sawtooth', slideTo: 220, volume: 0.25 }),
  meleeSwing: (t) => noise(t, 0.09, { volume: 0.2, filterFrom: 1200, filterTo: 400 }),
  meleeHit: (t) => {
    noise(t, 0.12, { volume: 0.5, filterFrom: 2500, filterTo: 300 })
    tone(t, 160, 0.1, { type: 'square', slideTo: 60, volume: 0.4 })
  },
  enemyHit: (t) => tone(t, 300, 0.06, { type: 'triangle', slideTo: 150, volume: 0.3 }),
  enemyDie: (t) => {
    noise(t, 0.25, { volume: 0.55, filterFrom: 4000, filterTo: 120 })
    tone(t, 220, 0.2, { type: 'sawtooth', slideTo: 40, volume: 0.35 })
  },
  playerHurt: (t) => {
    tone(t, 140, 0.18, { type: 'square', slideTo: 70, volume: 0.5 })
    noise(t, 0.12, { volume: 0.3 })
  },
  dash: (t) => tone(t, 500, 0.12, { type: 'sine', slideTo: 900, volume: 0.25 }),
  lungeWarn: (t) => tone(t, 650, 0.12, { type: 'square', volume: 0.18 }),
  waveStart: (t) => {
    tone(t, 196, 0.14, { type: 'square', volume: 0.3 })
    tone(t, 294, 0.14, { type: 'square', volume: 0.3, delay: 0.12 })
    tone(t, 392, 0.22, { type: 'square', volume: 0.35, delay: 0.24 })
  },
  taunt: (t) => tone(t, 1200, 0.05, { type: 'sine', slideTo: 1600, volume: 0.15 }),
  victory: (t) => [262, 330, 392, 523].forEach((f, i) => tone(t, f, 0.22, { type: 'triangle', volume: 0.35, delay: i * 0.13 })),
  defeat: (t) => [392, 330, 262, 196].forEach((f, i) => tone(t, f, 0.3, { type: 'sawtooth', volume: 0.3, delay: i * 0.16 })),
}

const events = JSON.parse(readFileSync(logPath, 'utf8'))
for (const { n, f } of events) RECIPES[n]?.(f / 60)

// 소프트 클립 후 16bit PCM WAV
const pcm = new Int16Array(buf.length)
for (let i = 0; i < buf.length; i++) pcm[i] = Math.round(Math.tanh(buf[i]) * 32767)
const dataSize = pcm.length * 2
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + dataSize, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(SR, 24)
header.writeUInt32LE(SR * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(dataSize, 40)
writeFileSync(out, Buffer.concat([header, Buffer.from(pcm.buffer)]))
console.log(`AUDIO_RENDERED ${out} (${events.length} events, ${seconds}s)`)
