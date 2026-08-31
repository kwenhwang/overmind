import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTest, runEndProps, track, trackPlayStart, trackRunEnd, type TrackProps } from '../src/analytics'

interface Sent { name: string; props?: TrackProps }

function installTracker(): Sent[] {
  const sent: Sent[] = []
  ;(globalThis as { umami?: unknown }).umami = {
    track: (name: string, props?: TrackProps) => { sent.push({ name, props }) },
  }
  return sent
}

function removeTracker(): void {
  delete (globalThis as { umami?: unknown }).umami
}

beforeEach(() => {
  _resetForTest()
  removeTracker()
  delete (globalThis as { navigator?: unknown }).navigator
})

afterEach(() => {
  vi.useRealTimers()
  _resetForTest()
  removeTracker()
})

describe('track', () => {
  it('트래커가 붙어 있으면 즉시 발사한다', () => {
    const sent = installTracker()
    track('play_start', { mode: 'desktop' })
    expect(sent).toEqual([{ name: 'play_start', props: { mode: 'desktop' } }])
  })

  it('트래커가 늦게 붙어도(defer 경합) 큐에 담았다가 발사한다 — 퍼널 분모를 흘리지 않는다', () => {
    vi.useFakeTimers()
    track('play_start', { mode: 'desktop' })
    const sent = installTracker()
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(500)
    expect(sent).toEqual([{ name: 'play_start', props: { mode: 'desktop' } }])
  })

  it('트래커가 영영 안 붙으면(차단기) 큐를 비우고 조용히 포기한다', () => {
    vi.useFakeTimers()
    track('play_start', { mode: 'desktop' })
    vi.advanceTimersByTime(20000)
    const sent = installTracker()
    vi.advanceTimersByTime(20000)
    expect(sent).toHaveLength(0)
  })

  it('트래커가 던져도 게임 흐름을 막지 않는다', () => {
    ;(globalThis as { umami?: unknown }).umami = { track: () => { throw new Error('blocked') } }
    expect(() => track('play_start', { mode: 'desktop' })).not.toThrow()
  })

  it('자동화 트래픽은 숨기지 않고 probe=1로 표시한다', () => {
    ;(globalThis as { navigator?: unknown }).navigator = { webdriver: true }
    const sent = installTracker()
    track('play_start', { mode: 'desktop' })
    expect(sent[0].props).toMatchObject({ mode: 'desktop', probe: 1 })
  })
})

describe('runEndProps', () => {
  it('승리는 result=victory', () => {
    expect(runEndProps({ victory: true, wave: 11, score: 12345.6, mode: 'desktop', version: 'v11' }, 300))
      .toEqual({ result: 'victory', wave: 11, score: 12346, mode: 'desktop', ver: 'v11', sec: 300 })
  })

  it('사망은 result=died', () => {
    expect(runEndProps({ victory: false, wave: 3, score: 100, mode: 'mobile', version: 'v11' }, 42).result)
      .toBe('died')
  })
})

describe('trackRunEnd', () => {
  it('완주(승리)만 run_clear를 추가로 쏜다 — 대시보드에서 완주 수를 바로 센다', () => {
    const sent = installTracker()
    trackRunEnd({ victory: true, wave: 11, score: 900, mode: 'desktop', version: 'v11', seconds: 10 })
    expect(sent.map((s) => s.name)).toEqual(['run_end', 'run_clear'])
  })

  it('사망 판은 run_end만 쏜다', () => {
    const sent = installTracker()
    trackRunEnd({ victory: false, wave: 4, score: 90, mode: 'desktop', version: 'v11', seconds: 10 })
    expect(sent.map((s) => s.name)).toEqual(['run_end'])
  })

  it('판 길이는 play_start 시각에서 잰다', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const sent = installTracker()
    trackPlayStart({ mode: 'desktop', version: 'v11' })
    vi.setSystemTime(new Date('2026-09-01T00:02:30Z'))
    trackRunEnd({ victory: false, wave: 5, score: 10, mode: 'desktop', version: 'v11' })
    expect(sent[1].props?.sec).toBe(150)
  })
})
