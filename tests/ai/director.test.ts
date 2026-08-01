import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addressesHabit,
  dominantHabit,
  fallbackDesign,
  requestBossDesign,
  requestOpeningDesign,
  requestWaveDesign,
} from '../../src/ai/director'
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

describe('지배 습관 판정 (순수 함수)', () => {
  it('웨이브 1에서는 데이터가 적어 습관을 판정하지 않는다', () => {
    expect(dominantHabit(digest({ wave: 0, dodgeLeftPct: 90, dodgeRightPct: 10 }))).toBeNull()
  })

  it('편향이 임계(12%p) 미만이면 습관 없음 — 룰은 개입하지 않는다', () => {
    expect(dominantHabit(digest({ wave: 3, dodgeLeftPct: 58, dodgeRightPct: 42, meleeUsePct: 55, rangedUsePct: 45 }))).toBeNull()
  })

  it('회피 편향이 가장 크면 dodge, 무기 편향이 크면 melee/kite로 판정한다', () => {
    expect(dominantHabit(digest({ wave: 3, dodgeLeftPct: 72, dodgeRightPct: 28 }))).toEqual({ kind: 'dodge', side: 'left', pct: 72 })
    expect(dominantHabit(digest({ wave: 3, meleeUsePct: 78, rangedUsePct: 22 }))).toEqual({ kind: 'melee', pct: 78 })
    expect(dominantHabit(digest({ wave: 3, meleeUsePct: 20, rangedUsePct: 80 }))).toEqual({ kind: 'kite', pct: 80 })
  })
})

describe('LLM 설계가 습관을 겨냥했는지 판정 (거부권 게이트)', () => {
  const habitDodge = { kind: 'dodge', side: 'left', pct: 70 } as const
  const habitMelee = { kind: 'melee', pct: 70 } as const
  const habitKite = { kind: 'kite', pct: 70 } as const

  it('회피 카운터는 스폰 편향·해저드·mirror_dash 중 무엇으로 겨냥해도 인정한다', () => {
    expect(addressesHabit({ ...design([{ type: 'drone', count: 2 }]), spawnBias: 'left' }, habitDodge)).toBe(true)
    expect(
      addressesHabit({ ...design([{ type: 'drone', count: 2 }]), hazards: [{ type: 'slow_field', placement: 'player_left' }] }, habitDodge),
    ).toBe(true)
    expect(addressesHabit(design([{ type: 'spitter', count: 2, modifiers: ['mirror_dash'] }]), habitDodge)).toBe(true)
    // 엉뚱한 방향은 겨냥이 아니다
    expect(addressesHabit({ ...design([{ type: 'drone', count: 2 }]), spawnBias: 'right' }, habitDodge)).toBe(false)
  })

  it('방패는 브루트에만 실제로 붙으므로 다른 타입의 shielded_front는 겨냥으로 인정하지 않는다', () => {
    expect(addressesHabit(design([{ type: 'drone', count: 2, modifiers: ['shielded_front'] }]), habitMelee)).toBe(false)
    expect(addressesHabit(design([{ type: 'brute', count: 1, modifiers: ['shielded_front'] }]), habitMelee)).toBe(true)
    expect(addressesHabit(design([{ type: 'drone', count: 2, modifiers: ['explode_on_death'] }]), habitMelee)).toBe(true)
  })

  it('카이팅 카운터는 enrage_far가 실제 스폰될 그룹에 붙어야 인정한다', () => {
    expect(addressesHabit(design([{ type: 'drone', count: 2, modifiers: ['enrage_far'] }]), habitKite)).toBe(true)
    expect(addressesHabit(design([{ type: 'drone', count: 0, modifiers: ['enrage_far'] }]), habitKite)).toBe(false)
    expect(addressesHabit(design([{ type: 'drone', count: 4, modifiers: ['thorns'] }]), habitKite)).toBe(false)
  })
})

