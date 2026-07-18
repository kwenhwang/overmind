import type { TelemetryDigest } from '../ai/schema'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** 프로파일은 LLM 생성 + localStorage 경유라 신뢰 불가 텍스트 — innerHTML 삽입 전 이스케이프 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

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

  showBossBar(name: string): void {
    ;(document.getElementById('boss-name') as HTMLElement).textContent = name
    document.getElementById('boss-wrap')?.classList.remove('hidden')
    this.waveLabel.textContent = 'FINAL'
  }

  setBossPhaseName(name: string): void {
    ;(document.getElementById('boss-name') as HTMLElement).textContent = name
  }

  setBossHp(pct: number): void {
    ;(document.getElementById('boss-bar') as HTMLElement).style.width = `${Math.max(0, pct)}%`
  }

  hideBossBar(): void {
    document.getElementById('boss-wrap')?.classList.add('hidden')
  }

  setScore(score: number, combo: number): void {
    const scoreEl = document.getElementById('score')
    if (!scoreEl) return
    scoreEl.innerHTML =
      `<span class="score-num">${score.toLocaleString()}</span>` +
      (combo >= 2 ? `<span class="combo">×${combo}</span>` : '')
  }

  /** 조롱 대사 — 한 글자씩 타이핑 (AI가 말하는 질감). 녹화 모드는 프레임 기반 진행 */
  showTaunt(text: string, seconds = 4.5): void {
    clearTimeout(this.tauntTimer)
    clearInterval(this.typeTimer)
    this.taunt.textContent = ''
    this.taunt.classList.remove('hidden')
    if (new URLSearchParams(location.search).has('record')) {
      let chars = 0
      let frames = 0
      ;(window as unknown as Record<string, unknown>).__typeTick = () => {
        frames++
        if (chars < text.length) {
          chars += 0.6 // 프레임당 0.6자 ≈ 실시간 타이핑 감
          this.taunt.textContent = text.slice(0, Math.ceil(chars))
        }
        if (frames >= seconds * 60) {
          this.taunt.classList.add('hidden')
          ;(window as unknown as Record<string, unknown>).__typeTick = undefined
        }
      }
      return
    }
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

  /**
   * 인터미션 관찰 리포트 — 텍스트 과다 피드백 반영: 수치 나열 대신 '가장 두드러진 습관'
   * 하나만 크게 지목 + 대응 1줄. 3.5초 인터미션에 한눈에 읽히게.
   */
  showReport(d: TelemetryDigest, profile = ''): void {
    const memoryRow = profile ? `<div class="report-memory">${escapeHtml(profile)}</div>` : ''
    if (d.wave === 0) {
      this.report.innerHTML = `<div class="report-title">OVERMIND</div>
        ${memoryRow || '<div class="report-pick">관측 시작</div>'}
        <div class="report-counter hidden" id="report-counter"></div>`
    } else {
      this.report.innerHTML = `<div class="report-title">관찰 — WAVE ${d.wave}</div>
        <div class="report-pick">${this.topHabit(d)}</div>
        ${memoryRow}
        <div class="report-counter hidden" id="report-counter"></div>`
    }
    this.report.classList.remove('hidden')
  }

  /** 가장 편차가 큰 습관 하나를 골라 한 줄로 지목 */
  private topHabit(d: TelemetryDigest): string {
    const cands = [
      { dev: Math.abs(d.dodgeLeftPct - 50), text: d.dodgeLeftPct >= 50 ? `회피 <b>왼쪽 ${d.dodgeLeftPct}%</b>` : `회피 <b>오른쪽 ${d.dodgeRightPct}%</b>` },
      { dev: Math.abs(d.meleeUsePct - 50), text: d.meleeUsePct >= 50 ? `<b>근접 선호 ${d.meleeUsePct}%</b>` : `<b>원거리 선호 ${d.rangedUsePct}%</b>` },
      { dev: Math.abs(d.avgDistToCenter - 0.5) * 100, text: d.avgDistToCenter >= 0.5 ? `<b>외곽 ${Math.round(d.avgDistToCenter * 100)}%</b> 체류` : `<b>중앙 밀집</b>` },
    ]
    return cands.sort((a, b) => b.dev - a.dev)[0].text
  }

  /** LLM 설계 도착 시 — 무엇을 노렸는지 공개 (관찰→카운터 인과 시각화) */
  showCounter(reason: string): void {
    const el = document.getElementById('report-counter')
    if (!el) return
    el.textContent = `▶ 대응: ${reason}`
    el.classList.remove('hidden')
    // 공개 순간 펀치 애니 (재적용 위해 리플로우)
    el.classList.remove('reveal')
    void el.offsetWidth
    el.classList.add('reveal')
  }

  hideReport(): void {
    this.report.classList.add('hidden')
  }

  /** 업그레이드 3택 카드 표시 — 선택 시 onPick(index) 후 자동 숨김 */
  showUpgrades(choices: { name: string; desc: string }[], onPick: (i: number) => void): void {
    const el = document.getElementById('upgrades') as HTMLDivElement
    el.innerHTML =
      '<div class="upg-hint">강화 선택 — 오버마인드에 맞서 진화하라</div>' +
      choices
        .map((c, i) => `<div class="upg-card" data-i="${i}"><div class="upg-name">${escapeHtml(c.name)}</div><div class="upg-desc">${escapeHtml(c.desc)}</div></div>`)
        .join('')
    el.classList.remove('hidden')
    el.querySelectorAll<HTMLElement>('.upg-card').forEach((card) => {
      card.onclick = () => {
        el.classList.add('hidden')
        onPick(Number(card.dataset.i))
      }
    })
  }

  hideUpgrades(): void {
    document.getElementById('upgrades')?.classList.add('hidden')
  }

  /**
   * 게임오버/승리 화면에 리더보드 표시 + 이름 등록.
   * onSubmit(name)은 '등록' 클릭 시 호출(점수 제출 후 갱신된 board로 다시 render).
   */
  showLeaderboard(
    board: { name: string; score: number; wave: number }[],
    myScore: number,
    savedName: string,
    onSubmit: (name: string) => void,
  ): void {
    const wrap = document.getElementById('board-wrap') as HTMLDivElement
    const list = document.getElementById('board-list') as HTMLOListElement
    const nameInput = document.getElementById('name-input') as HTMLInputElement
    const saveBtn = document.getElementById('name-save') as HTMLButtonElement
    wrap.classList.remove('hidden')
    nameInput.value = savedName
    let myMarked = false
    list.innerHTML = board
      .slice(0, 10)
      .map((e) => {
        const mine = !myMarked && e.score === myScore && e.name === savedName
        if (mine) myMarked = true
        return `<li class="${mine ? 'me' : ''}"><span class="bn">${escapeHtml(e.name)}</span><span>${e.score.toLocaleString()}</span></li>`
      })
      .join('')
    saveBtn.onclick = () => {
      const n = nameInput.value.trim().slice(0, 12) || '플레이어'
      onSubmit(n)
    }
  }

  hideLeaderboard(): void {
    document.getElementById('board-wrap')?.classList.add('hidden')
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
