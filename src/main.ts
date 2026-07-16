import { Game } from './game/game'
import { loadModels } from './game/models'

// 모델 선로드 (총 ~170KB) — 실패해도 기본 도형으로 진행
await loadModels()

const canvas = document.getElementById('game') as HTMLCanvasElement
const game = new Game(canvas)

// 고정 스텝 업데이트 + rAF 렌더 — 탭 비활성 후 복귀 시 dt 폭주 방지 클램프
// ?timescale=N — 헤드리스 검증·밸런스 테스트용 배속 (기본 1)
const timescale = Number(new URLSearchParams(location.search).get('timescale')) || 1

let last = performance.now()
function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 1 / 20) * timescale
  last = now
  game.update(dt)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
