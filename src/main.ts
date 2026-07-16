import { Game } from './game/game'
import { loadModels } from './game/models'
import { initSession } from './ai/director'

// 모델 선로드 + 세션 토큰 발급 (둘 다 실패해도 게임은 폴백으로 진행)
await Promise.all([loadModels(), initSession()])

const canvas = document.getElementById('game') as HTMLCanvasElement
const game = new Game(canvas)

// 고정 스텝 업데이트 + rAF 렌더 — 탭 비활성 후 복귀 시 dt 폭주 방지 클램프
const params = new URLSearchParams(location.search)
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
