/**
 * 절차 생성 SFX — 외부 오디오 에셋 없이 WebAudio 신스로 전부 해결.
 * (라이선스 이슈 0, 용량 0. 첫 사용자 입력에서 AudioContext 언락)
 */
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

export const sfx = {
  shoot: () => s.tone(880, 0.08, { type: 'sawtooth', slideTo: 220, volume: 0.25 }),
  meleeSwing: () => s.noise(0.09, { volume: 0.2, filterFrom: 1200, filterTo: 400 }),
  meleeHit: () => {
    s.noise(0.12, { volume: 0.5, filterFrom: 2500, filterTo: 300 })
    s.tone(160, 0.1, { type: 'square', slideTo: 60, volume: 0.4 })
  },
  enemyHit: () => s.tone(300, 0.06, { type: 'triangle', slideTo: 150, volume: 0.3 }),
  enemyDie: () => {
    s.noise(0.25, { volume: 0.55, filterFrom: 4000, filterTo: 120 })
    s.tone(220, 0.2, { type: 'sawtooth', slideTo: 40, volume: 0.35 })
  },
  playerHurt: () => {
    s.tone(140, 0.18, { type: 'square', slideTo: 70, volume: 0.5 })
    s.noise(0.12, { volume: 0.3 })
  },
  dash: () => s.tone(500, 0.12, { type: 'sine', slideTo: 900, volume: 0.25 }),
  lungeWarn: () => s.tone(650, 0.12, { type: 'square', slideTo: 650, volume: 0.18 }),
  waveStart: () => {
    s.tone(196, 0.14, { type: 'square', volume: 0.3 })
    s.tone(294, 0.14, { type: 'square', volume: 0.3, delay: 0.12 })
    s.tone(392, 0.22, { type: 'square', volume: 0.35, delay: 0.24 })
  },
  taunt: () => s.tone(1200, 0.05, { type: 'sine', slideTo: 1600, volume: 0.15 }),
  victory: () => {
    ;[262, 330, 392, 523].forEach((f, i) => s.tone(f, 0.22, { type: 'triangle', volume: 0.35, delay: i * 0.13 }))
  },
  defeat: () => {
    ;[392, 330, 262, 196].forEach((f, i) => s.tone(f, 0.3, { type: 'sawtooth', volume: 0.3, delay: i * 0.16 }))
  },
}
