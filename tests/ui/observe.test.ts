import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { observationView, observeStatusText } from '../../src/ui/hud'
import { Telemetry, buildPredictionContract } from '../../src/ai/telemetry'
import type { BehaviorEvidence, TelemetryDigest } from '../../src/ai/schema'

function makeEvidence(overrides: Partial<BehaviorEvidence> = {}): BehaviorEvidence {
  return {
    dodgeLeftSeconds: 0,
    dodgeRightSeconds: 0,
    meleeDamage: 0,
    rangedDamage: 0,
    centerSeconds: 0,
    edgeSeconds: 0,
    avgDistToCenter: 0.5,
    ...overrides,
  }
}

function makeDigest(overrides: Partial<TelemetryDigest> = {}): TelemetryDigest {
  return {
    wave: 1,
    playerHpPct: 100,
    dodgeLeftPct: 50,
    dodgeRightPct: 50,
    meleeUsePct: 50,
    rangedUsePct: 50,
    avgDistToCenter: 0.5,
    damageTakenThisWave: 0,
    killsByType: {},
    waveClearSeconds: 0,
    ...overrides,
  }
}

describe('observationView', () => {
  it('표본 플로어 미달이면 전 축 50 중앙 + sampled false', () => {
    const view = observationView(makeDigest(), makeEvidence(), null)
    for (const axis of ['dodge', 'weapon', 'zone'] as const) {
      expect(view.axes[axis].leftPct).toBe(50)
      expect(view.axes[axis].sampled).toBe(false)
      expect(view.axes[axis].locked).toBe(false)
    }
    expect(view.lockedAxis).toBeNull()
    expect(observeStatusText('idle', view)).toBe('패턴 수집 대기')
    expect(observeStatusText('observing', view)).toBe('패턴 수집 중')
  })

  it('좌회피 편중 — 락 축이 buildPredictionContract 선택과 일치', () => {
    const evidence = makeEvidence({ dodgeLeftSeconds: 2.4, dodgeRightSeconds: 0.6 })
    const digest = makeDigest({ dodgeLeftPct: 80, dodgeRightPct: 20 })
    const contract = buildPredictionContract(1, evidence)
    expect(contract?.target).toBe('dodge_left')
    const view = observationView(digest, evidence, contract)
    expect(view.axes.dodge.leftPct).toBe(80)
    expect(view.axes.dodge.sampled).toBe(true)
    expect(view.axes.dodge.locked).toBe(true)
    expect(view.axes.dodge.hot).toBe(true) // 편차 30 ≥ 25
    expect(view.topAxis).toBe('dodge')
    expect(observeStatusText('observing', view)).toBe('습관 포착 — 회피 좌')
  })

  it('waveDigest 교차 검증 — 게이지 %가 인터미션 리포트와 동일 계열', () => {
    const telemetry = new Telemetry()
    telemetry.startWave()
    const pos = new THREE.Vector3(0, 0, 0)
    const left = new THREE.Vector3(-1, 0, 0)
    for (let i = 0; i < 30; i++) telemetry.tick(0.1, pos, left) // 좌로 3초
    const digest = telemetry.waveDigest(1, 100)
    const evidence = telemetry.currentEvidence()
    const view = observationView(digest, evidence, buildPredictionContract(1, evidence))
    expect(view.axes.dodge.leftPct).toBe(digest.dodgeLeftPct)
    expect(view.axes.dodge.leftPct).toBe(100)
    expect(view.axes.dodge.locked).toBe(true)
  })

  it('무기 표본 임계 직전(79.9)은 락 불가 — 임계는 contract가 판정', () => {
    const evidence = makeEvidence({ meleeDamage: 75, rangedDamage: 4.9 })
    const digest = makeDigest({ meleeUsePct: 94, rangedUsePct: 6 })
    const contract = buildPredictionContract(1, evidence)
    expect(contract).toBeNull() // 어떤 축도 표본 임계 미충족
    const view = observationView(digest, evidence, contract)
    expect(view.axes.weapon.sampled).toBe(true) // 표시 플로어(>0)는 충족 — 게이지는 움직임
    expect(view.axes.weapon.locked).toBe(false)
    expect(view.topAxis).toBe('weapon')
  })

  it('균형 유지(unreadable)는 락 없이 UNREADABLE 상태 문구', () => {
    const evidence = makeEvidence({ dodgeLeftSeconds: 1.3, dodgeRightSeconds: 1.3 })
    const contract = buildPredictionContract(1, evidence)
    expect(contract?.target).toBe('unreadable')
    const view = observationView(makeDigest(), evidence, contract)
    expect(view.lockedAxis).toBeNull()
    expect(view.unreadable).toBe(true)
    expect(observeStatusText('observing', view)).toBe('UNREADABLE — 균형 유지')
  })

  it('위치 축 — avgDistToCenter를 중앙 점유율로 반전 표시', () => {
    const digest = makeDigest({ avgDistToCenter: 0.8 })
    const evidence = makeEvidence({ centerSeconds: 1, edgeSeconds: 5, avgDistToCenter: 0.8 })
    const view = observationView(digest, evidence, null)
    expect(view.axes.zone.leftPct).toBe(20) // 중앙 20% = 외곽 80% 체류
    expect(view.axes.zone.sampled).toBe(true)
  })

  it('phase별 상태 문구', () => {
    const view = observationView(makeDigest(), makeEvidence(), null)
    expect(observeStatusText('redesigning', view)).toBe('카운터 재설계 중')
    expect(observeStatusText('ready', view)).toBe('재설계 수신')
    expect(observeStatusText('intermission', view)).toBe('분석 반영 중')
    expect(observeStatusText('boss', view)).toBe('프로파일 고정')
  })

  it('락 문구는 재설계 문구보다 우선 — 프리페치가 락보다 먼저 발화해도 킬러 모먼트 유지', () => {
    const evidence = makeEvidence({ dodgeLeftSeconds: 2.4, dodgeRightSeconds: 0.6 })
    const view = observationView(
      makeDigest({ dodgeLeftPct: 80, dodgeRightPct: 20 }),
      evidence,
      buildPredictionContract(1, evidence),
    )
    expect(observeStatusText('redesigning', view)).toBe('습관 포착 — 회피 좌')
    expect(observeStatusText('ready', view)).toBe('습관 포착 — 회피 좌')
  })
})
