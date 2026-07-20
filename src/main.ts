import { Game } from './game/game'
import { loadModels } from './game/models'
import { initSession } from './ai/director'
import { GAME_VERSION } from './game/config'

const params = new URLSearchParams(location.search)
const debugMode = params.has('debug')

// 일반 화면에는 게임 버전을, 디버그 화면에는 빌드 식별자까지 표시한다.
const ver = document.createElement('div')
ver.id = 'ver'
ver.textContent = debugMode ? `${GAME_VERSION} · ${__BUILD__}` : GAME_VERSION
ver.setAttribute('aria-hidden', 'true')
document.body.appendChild(ver)

// 세션 발급은 게임 준비를 절대 막지 않는다. 토큰이 늦거나 없어도 디렉터 폴백으로 진행.
void initSession().catch(() => undefined)

// 진단 기능은 ?debug에서만 노출.
if (debugMode) {
  document.getElementById('diag-btn')?.classList.remove('hidden')
}

// 모델이 하나도 로드되지 않아도 절차 도형 폴백으로 Game은 반드시 생성한다.
try {
  await loadModels()
} catch (error) {
  console.warn('model preload failed; using fallback geometry', error)
}

const canvas = document.getElementById('game') as HTMLCanvasElement
if (params.has('autostart')) {
  document.getElementById('screen')?.classList.add('hidden')
  document.getElementById('hud')?.classList.remove('screen-open')
}
const game = new Game(canvas)

// 고정 스텝 업데이트 + rAF 렌더 — 탭 비활성 후 복귀 시 dt 폭주 방지 클램프
// ?timescale=N — 헤드리스 검증·밸런스 테스트용 배속 (기본 1)
const timescale = Number(params.get('timescale')) || 1

if (params.has('record')) {
  // 녹화 모드: 실시간 rAF 대신 외부(Playwright)가 __step()으로 정확히 1/60초씩 전진.
  // 저사양 서버에서도 프레임 단위 캡처 → 60fps 인코딩으로 실기기 수준 영상 제작 가능.
  const w = window as unknown as { __frame: number; __step: () => void; __typeTick?: () => void }
  w.__frame = 0
  w.__step = () => {
    w.__frame++
    w.__typeTick?.()
    game.update(1 / 60)
  }
} else {
  let last = performance.now()
  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 1 / 20) * timescale
    last = now
    game.update(dt)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
