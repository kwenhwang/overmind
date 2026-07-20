/**
 * 절차 생성 SFX — 외부 오디오 에셋 없이 WebAudio 신스로 전부 해결.
 * (라이선스 이슈 0, 용량 0. 첫 사용자 입력에서 AudioContext 언락)
 *
 * 녹화 모드(?record): 소리 대신 {이벤트명, 프레임}을 window.__sfxLog에 기록 —
 * tools/render-audio.mjs가 동일 신스 수식으로 오프라인 합성해 영상에 먹싱한다.
 */
const RECORD = new URLSearchParams(location.search).has('record')

function logEvent(name: string): boolean {
  if (!RECORD) return false
  const w = window as unknown as { __sfxLog?: { n: string; f: number }[]; __frame?: number }
  ;(w.__sfxLog ??= []).push({ n: name, f: w.__frame ?? 0 })
  return true
}

class Synth {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
        this.master = this.ctx.createGain()
        this.master.gain.value = 0.35
        this.master.connect(this.ctx.destination)
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  /** 톤 — freq에서 slideTo로 미끄러지는 단순 오실레이터 + 감쇠 */
  tone(
    freq: number,
    duration: number,
    opts: { type?: OscillatorType; slideTo?: number; volume?: number; delay?: number } = {},
  ): void {
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const t0 = ctx.currentTime + (opts.delay ?? 0)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = opts.type ?? 'square'
    osc.frequency.setValueAtTime(freq, t0)
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.slideTo), t0 + duration)
    gain.gain.setValueAtTime(opts.volume ?? 0.5, t0)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration)
    osc.connect(gain).connect(this.master)
    osc.start(t0)
    osc.stop(t0 + duration + 0.02)
  }

  /** 노이즈 버스트 — 타격·폭발 질감 */
  noise(duration: number, opts: { volume?: number; filterFrom?: number; filterTo?: number } = {}): void {
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const t0 = ctx.currentTime
    const len = Math.ceil(ctx.sampleRate * duration)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(opts.filterFrom ?? 3000, t0)
    filter.frequency.exponentialRampToValueAtTime(opts.filterTo ?? 200, t0 + duration)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(opts.volume ?? 0.5, t0)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration)
    src.connect(filter).connect(gain).connect(this.master)
    src.start(t0)
  }
}

const s = new Synth()

// 이벤트별 신스 레시피 — tools/render-audio.mjs가 같은 테이블을 사용 (동기화 주의)
export const sfx = {
  shoot: () => logEvent('shoot') || s.tone(880, 0.08, { type: 'sawtooth', slideTo: 220, volume: 0.25 }),
  meleeSwing: () =>
    logEvent('meleeSwing') || s.noise(0.09, { volume: 0.2, filterFrom: 1200, filterTo: 400 }),
  meleeHit: () => {
    if (logEvent('meleeHit')) return
    s.noise(0.12, { volume: 0.5, filterFrom: 2500, filterTo: 300 })
    s.tone(160, 0.1, { type: 'square', slideTo: 60, volume: 0.4 })
  },
  enemyHit: () => logEvent('enemyHit') || s.tone(300, 0.06, { type: 'triangle', slideTo: 150, volume: 0.3 }),
  enemyDie: () => {
    if (logEvent('enemyDie')) return
    s.noise(0.25, { volume: 0.55, filterFrom: 4000, filterTo: 120 })
    s.tone(220, 0.2, { type: 'sawtooth', slideTo: 40, volume: 0.35 })
  },
  playerHurt: () => {
    if (logEvent('playerHurt')) return
    s.tone(140, 0.18, { type: 'square', slideTo: 70, volume: 0.5 })
    s.noise(0.12, { volume: 0.3 })
  },
  dash: () => logEvent('dash') || s.tone(500, 0.12, { type: 'sine', slideTo: 900, volume: 0.25 }),
  lungeWarn: () => logEvent('lungeWarn') || s.tone(650, 0.12, { type: 'square', slideTo: 650, volume: 0.18 }),
  waveStart: () => {
    if (logEvent('waveStart')) return
    s.tone(196, 0.14, { type: 'square', volume: 0.3 })
    s.tone(294, 0.14, { type: 'square', volume: 0.3, delay: 0.12 })
    s.tone(392, 0.22, { type: 'square', volume: 0.35, delay: 0.24 })
  },
  taunt: () => logEvent('taunt') || s.tone(1200, 0.05, { type: 'sine', slideTo: 1600, volume: 0.15 }),
  anomaly: () => {
    if (logEvent('anomaly')) return
    s.noise(0.32, { volume: 0.35, filterFrom: 5000, filterTo: 180 })
    s.tone(110, 0.42, { type: 'sawtooth', slideTo: 880, volume: 0.38 })
    s.tone(440, 0.28, { type: 'sine', slideTo: 1760, volume: 0.24, delay: 0.08 })
  },
  victory: () => {
    if (logEvent('victory')) return
    ;[262, 330, 392, 523].forEach((f, i) => s.tone(f, 0.22, { type: 'triangle', volume: 0.35, delay: i * 0.13 }))
  },
  defeat: () => {
    if (logEvent('defeat')) return
    ;[392, 330, 262, 196].forEach((f, i) => s.tone(f, 0.3, { type: 'sawtooth', volume: 0.3, delay: i * 0.16 }))
  },
}
