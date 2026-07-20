import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestBossDesign, requestOpeningDesign, requestWaveDesign } from '../../src/ai/director'
import type { BossDesign, TelemetryDigest, WaveDesign } from '../../src/ai/schema'

const digest = (overrides: Partial<TelemetryDigest> = {}): TelemetryDigest => ({
  wave: 0,
  playerHpPct: 100,
  dodgeLeftPct: 50,
  dodgeRightPct: 50,
  meleeUsePct: 50,
  rangedUsePct: 50,
  avgDistToCenter: 0.5,
  damageTakenThisWave: 0,
  killsByType: {},
  waveClearSeconds: 10,
  ...overrides,
})

const design = (spawns: WaveDesign['spawns']): WaveDesign => ({
  spawns,
  hazards: [],
  spawnBias: 'surround',
  counterReason: 'test',
  taunt: 'test',
  profileUpdate: '',
  mood: 'confident',
  aggression: 5,
})

const bossDesign: BossDesign = {
  verdict: 'test verdict',
  phases: [
    {
      name: 'test phase',
      attack: 'charge',
      minions: [],
      hazards: [],
      taunt: 'test',
    },
  ],
  winLine: 'test win',
  loseLine: 'test lose',
  mood: 'confident',
}

describe('wave design guardrails through the public director API', () => {
  let responseDesign: WaveDesign
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => structuredClone(responseDesign),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('enforces the early-wave threat budget', async () => {
    responseDesign = design([{ type: 'brute', count: 100, modifiers: ['thorns'] }])

    const result = await requestWaveDesign(digest())

    expect(result?.spawns).toEqual([{ type: 'brute', count: 2, modifiers: [] }])
  })

  it('enforces the hard cap of 14 units even when threat budget remains', async () => {
    responseDesign = design([{ type: 'drone', count: 100 }])

    const result = await requestWaveDesign(digest({ wave: 10 }))

    expect(result?.spawns).toEqual([{ type: 'drone', count: 14, modifiers: [] }])
  })

  it('does not resurrect a group whose requested count is zero', async () => {
    responseDesign = design([
      { type: 'drone', count: 0 },
      { type: 'spitter', count: 1 },
    ])

    const result = await requestWaveDesign(digest())

    expect(result?.spawns).toEqual([{ type: 'spitter', count: 1, modifiers: [] }])
  })

  it('returns null when an in-flight wave request is externally aborted', async () => {
    let markJsonStarted = (): void => undefined
    let resolveJson = (_value: WaveDesign): void => undefined
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve
    })
    const jsonResult = new Promise<WaveDesign>((resolve) => {
      resolveJson = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: () => {
          markJsonStarted()
          return jsonResult
        },
      })),
    )
    const controller = new AbortController()

    const pending = requestWaveDesign(digest(), controller.signal)
    await jsonStarted
    controller.abort()
    resolveJson(design([{ type: 'drone', count: 1 }]))

    await expect(pending).resolves.toBeNull()
  })

  it('returns null when an in-flight boss request is externally aborted', async () => {
    let markJsonStarted = (): void => undefined
    let resolveJson = (_value: BossDesign): void => undefined
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve
    })
    const jsonResult = new Promise<BossDesign>((resolve) => {
      resolveJson = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: () => {
          markJsonStarted()
          return jsonResult
        },
      })),
    )
    const controller = new AbortController()

    const pending = requestBossDesign(digest(), controller.signal)
    await jsonStarted
    controller.abort()
    resolveJson(bossDesign)

    await expect(pending).resolves.toBeNull()
  })

  it('discards an older delayed wave response while accepting the newest request', async () => {
    const olderDesign = { ...design([{ type: 'drone', count: 1 }]), taunt: 'older' }
    const newestDesign = { ...design([{ type: 'spitter', count: 1 }]), taunt: 'newest' }
    let markOlderJsonStarted = (): void => undefined
    let resolveOlderJson = (_value: WaveDesign): void => undefined
    const olderJsonStarted = new Promise<void>((resolve) => {
      markOlderJsonStarted = resolve
    })
    const olderJsonResult = new Promise<WaveDesign>((resolve) => {
      resolveOlderJson = resolve
    })
    let requestCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        requestCount += 1
        if (requestCount === 1) {
          return {
            ok: true,
            json: () => {
              markOlderJsonStarted()
              return olderJsonResult
            },
          }
        }
        return { ok: true, json: async () => newestDesign }
      }),
    )

    const olderRequest = requestWaveDesign(digest())
    await olderJsonStarted
    const newestRequest = requestWaveDesign(digest({ wave: 1 }))

    await expect(newestRequest).resolves.toMatchObject({ taunt: 'newest' })
    resolveOlderJson(olderDesign)
    await expect(olderRequest).resolves.toBeNull()
  })

  it('keeps a returning-player greeting independent from wave prefetch', async () => {
    const openingDesign = { ...design([{ type: 'drone', count: 1 }]), taunt: 'welcome back', profileUpdate: 'opening-profile' }
    const waveDesign = { ...design([{ type: 'spitter', count: 1 }]), taunt: 'next wave', profileUpdate: 'wave-profile' }
    let markOpeningJsonStarted = (): void => undefined
    let resolveOpeningJson = (_value: WaveDesign): void => undefined
    const openingJsonStarted = new Promise<void>((resolve) => {
      markOpeningJsonStarted = resolve
    })
    const openingJsonResult = new Promise<WaveDesign>((resolve) => {
      resolveOpeningJson = resolve
    })
    let requestCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        requestCount += 1
        if (requestCount === 1) {
          return {
            ok: true,
            json: () => {
              markOpeningJsonStarted()
              return openingJsonResult
            },
          }
        }
        return { ok: true, json: async () => waveDesign }
      }),
    )

    const openingRequest = requestOpeningDesign(digest())
    await openingJsonStarted
    const waveRequest = requestWaveDesign(digest({ wave: 1 }))

    await expect(waveRequest).resolves.toMatchObject({ taunt: 'next wave' })
    resolveOpeningJson(openingDesign)
    await expect(openingRequest).resolves.toMatchObject({ taunt: 'welcome back' })
    expect(storage.get('overmind-profile')).toBe('wave-profile')
  })
})
