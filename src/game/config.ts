export const ARENA_RADIUS = 22

export const PLAYER = {
  radius: 0.55,
  speed: 9,
  hp: 100,
  dashSpeed: 26,
  dashDuration: 0.18,
  dashCooldown: 0.9,
  melee: { damage: 34, range: 2.4, arcDeg: 130, cooldown: 0.38 },
  ranged: { damage: 12, speed: 30, cooldown: 0.22, projectileRadius: 0.18 },
} as const

export const ENEMY_TYPES = {
  // 근접 돌격형
  drone: {
    radius: 0.5, speed: 5.2, hp: 30, damage: 10,
    attackRange: 1.3, attackCooldown: 1.1, color: 0xd94f4f,
  },
  // 원거리 견제형 — 거리 유지 후 투사체
  spitter: {
    radius: 0.55, speed: 3.6, hp: 22, damage: 8,
    attackRange: 12, preferredRange: 9, attackCooldown: 2.2,
    projectileSpeed: 13, color: 0xb46bd9,
  },
  // 저속 고체력 탱커 — 플레이어를 구석으로 모는 압박용
  brute: {
    radius: 0.95, speed: 2.6, hp: 90, damage: 22,
    attackRange: 1.9, attackCooldown: 1.6, color: 0xd9a04f,
  },
} as const

export type EnemyType = keyof typeof ENEMY_TYPES

export const WAVE_INTERMISSION_SEC = 4.5
export const TOTAL_WAVES = 5
