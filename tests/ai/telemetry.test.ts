import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { BehaviorEvidence, PredictionContract } from '../../src/ai/schema'
import {
  Telemetry,
  buildPredictionContract,
  evaluatePrediction,
} from '../../src/ai/telemetry'
import { ARENA_RADIUS } from '../../src/game/config'

const evidence = (overrides: Partial<BehaviorEvidence> = {}): BehaviorEvidence => ({
  dodgeLeftSeconds: 0,
  dodgeRightSeconds: 0,
  meleeDamage: 0,
  rangedDamage: 0,
  centerSeconds: 0,
  edgeSeconds: 0,
  avgDistToCenter: 0.5,
  ...overrides,
})

const contract = (target: PredictionContract['target']): PredictionContract => ({
  target,
  observedPct: 80,
  sourceWave: 1,
})

describe('prediction contracts', () => {
  it('requires at least a 12 percentage-point deviation', () => {
    expect(
      buildPredictionContract(
        1,
        evidence({ dodgeLeftSeconds: 1.525, dodgeRightSeconds: 0.975 }),
      ),
    ).toMatchObject({ target: 'unreadable', observedPct: 50 })

    expect(
      buildPredictionContract(
        1,
        evidence({ dodgeLeftSeconds: 1.55, dodgeRightSeconds: 0.95 }),
      ),
    ).toEqual({ target: 'dodge_left', observedPct: 62, sourceWave: 1 })
  })

  it('requires 2.5 seconds of dodge evidence before a dodge prediction breaks', () => {
    const gathering = evaluatePrediction(
      contract('dodge_left'),
      evidence({ dodgeLeftSeconds: 0.99, dodgeRightSeconds: 1.5 }),
    )
    expect(gathering).toMatchObject({ status: 'insufficient', sufficientEvidence: false })
    expect(gathering?.progress).toBeCloseTo(0.996)

    expect(
      evaluatePrediction(
        contract('dodge_left'),
        evidence({ dodgeLeftSeconds: 1, dodgeRightSeconds: 1.5 }),
      ),
    ).toMatchObject({ status: 'broken', targetPct: 40, sufficientEvidence: true })
  })

  it('requires 80 damage before a weapon prediction breaks', () => {
    expect(
      evaluatePrediction(contract('melee'), evidence({ meleeDamage: 31, rangedDamage: 48 })),
    ).toMatchObject({ status: 'insufficient', sufficientEvidence: false })

    expect(
      evaluatePrediction(contract('melee'), evidence({ meleeDamage: 32, rangedDamage: 48 })),
    ).toMatchObject({ status: 'broken', targetPct: 40, sufficientEvidence: true })
  })

  it('requires five seconds and the correct distance threshold for zone predictions', () => {
    expect(
      evaluatePrediction(
        contract('edge'),
        evidence({ centerSeconds: 2.99, edgeSeconds: 2, avgDistToCenter: 0.45 }),
      ),
    ).toMatchObject({ status: 'insufficient', sufficientEvidence: false })

    expect(
      evaluatePrediction(
        contract('edge'),
        evidence({ centerSeconds: 3, edgeSeconds: 2, avgDistToCenter: 0.45 }),
      ),
    ).toMatchObject({ status: 'broken', targetPct: 45, sufficientEvidence: true })

    expect(
      evaluatePrediction(
        contract('center'),
        evidence({ centerSeconds: 2, edgeSeconds: 3, avgDistToCenter: 0.55 }),
      ),
    ).toMatchObject({ status: 'broken', targetPct: 45, sufficientEvidence: true })
  })

  it('marks a sufficiently sampled balanced player as unreadable', () => {
    expect(
      buildPredictionContract(
        3,
        evidence({
          dodgeLeftSeconds: 1.25,
          dodgeRightSeconds: 1.25,
          meleeDamage: 40,
          rangedDamage: 40,
          centerSeconds: 2.5,
          edgeSeconds: 2.5,
        }),
      ),
    ).toEqual({ target: 'unreadable', observedPct: 50, sourceWave: 3 })
  })
})

describe('Telemetry', () => {
  it('keeps wave stats isolated while retaining run totals', () => {
    const telemetry = new Telemetry()
    const center = new THREE.Vector3()
    const edge = new THREE.Vector3(ARENA_RADIUS * 0.8, 0, 0)

    telemetry.startWave()
    telemetry.tick(2, center, new THREE.Vector3(-1, 0, 0))
    telemetry.recordDamageDealt('melee', 90)
    telemetry.recordDamageDealt('ranged', 10)
    telemetry.recordDamageTaken(7)
    telemetry.recordKill('drone')
    telemetry.endWave()

    telemetry.tick(20, edge, new THREE.Vector3(1, 0, 0))
    telemetry.recordDamageDealt('ranged', 1_000)

    telemetry.startWave()
    telemetry.tick(3, edge, new THREE.Vector3(1, 0, 0))
    telemetry.recordDamageDealt('ranged', 50)

    expect(telemetry.waveDigest(2, 75)).toMatchObject({
      wave: 2,
      meleeUsePct: 0,
      rangedUsePct: 100,
      dodgeLeftPct: 0,
      dodgeRightPct: 100,
      damageTakenThisWave: 0,
      killsByType: {},
      waveClearSeconds: 3,
    })
    expect(telemetry.runDigest(2, 75)).toMatchObject({
      wave: 2,
      meleeUsePct: 60,
      rangedUsePct: 40,
      dodgeLeftPct: 40,
      dodgeRightPct: 60,
      avgDistToCenter: 0.48,
      damageTakenThisWave: 7,
      killsByType: { drone: 1 },
      waveClearSeconds: 5,
    })
  })

  it('derives weapon shares from dealt damage rather than attack requests', () => {
    const telemetry = new Telemetry()
    telemetry.startWave()

    for (let index = 0; index < 20; index += 1) telemetry.recordMelee()
    telemetry.recordRanged()
    telemetry.recordDamageDealt('melee', 10)
    telemetry.recordDamageDealt('ranged', 90)

    expect(telemetry.waveDigest(1, 100)).toMatchObject({ meleeUsePct: 10, rangedUsePct: 90 })
    expect(telemetry.currentEvidence()).toMatchObject({ meleeDamage: 10, rangedDamage: 90 })
  })
})
