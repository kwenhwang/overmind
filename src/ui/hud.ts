const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

export class Hud {
  private hpBar = $<HTMLDivElement>('hp-bar')
  private waveLabel = $<HTMLDivElement>('wave-label')
  private taunt = $<HTMLDivElement>('taunt')
  private intermission = $<HTMLDivElement>('intermission')
  private screen = $<HTMLDivElement>('screen')
  private screenTitle = $<HTMLHeadingElement>('screen-title')
  private screenDesc = $<HTMLParagraphElement>('screen-desc')
  private screenBtn = $<HTMLButtonElement>('screen-btn')
  private tauntTimer: ReturnType<typeof setTimeout> | undefined

  setHp(pct: number): void {
    this.hpBar.style.width = `${Math.max(0, pct)}%`
    this.hpBar.classList.toggle('low', pct < 35)
  }

  setWave(current: number, total: number): void {
    this.waveLabel.textContent = `WAVE ${current} / ${total}`
  }

  showTaunt(text: string, seconds = 6): void {
    clearTimeout(this.tauntTimer)
    this.taunt.textContent = text
    this.taunt.classList.remove('hidden')
    this.tauntTimer = setTimeout(() => this.taunt.classList.add('hidden'), seconds * 1000)
  }

  showIntermission(text: string): void {
    this.intermission.textContent = text
    this.intermission.classList.remove('hidden')
  }

  hideIntermission(): void {
    this.intermission.classList.add('hidden')
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
