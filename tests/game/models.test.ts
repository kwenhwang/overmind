import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { EMISSIVE_PEAK, clampEmissive, configureMaterial, flashMats } from '../../src/game/models'

const mat = (emissive: number, intensity: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ emissive, emissiveIntensity: intensity })

describe('flashMats — 피격 플래시 복구', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('60ms 뒤 원래 발광색으로 돌아온다', () => {
    const m = mat(0xff5f2e, 1)
    flashMats([m])
    expect(m.emissive.getHex()).toBe(0xffffff)
    vi.advanceTimersByTime(60)
    expect(m.emissive.getHex()).toBe(0xff5f2e)
  })

  it('플래시가 겹쳐도 흰색으로 고착되지 않는다 (보스 난타 = 흰 덩어리 회귀)', () => {
    const m = mat(0xff5f2e, 1)
    flashMats([m]) // 1타
    vi.advanceTimersByTime(20)
    flashMats([m]) // 60ms 안에 2타 — 예전 구현은 여기서 '흰색'을 원본으로 기억했다
    vi.advanceTimersByTime(20)
    flashMats([m]) // 3타
    vi.advanceTimersByTime(200)
    expect(m.emissive.getHex()).toBe(0xff5f2e)
  })

  it('연타가 끝날 때까지 플래시가 유지되고 마지막 타격 기준 60ms에 복구된다', () => {
    const m = mat(0x112233, 1)
    flashMats([m])
    vi.advanceTimersByTime(50)
    flashMats([m])
    vi.advanceTimersByTime(50)
    expect(m.emissive.getHex()).toBe(0xffffff) // 마지막 타격 후 50ms — 아직 플래시 중
    vi.advanceTimersByTime(20)
    expect(m.emissive.getHex()).toBe(0x112233)
  })
})

describe('clampEmissive — 발광 포화 상한', () => {
  it('저작 강도가 과하면 채널 피크를 상한으로 내린다 (보스 눈동자 16·홍채 5)', () => {
    const pupil = mat(0xfff9ed, 16)
    clampEmissive(pupil)
    const peak = Math.max(pupil.emissive.r, pupil.emissive.g, pupil.emissive.b)
    expect(peak * pupil.emissiveIntensity).toBeLessThanOrEqual(EMISSIVE_PEAK + 1e-6)
    expect(pupil.emissiveIntensity).toBeLessThan(16)
  })

  it('상한 이하는 건드리지 않는다', () => {
    const dim = mat(0xff9545, 0.5)
    clampEmissive(dim)
    expect(dim.emissiveIntensity).toBe(0.5)
  })

  it('발광이 없는 장갑 셸은 그대로 둔다', () => {
    const shell = mat(0x000000, 1)
    clampEmissive(shell)
    expect(shell.emissiveIntensity).toBe(1)
  })

  it('모델 로드 경로(configureMaterial)가 상한을 적용한다', () => {
    const iris = mat(0xffd486, 5)
    configureMaterial(iris, 'boss')
    expect(iris.emissiveIntensity * Math.max(iris.emissive.r, iris.emissive.g, iris.emissive.b))
      .toBeLessThanOrEqual(EMISSIVE_PEAK + 1e-6)
  })
})
