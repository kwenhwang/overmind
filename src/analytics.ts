/**
 * umami 계측 — "몇 명이 시작해서, 몇 명이 끝까지 갔는가" 두 지점만 본다.
 *
 * 원칙 셋:
 *  1. **게임을 절대 막지 않는다.** 트래커가 광고차단기에 막히거나 서버가 죽어도
 *     여기서 던지는 예외는 전부 삼킨다. 계측 때문에 심사자 화면이 멈추면 본말전도다.
 *  2. **스크립트 태그는 index.html에 정적으로 둔다**(동적 주입 금지). 운영 커버리지
 *     점검(`/data/ops/umami-coverage-check.sh`)이 라이브 HTML 원문에서
 *     `analytics.naru.build/script.js`를 grep해 ①발화 여부를 판정하기 때문에,
 *     JS로 주입하면 소스엔 있는데 점검엔 '미계측'으로 찍힌다.
 *  3. **헤드리스·검증 트래픽은 숨기지 않고 표시한다**(`probe=1`). 지우면 사람 방문과
 *     구분이 영영 불가능해지고, 남기면 대시보드에서 걸러낼 수 있다.
 *
 * 이벤트 3종 (퍼널: 시작 → 종료 → 완주)
 *  · `play_start` START(또는 RETRY)로 판이 시작된 순간
 *  · `run_end`    판이 끝난 순간 (승리·사망 공통, `result`로 구분)
 *  · `run_clear`  **완주** — 보스를 파괴하고 이긴 판만
 */

/** umami 트래커가 붙기 전에 발생한 이벤트를 흘리지 않기 위한 대기 한도 */
const TRACKER_WAIT_MS = 8000
const TRACKER_POLL_MS = 400
/** 대기 큐 상한 — 트래커가 영영 안 붙는 환경(차단기)에서 메모리를 물지 않는다 */
const QUEUE_MAX = 8

export type TrackProps = Record<string, string | number>

interface UmamiTracker {
  track: (name: string, props?: TrackProps) => void
}

interface Pending {
  name: string
  props: TrackProps
}

const queue: Pending[] = []
let pollTimer: ReturnType<typeof setTimeout> | null = null
let waitedMs = 0
/** 판 시작 시각 — 플레이 길이(초)를 게임 코드가 따로 들고 다니지 않게 여기서 잰다 */
let runStartedAt = 0

function tracker(): UmamiTracker | null {
  const holder = globalThis as { umami?: Partial<UmamiTracker> }
  const u = holder.umami
  return u && typeof u.track === 'function' ? (u as UmamiTracker) : null
}

/** 검증 자동화(Playwright 등)로 들어온 트래픽인지 — 숨기지 않고 라벨만 붙인다 */
function isProbe(): boolean {
  const nav = (globalThis as { navigator?: { webdriver?: boolean } }).navigator
  return nav?.webdriver === true
}

function flush(): void {
  const t = tracker()
  if (!t) return
  while (queue.length) {
    const item = queue.shift() as Pending
    try {
      t.track(item.name, item.props)
    } catch {
      /* 계측 실패는 게임에 영향을 주지 않는다 */
    }
  }
}

function schedulePoll(): void {
  if (pollTimer !== null || typeof setTimeout !== 'function') return
  pollTimer = setTimeout(() => {
    pollTimer = null
    waitedMs += TRACKER_POLL_MS
    flush()
    if (queue.length && waitedMs < TRACKER_WAIT_MS) schedulePoll()
    else if (queue.length) queue.length = 0 // 포기 — 차단된 환경
  }, TRACKER_POLL_MS)
}

/**
 * 이벤트 발사. 트래커가 아직 안 붙었으면(defer 로드 경합) 큐에 넣고 짧게 재시도한다.
 * `play_start`는 퍼널의 분모라 한 번 흘리면 완주율 자체가 틀어지므로 큐가 필요하다.
 */
export function track(name: string, props: TrackProps): void {
  const payload: TrackProps = isProbe() ? { ...props, probe: 1 } : { ...props }
  try {
    const t = tracker()
    if (t) {
      flush()
      t.track(name, payload)
      return
    }
  } catch {
    /* 아래 큐로 흘려보낸다 */
  }
  if (queue.length >= QUEUE_MAX) queue.shift()
  queue.push({ name, props: payload })
  schedulePoll()
}

export interface RunEndInfo {
  victory: boolean
  wave: number
  score: number
  mode: string
  version: string
  /** 판 길이(초). 생략하면 play_start 시각에서 계산 */
  seconds?: number
}

/** 판 종료 이벤트의 props — 순수 함수(테스트가 여기를 본다) */
export function runEndProps(info: RunEndInfo, seconds: number): TrackProps {
  return {
    result: info.victory ? 'victory' : 'died',
    wave: info.wave,
    score: Math.round(info.score),
    mode: info.mode,
    ver: info.version,
    sec: seconds,
  }
}

export function trackPlayStart(info: { mode: string; version: string }): void {
  runStartedAt = Date.now()
  track('play_start', { mode: info.mode, ver: info.version, build: __BUILD__ })
}

export function trackRunEnd(info: RunEndInfo): void {
  const seconds = info.seconds ?? (runStartedAt ? Math.round((Date.now() - runStartedAt) / 1000) : 0)
  const props = runEndProps(info, seconds)
  track('run_end', props)
  // 완주는 별도 이름으로 한 번 더 — 대시보드에서 '이긴 판'을 필터 없이 바로 센다.
  if (info.victory) track('run_clear', props)
  runStartedAt = 0
}

/** 테스트 전용 — 모듈 내부 상태 초기화 */
export function _resetForTest(): void {
  queue.length = 0
  waitedMs = 0
  runStartedAt = 0
  if (pollTimer !== null && typeof clearTimeout === 'function') clearTimeout(pollTimer)
  pollTimer = null
}
