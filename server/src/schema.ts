import { z } from 'zod'

/**
 * 클라이언트 → 프록시 입력. 자유 문자열 없음(enum/숫자만) — 프롬프트 인젝션·악용 원천 차단.
 * 게임 클라이언트 src/ai/schema.ts의 TelemetryDigest와 1:1.
 */
export const digestSchema = z.object({
  wave: z.number().int().min(0).max(20),
  playerHpPct: z.number().min(0).max(100),
  dodgeLeftPct: z.number().min(0).max(100),
  dodgeRightPct: z.number().min(0).max(100),
  meleeUsePct: z.number().min(0).max(100),
  rangedUsePct: z.number().min(0).max(100),
  avgDistToCenter: z.number().min(0).max(1),
  damageTakenThisWave: z.number().min(0).max(999),
  killsByType: z
    .object({
      drone: z.number().int().min(0).max(99).optional(),
      spitter: z.number().int().min(0).max(99).optional(),
      brute: z.number().int().min(0).max(99).optional(),
    })
    .strict(),
  waveClearSeconds: z.number().min(0).max(3600),
})

export type Digest = z.infer<typeof digestSchema>

export const MODIFIERS = [
  'thorns',
  'shielded_front',
  'split_on_death',
  'explode_on_death',
  'mirror_dash',
  'enrage_far',
] as const

/** LLM 출력(웨이브 설계) 검증 — 게임 클라이언트 WaveDesign과 1:1 */
export const waveDesignSchema = z.object({
  spawns: z
    .array(
      z.object({
        type: z.enum(['drone', 'spitter', 'brute']),
        count: z.number().int().min(1).max(8),
        modifiers: z.array(z.enum(MODIFIERS)).max(2),
      }),
    )
    .min(1)
    .max(4),
  hazards: z
    .array(
      z.object({
        type: z.enum(['spike_zone', 'slow_field']),
        placement: z.enum(['player_left', 'player_right', 'front', 'behind', 'center']),
      }),
    )
    .max(2),
  spawnBias: z.enum(['surround', 'front', 'behind', 'left', 'right']),
  counterReason: z.string().max(300),
  taunt: z.string().max(300),
  mood: z.enum(['confident', 'angry', 'playful', 'desperate']),
  aggression: z.number().int().min(1).max(5),
})

export type WaveDesign = z.infer<typeof waveDesignSchema>

/** Anthropic tool 스키마 — LLM이 이 형태로만 출력하게 강제 */
export const directiveTool = {
  name: 'issue_wave_design',
  description: '관찰한 플레이어 습관을 카운터하는 다음 웨이브 설계를 내린다.',
  input_schema: {
    type: 'object',
    properties: {
      spawns: {
        type: 'array',
        description: '적 구성. 총합 3~12기 권장. drone=근접 돌격, spitter=원거리 견제, brute=저속 탱커',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['drone', 'spitter', 'brute'] },
            count: { type: 'integer', minimum: 1, maximum: 8 },
            modifiers: {
              type: 'array',
              description:
                '이 그룹 전체에 부착할 모디파이어 0~2개. 웨이브 전체에서 총 4개 이하로 절제할 것',
              items: { type: 'string', enum: [...MODIFIERS] },
              maxItems: 2,
            },
          },
          required: ['type', 'count', 'modifiers'],
        },
        minItems: 1,
        maxItems: 4,
      },
      hazards: {
        type: 'array',
        description: '아레나 해저드 0~2개. spike_zone=밟으면 지속 피해, slow_field=감속 지대',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['spike_zone', 'slow_field'] },
            placement: {
              type: 'string',
              enum: ['player_left', 'player_right', 'front', 'behind', 'center'],
              description: '플레이어 기준 상대 배치 — 회피·위치 습관 처벌에 사용',
            },
          },
          required: ['type', 'placement'],
        },
        maxItems: 2,
      },
      spawnBias: {
        type: 'string',
        enum: ['surround', 'front', 'behind', 'left', 'right'],
        description: '스폰 방향 편향. left/right는 플레이어 시선 기준 — 회피 습관을 처벌하는 데 사용',
      },
      counterReason: {
        type: 'string',
        description: '이 설계가 플레이어의 어떤 습관을 노렸는지 한 문장 (한국어)',
      },
      taunt: {
        type: 'string',
        description: '플레이어에게 보내는 조롱 대사 1~2문장 (한국어). 반드시 관찰한 구체적 수치나 습관을 언급',
      },
      mood: { type: 'string', enum: ['confident', 'angry', 'playful', 'desperate'] },
      aggression: { type: 'integer', minimum: 1, maximum: 5, description: '적 공격성' },
    },
    required: ['spawns', 'hazards', 'spawnBias', 'counterReason', 'taunt', 'mood', 'aggression'],
  },
} as const
