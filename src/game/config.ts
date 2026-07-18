export const ARENA_RADIUS = 22

export const PLAYER = {
  radius: 0.55,
  speed: 9,
  hp: 65, // 회피가 진짜 필요하게 (데이터: 아들 44% 남기고 클리어)
  dashSpeed: 26,
  dashDuration: 0.18,
  dashCooldown: 1.0, // 0.7→1.0: 모든 공격을 대시로 못 피하게
  melee: { damage: 34, range: 3.2, arcDeg: 140, cooldown: 0.38 },
  ranged: { damage: 12, speed: 30, cooldown: 0.22, projectileRadius: 0.18 },
} as const

export const ENEMY_TYPES = {
  // 근접 돌격형 — 멈춰서 예고(windup) 후 돌진(lunge). 돌진만이 유일한 피해 수단 → 회피 가능
  drone: {
    radius: 0.5, speed: 6.2, hp: 30, damage: 14,
    attackRange: 4.5, attackCooldown: 1.1, color: 0xd94f4f,
    windup: 0.45, lungeSpeed: 17, lungeDuration: 0.35,
  },
  // 원거리 견제형 — 거리 유지 후 투사체
  spitter: {
    radius: 0.55, speed: 4.2, hp: 22, damage: 11,
    attackRange: 12, preferredRange: 9, attackCooldown: 1.1,
    projectileSpeed: 20, color: 0xb46bd9,
  },
  // 저속 고체력 탱커 — 플레이어를 구석으로 모는 압박용
  brute: {
    radius: 0.95, speed: 3.2, hp: 90, damage: 22,
    attackRange: 1.9, attackCooldown: 1.2, color: 0xd9a04f,
  },
} as const

export type EnemyType = keyof typeof ENEMY_TYPES

export const WAVE_INTERMISSION_SEC = 3.5
export const TOTAL_WAVES = 8 // 5→8: 플레이타임 + AI 관찰→카운터 사이클(핵심 가치) 확장
/** 밸런스/난이도 버전 — 리더보드를 버전별로 분리(밸런스 바뀌면 점수 비교 불공정) */
export const GAME_VERSION = 'v6'
/** 웨이브 스폰 예고(경고 링) 시간 — 스폰이 '의도된 배치'로 읽히게 함 */
export const SPAWN_TELEGRAPH_SEC = 0.9

export const SCORE = { drone: 100, spitter: 150, brute: 300, waveClear: 500, boss: 5000 } as const

export const BOSS = {
  radius: 1.8,
  hp: 900, // 750→900: 최종전 길이·중량감↑
  hoverY: 2.2,
  speed: 2.4,
  contactDamage: 14,
  /** 페이즈 전환 시 무적 연출 시간 */
  phaseInvulnSec: 2.0,
  radialBurst: { count: 12, speed: 10.5, damage: 8, cooldown: 2.4 },
  targetedSlam: { warnSec: 0.85, radius: 3.4, damage: 20, cooldown: 3.2 },
  charge: { windup: 0.65, speed: 24, duration: 0.5, damage: 18, cooldown: 4.2 },
} as const
