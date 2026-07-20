import type {
  AnomalyEvaluation,
  PredictionContract,
  TelemetryDigest,
} from '../ai/schema'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** 프로파일은 LLM 생성 + localStorage 경유라 신뢰 불가 텍스트 — innerHTML 삽입 전 이스케이프 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

type PredictionTarget = PredictionContract['target']

const TARGET_LABELS: Record<PredictionTarget, string> = {
  dodge_left: '왼쪽 이동을 반복한다',
  dodge_right: '오른쪽 이동을 반복한다',
  melee: '근접 공격에 집착한다',
  ranged: '원거리 공격을 고수한다',
  center: '아레나 중앙으로 모인다',
  edge: '아레나 외곽에 머문다',
  unreadable: 'UNREADABLE',
}

const EMP_GOALS: Record<PredictionTarget, string> = {
  dodge_left: '오른쪽 이동 60% · 2.5초 관측',
  dodge_right: '왼쪽 이동 60% · 2.5초 관측',
  melee: '원거리 피해 60% · 총 80 피해',
  ranged: '근접 피해 60% · 총 80 피해',
  center: '외곽 평균 거리 55% 이상 · 5초',
  edge: '중앙 평균 거리 45% 이하 · 5초',
  unreadable: '균형 패턴 유지',
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
  private prediction = $<HTMLElement>('prediction')
  private predictionLabel = $<HTMLDivElement>('prediction-label')
  private predictionSource = $<HTMLDivElement>('prediction-source')
  private anomalyReadout = $<HTMLDivElement>('anomaly-readout')
  private anomalyProgress = $<HTMLDivElement>('anomaly-progress')
  private anomalyProgressBar = $<HTMLDivElement>('anomaly-progress-bar')
  private anomalyEmp = $<HTMLDivElement>('anomaly-emp')
  private tauntTimer: ReturnType<typeof setTimeout> | undefined
  private typeTimer: ReturnType<typeof setInterval> | undefined
  private empTimer: ReturnType<typeof setTimeout> | undefined
  private upgradeCleanup: (() => void) | undefined
  private predictionKey = ''

  setHp(pct: number): void {
    const safePct = Math.min(100, Math.max(0, pct))
    this.hpBar.style.width = `${safePct}%`
    this.hpBar.parentElement?.setAttribute('aria-valuenow', String(Math.round(safePct)))
    this.hpBar.classList.toggle('low', safePct < 35)
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
    const safePct = Math.min(100, Math.max(0, pct))
    ;(document.getElementById('boss-bar') as HTMLElement).style.width = `${safePct}%`
    document.getElementById('boss-bar-bg')?.setAttribute('aria-valuenow', String(Math.round(safePct)))
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

  /** 현재 오버마인드의 공개 예측 — 전투 중 계속 보이는 심리전 계약. */
  showPrediction(contract: PredictionContract | null): void {
    if (!contract) {
      this.predictionKey = ''
      this.prediction.classList.add('hidden')
      this.prediction.removeAttribute('data-target')
      this.setAnomalyProgress(null)
      return
    }
    const nextKey = `${contract.sourceWave}:${contract.target}:${contract.observedPct}`
    if (nextKey !== this.predictionKey) {
      this.predictionKey = nextKey
      this.setAnomalyProgress(null)
    }
    const observedPct = Math.round(Math.min(100, Math.max(0, contract.observedPct)))
    this.prediction.dataset.target = contract.target
    this.predictionLabel.textContent = TARGET_LABELS[contract.target]
    this.predictionSource.textContent =
      contract.target === 'unreadable'
        ? `WAVE ${contract.sourceWave} · 패턴 균형 유지`
        : `WAVE ${contract.sourceWave} 관측치 ${observedPct}%`
    this.anomalyReadout.textContent =
      contract.target === 'unreadable'
        ? '패턴 없음 · 웨이브 종료 보너스'
        : `EMP 목표 · ${EMP_GOALS[contract.target]}`
    this.anomalyProgress.setAttribute('aria-valuetext', this.anomalyReadout.textContent)
    this.prediction.classList.remove('hidden')
  }

  /** 현재 행동이 AI 예측에서 얼마나 벗어났는지 0..1 진행도로 표시. */
  setAnomalyProgress(evaluation: AnomalyEvaluation | null): void {
    if (!evaluation) {
      this.anomalyReadout.textContent = 'EMP 목표 분석 중'
      this.anomalyProgressBar.style.width = '0%'
      this.anomalyProgress.setAttribute('aria-valuenow', '0')
      this.anomalyProgress.setAttribute('aria-valuetext', 'EMP 목표 분석 중')
      this.prediction.classList.remove('is-broken', 'is-unreadable')
      return
    }

    const progressPct = Math.round(Math.min(1, Math.max(0, evaluation.progress)) * 100)
    this.anomalyProgressBar.style.width = `${progressPct}%`
    this.anomalyProgress.setAttribute('aria-valuenow', String(progressPct))
    this.prediction.classList.toggle('is-broken', evaluation.status === 'broken')
    this.prediction.classList.toggle('is-unreadable', evaluation.status === 'unreadable')

    switch (evaluation.status) {
      case 'insufficient':
        this.anomalyReadout.textContent = `EMP 충전 ${progressPct}% · ${EMP_GOALS[evaluation.target]}`
        break
      case 'tracking':
        this.anomalyReadout.textContent = `EMP 충전 ${progressPct}% · ${EMP_GOALS[evaluation.target]}`
        break
      case 'broken':
        this.anomalyReadout.textContent = '예측 파괴 → EMP 발동'
        break
      case 'unreadable':
        this.anomalyReadout.textContent = '패턴 없음 · 웨이브 종료 보너스'
        break
    }
    this.anomalyProgress.setAttribute('aria-valuetext', this.anomalyReadout.textContent)
  }

  /** 균형 플레이 보상을 인터미션 리포트에 표시. */
  showUnreadable(bonus = 0): void {
    if (bonus <= 0) return
    let reward = this.report.querySelector<HTMLDivElement>('.report-unreadable')
    if (!reward) {
      reward = document.createElement('div')
      reward.className = 'report-unreadable'
      this.report.appendChild(reward)
    }
    reward.textContent = `UNREADABLE · 점수 +${bonus.toLocaleString()}`
  }

  /** 예측 파괴 보상 — 원인과 효과는 예측 카드에, 화면에는 청백 펄스만 표시. */
  showAnomalyEmp(bonus: number, target: PredictionTarget): void {
    clearTimeout(this.empTimer)
    const safeBonus = Math.max(0, Math.round(bonus)).toLocaleString()
    this.anomalyReadout.textContent =
      `EMP 발동 · ${EMP_GOALS[target]} 성공 · 적탄 제거·일반 적 1.25초 기절 · 점수 +${safeBonus}`
    this.anomalyProgress.setAttribute('aria-valuenow', '100')
    this.anomalyProgress.setAttribute('aria-valuetext', this.anomalyReadout.textContent)
    this.anomalyProgressBar.style.width = '100%'
    this.prediction.classList.add('is-broken')
    this.anomalyEmp.className = ''
    void this.anomalyEmp.offsetWidth
    this.anomalyEmp.classList.add('emp-active')
    this.empTimer = setTimeout(() => this.anomalyEmp.classList.add('hidden'), 1450)
  }

  /** 업그레이드 3택 카드 표시 — 선택 시 onPick(index) 후 자동 숨김 */
  showUpgrades(choices: { name: string; desc: string }[], onPick: (i: number) => void): void {
    const el = document.getElementById('upgrades') as HTMLDivElement
    this.clearUpgradeInteraction()
    el.innerHTML =
      '<div class="upg-hint" id="upg-hint">강화 선택 — 1·2·3 또는 방향키</div>' +
      choices
        .map((c, i) => `<button type="button" class="upg-card" data-i="${i}" aria-describedby="upg-hint"><span class="upg-key" aria-hidden="true">${i + 1}</span><span class="upg-name">${escapeHtml(c.name)}</span><span class="upg-desc">${escapeHtml(c.desc)}</span></button>`)
        .join('')
    el.classList.remove('hidden')
    const cards = [...el.querySelectorAll<HTMLButtonElement>('.upg-card')]
    let selected = 0
    let settled = false
    const focusCard = (index: number): void => {
      selected = (index + cards.length) % cards.length
      cards[selected]?.focus()
    }
    const pick = (index: number): void => {
      if (settled || !cards[index]) return
      settled = true
      el.classList.add('hidden')
      this.clearUpgradeInteraction()
      onPick(index)
    }
    cards.forEach((card, index) => (card.onclick = () => pick(index)))
    const onKeyDown = (event: KeyboardEvent): void => {
      const numberMatch = /^(?:Digit|Numpad)([1-3])$/.exec(event.code)
      if (numberMatch) {
        event.preventDefault()
        pick(Number(numberMatch[1]) - 1)
        return
      }
      if (event.code === 'ArrowRight' || event.code === 'ArrowDown') {
        event.preventDefault()
        focusCard(selected + 1)
      } else if (event.code === 'ArrowLeft' || event.code === 'ArrowUp') {
        event.preventDefault()
        focusCard(selected - 1)
      } else if (event.code === 'Enter') {
        event.preventDefault()
        pick(selected)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    this.upgradeCleanup = () => document.removeEventListener('keydown', onKeyDown)
    requestAnimationFrame(() => focusCard(0))
  }

  hideUpgrades(): void {
    const upgrades = document.getElementById('upgrades')
    if (upgrades?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
    upgrades?.classList.add('hidden')
    this.clearUpgradeInteraction()
  }

  private clearUpgradeInteraction(): void {
    this.upgradeCleanup?.()
    this.upgradeCleanup = undefined
  }

  /** 새 판 시작 시 이전 판의 예측·EMP 잔상을 모두 정리. */
  resetTransient(): void {
    this.showPrediction(null)
    clearTimeout(this.empTimer)
    this.anomalyEmp.className = 'hidden'
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

  /** 자동 시작에서도 초기 부팅/타이틀 오버레이와 HUD 차단을 확실히 해제. */
  beginGameplay(): void {
    this.screen.classList.add('hidden')
    document.getElementById('hud')?.classList.remove('screen-open')
  }

  showScreen(title: string, desc: string, button: string, onClick: () => void): void {
    document.getElementById('hud')?.classList.add('screen-open')
    this.screenTitle.textContent = title
    this.screenDesc.textContent = desc
    this.screenBtn.textContent = button
    this.screenBtn.disabled = false
    this.screen.classList.remove('booting')
    this.screen.setAttribute('aria-busy', 'false')
    this.screen.classList.remove('hidden')
    this.screenBtn.onclick = () => {
      this.beginGameplay()
      onClick()
    }
  }
}