describe('룰 개입은 거부권이다 — LLM 설계 존중 + 최소 보충', () => {
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
      vi.fn(async () => ({ ok: true, json: async () => structuredClone(responseDesign) })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const llmReason = '왼쪽으로만 구르길래 그쪽 통로를 좁혔다'

  it('LLM이 이미 습관을 겨냥했으면 구성·문구를 건드리지 않는다(source=llm)', async () => {
    responseDesign = {
      ...design([{ type: 'spitter', count: 3, modifiers: ['mirror_dash'] }]),
      spawnBias: 'surround',
      counterReason: llmReason,
    }

    const result = await requestWaveDesign(digest({ wave: 3, dodgeLeftPct: 78, dodgeRightPct: 22 }))

    expect(result?.counterReason).toBe(llmReason)
    expect(result?.source).toBe('llm')
    expect(result?.spawnBias).toBe('surround')
    expect(result?.hazards).toEqual([])
  })

  it('빗나갔을 때만 빠진 부품을 보충하고, LLM 문구는 유지한 채 보정 사실을 덧붙인다', async () => {
    responseDesign = { ...design([{ type: 'spitter', count: 2 }]), spawnBias: 'front', counterReason: llmReason }

    const result = await requestWaveDesign(digest({ wave: 3, dodgeLeftPct: 78, dodgeRightPct: 22 }))

    expect(result?.source).toBe('llm+adjusted')
    expect(result?.counterReason.startsWith(llmReason)).toBe(true)
    expect(result?.counterReason).toContain('룰 보정')
    expect(result?.spawnBias).toBe('left')
    expect(result?.hazards?.[0]).toEqual({ type: 'spike_zone', placement: 'player_left' })
    // 적 구성(타입)은 재작성하지 않는다
    expect(result?.spawns.map((s) => s.type)).toEqual(['spitter'])
  })

  it('근접 집착 보충은 적 타입을 바꾸지 않고 브루트에 방패만 붙인다', async () => {
    responseDesign = {
      ...design([
        { type: 'drone', count: 3 },
        { type: 'brute', count: 1 },
      ]),
      counterReason: llmReason,
    }

    const result = await requestWaveDesign(digest({ wave: 3, meleeUsePct: 80, rangedUsePct: 20 }))

    expect(result?.source).toBe('llm+adjusted')
    expect(result?.spawns.map((s) => s.type)).toEqual(['drone', 'brute'])
    expect(result?.spawns.find((s) => s.type === 'brute')?.modifiers).toContain('shielded_front')
    expect(result?.spawns.find((s) => s.type === 'drone')?.modifiers).toEqual([])
  })

  it('카이팅 보충은 드론이 없으면 기존 그룹에 enrage_far만 얹는다', async () => {
    responseDesign = { ...design([{ type: 'spitter', count: 2 }]), counterReason: llmReason }

    const result = await requestWaveDesign(digest({ wave: 3, meleeUsePct: 15, rangedUsePct: 85 }))

    expect(result?.source).toBe('llm+adjusted')
    expect(result?.spawns[0].type).toBe('spitter')
    expect(result?.spawns[0].modifiers).toContain('enrage_far')
    expect(result?.counterReason.startsWith(llmReason)).toBe(true)
  })

  it('습관이 뚜렷하지 않으면 개입하지 않는다', async () => {
    responseDesign = { ...design([{ type: 'drone', count: 3 }]), spawnBias: 'front', counterReason: llmReason }

    const result = await requestWaveDesign(digest({ wave: 3 }))

    expect(result?.source).toBe('llm')
    expect(result?.counterReason).toBe(llmReason)
    expect(result?.spawnBias).toBe('front')
  })

  it('폴백 설계는 source=fallback이고 룰 문구를 쓴다', () => {
    const result = fallbackDesign(digest({ wave: 3, meleeUsePct: 80, rangedUsePct: 20 }))

    expect(result.source).toBe('fallback')
    expect(result.counterReason).not.toContain('룰 보정')
    expect(result.counterReason.length).toBeGreaterThan(0)
  })
})
