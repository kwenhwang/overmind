import type { TelemetryDigest } from '../ai/schema'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

export class Hud {
  private hpBar = $<HTMLDivElement>('hp-bar')
  private waveLabel = $<HTMLDivElement>('wave-label')
  private taunt = $<HTMLDivElement>('taunt')
  private intermission = $<HTMLDivElement>('intermission')
  private report = $<HTMLDivElement>('report')
  private screen = $<HTMLDivElement>('screen')
  private screenTitle = $<HTMLHeadingElement>('screen-title')
  private screenDesc = $<HTMLParagraphElement>('screen-desc')
  private screenBtn = $<HTMLButtonElement>('screen-btn')
  private tauntTimer: ReturnType<typeof setTimeout> | undefined
  private typeTimer: ReturnType<typeof setInterval> | undefined

  setHp(pct: number): void {
    this.hpBar.style.width = `${Math.max(0, pct)}%`
    this.hpBar.classList.toggle('low', pct < 35)
  }

  setWave(current: number, total: number): void {
    this.waveLabel.textContent = `WAVE ${current} / ${total}`
  }

  setScore(score: number, combo: number): void {
    const scoreEl = document.getElementById('score')
    if (!scoreEl) return
    scoreEl.innerHTML =
      `<span class="score-num">${score.toLocaleString()}</span>` +
      (combo >= 2 ? `<span class="combo">×${combo}</span>` : '')
  }

  /** 조롱 대사 — 한 글자씩 타이핑 (AI가 말하는 질감) */
  showTaunt(text: string, seconds = 7): void {
    clearTimeout(this.tauntTimer)
    clearInterval(this.typeTimer)
    this.taunt.textContent = ''
    this.taunt.classList.remove('hidden')
    let i = 0
    this.typeTimer = setInterval(() => {
      i++
      this.taunt.textContent = text.slice(0, i)
      if (i >= text.length) clearInterval(this.typeTimer)
    }, 28)
    this.tauntTimer = setTimeout(() => this.taunt.classList.add('hidden'), seconds * 1000)
  }

  showIntermission(text: string): void {
    this.intermission.textContent = text
    this.intermission.classList.remove('hidden')
  }

  hideIntermission(): void {
    this.intermission.classList.add('hidden')
  }

  /** 인터미션 관찰 리포트 — 오버마인드가 "본 것"을 그대로 보여줘 AI의 존재를 증명 */
  showReport(d: TelemetryDigest): void {
    if (d.wave === 0) {
      this.report.innerHTML = `<div class="report-title">OVERMIND 기동</div>
        <div class="report-row">관측 데이터 없음 — 수집을 시작한다</div>`
    } else {
      this.report.innerHTML = `<div class="report-title">관찰 리포트 — WAVE ${d.wave}</div>
        <div class="report-row">회피 편향 <b>← ${d.dodgeLeftPct}%</b> / <b>${d.dodgeRightPct}% →</b></div>
        <div class="report-row">무기 선호 근접 <b>${d.meleeUsePct}%</b> · 원거리 <b>${d.rangedUsePct}%</b></div>
        <div class="report-row">평균 위치 중심에서 <b>${Math.round(d.avgDistToCenter * 100)}%</b> · 피해 <b>${d.damageTakenThisWave}</b></div>
        <div class="report-counter hidden" id="report-counter"></div>`
    }
    this.report.classList.remove('hidden')
  }

  /** LLM 설계 도착 시 — 무엇을 노렸는지 공개 (관찰→카운터 인과 시각화) */
  showCounter(reason: string): void {
    const el = document.getElementById('report-counter')
    if (!el) return
    el.textContent = `▶ 대응: ${reason}`
    el.classList.remove('hidden')
  }

  hideReport(): void {
    this.report.classList.add('hidden')
  }

  showScreen(title: string, desc: string, button: string, onClick: () => void): void {
    this.screenTitle.textContent = title
    this.screenDesc.textContent = desc
    this.screenBtn.textContent = button
    this.screen.classList.remove('hidden')
    this.screenBtn.onclick = () => {
      this.screen.classList.add('hidden')
      onClick()
    }
  }
}
