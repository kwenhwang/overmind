export const ARENA_RADIUS = 22

export const PLAYER = {
  radius: 0.55,
  speed: 9,
  hp: 70, // 초반 즉사 완화하되 여전히 취약
  dashSpeed: 26,
  dashDuration: 0.18,
  dashCooldown: 1.0, // 0.7→1.0: 모든 공격을 대시로 못 피하게
  melee: { damage: 34, range: 3.2, arcDeg: 140, cooldown: 0.38 },
  ranged: { damage: 12, speed: 30, cooldown: 0.22, projectileRadius: 0.18 },
} as const

export const ENEMY_TYPES = {
  // 근접 돌격형 — 멈춰서 예고(windup) 후 돌진(lunge). 돌진만이 유일한 피해 수단 → 회피 가능
  drone: {
    radius: 0.5, speed: 6.2, hp: 45, damage: 14,
    attackRange: 4.5, attackCooldown: 1.1, color: 0xd94f4f,
    windup: 0.45, lungeSpeed: 17, lungeDuration: 0.35,
  },
  // 원거리 견제형 — 거리 유지 후 투사체
  spitter: {
    radius: 0.55, speed: 4.2, hp: 34, damage: 10,
    attackRange: 12, preferredRange: 9, attackCooldown: 1.4,
    projectileSpeed: 16, color: 0xb46bd9,
  },
  // 저속 고체력 탱커 — 플레이어를 구석으로 모는 압박용
  brute: {
    radius: 0.95, speed: 3.2, hp: 135, damage: 22,
    attackRange: 1.9, attackCooldown: 1.2, color: 0xd9a04f,
  },
} as const

export type EnemyType = keyof typeof ENEMY_TYPES

export const WAVE_INTERMISSION_SEC = 3.5
export const TOTAL_WAVES = 11 // 여러 번의 관찰→카운터 사이클 뒤 최종 보스로 이어진다
/** 밸런스/난이도 버전 — 리더보드를 버전별로 분리(밸런스 바뀌면 점수 비교 불공정) */
export const GAME_VERSION = 'v10'
/** 웨이브 스폰 예고(경고 링) 시간 — 스폰이 '의도된 배치'로 읽히게 함 */
export const SPAWN_TELEGRAPH_SEC = 0.9

export const SCORE = { drone: 100, spitter: 150, brute: 300, waveClear: 500, boss: 5000 } as const

/** 정면 실드('방패맨') 난이도 — 메커니즘은 유지하되 여기서 조절. */
export const SHIELD = {
  /** 정면 차단 콘(dot 임계). 클수록 좁아짐 = 쉬움. 0.35≈139°(옛), 0.6≈106°. */
  blockDot: 0.6,
} as const

export const BOSS = {
  radius: 1.8,
  hp: 900, // 750→900: 최종전 길이·중량감↑
  hoverY: 2.2,
  speed: 2.4,
  contactDamage: 14,
  /** 페이즈 전환 시 무적 연출 시간 */
  phaseInvulnSec: 2.0,
  radialBurst: { count: 14, speed: 12, damage: 8, cooldown: 1.5 },
  targetedSlam: { warnSec: 0.7, radius: 3.6, damage: 18, cooldown: 2.0 },
  charge: { windup: 0.55, speed: 26, duration: 0.5, damage: 18, cooldown: 2.8 },
  /** 지능 파라미터 — 데미지·HP는 손대지 않고 "어디를 노릴지·무엇을 언제 쓸지"만 조절.
   *  텔레그래프는 유지되므로 방향을 꺾거나 대시하면 여전히 회피 가능(공정). */
  ai: {
    leadFactor: 0.6, // 예측 리드 강도(0=현재위치). 일정속도 이동을 앞질러 조준 → 치트 제거
    habitLead: 1.6, // 선호 회피 방향(월드X)으로 추가 리드(유닛) — 반사적 습관 회피를 함정으로
    chargeReaim: 2.0, // 돌진 중 재조준율(chargeDir lerp/초). 소량이라 옆걸음·대시는 통함
    burstAimed: 5, // radial_burst에 예측 방향 집중 아크로 쏘는 추가 탄 수
    cooldownMul: [1.0, 0.85, 0.72], // 페이즈별 쿨다운 배수(후반 촘촘 — 페이싱만, 데미지 불변)
    habitFromPhase: 1, // 습관 학습을 켜는 페이즈(드라마 상승)
  },
} as const
