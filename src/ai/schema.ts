import type { EnemyType } from '../game/config'

/**
 * 모디파이어 — LLM이 적에게 부착하는 조합 부품. 각각이 특정 플레이 습관을 처벌한다.
 * thorns: 근접 반격 가시 / shielded_front: 정면 차단(후방 침투 강요) /
 * split_on_death: 사망 시 분열 / explode_on_death: 자폭(근접 처치 처벌) /
 * mirror_dash: 플레이어 대시에 반응해 같은 방향 돌진(회피 패턴 처벌) /
 * enrage_far: 플레이어가 멀면 가속(카이팅 처벌)
 */
export type Modifier =
  | 'thorns'
  | 'shielded_front'
  | 'split_on_death'
  | 'explode_on_death'
  | 'mirror_dash'
  | 'enrage_far'

export type HazardType = 'spike_zone' | 'slow_field'
export type HazardPlacement = 'player_left' | 'player_right' | 'front' | 'behind' | 'center'

export interface HazardSpec {
  type: HazardType
  placement: HazardPlacement
}

/**
 * L2(LLM 디렉터) 출력 스키마 — 프록시의 strict tool use 스키마와 1:1 대응.
 * LLM은 이 데이터를 "설계"할 뿐, 실행은 전부 결정론적 게임 코드(wave executor)가 한다.
 * 설계 공간: 적 3종×수량×모디파이어 6종 중 0~2개 × 해저드 2종×배치 5곳 — 룰테이블로
 * 열거 불가능한 조합 공간에서 텔레메트리를 근거로 조립하는 것이 LLM의 존재 이유.
 */
export interface WaveDesign {
  /** 다음 웨이브의 적 구성 (그룹별 모디파이어 0~2개) */
  spawns: { type: EnemyType; count: number; modifiers?: Modifier[] }[]
  /** 아레나 해저드 0~2개 */
  hazards?: HazardSpec[]
  /** 스폰 편향 — 플레이어 습관을 카운터하는 위치 선택 */
  spawnBias: 'surround' | 'front' | 'behind' | 'left' | 'right'
  /** 이 설계가 플레이어의 어떤 습관을 노렸는지 — 대사로 노출되는 인과의 핵심 */
  counterReason: string
  /** 오버마인드 조롱 대사 (한국어 1~2문장) */
  taunt: string
  /**
   * 플레이어에 대한 누적 관찰 기록 갱신 (3문장 이내) — localStorage에 저장되어
   * 웨이브·판(run)을 넘어 이어진다. 다음 판의 오버마인드가 "지난 판의 너"를 기억하는 근거.
   */
  profileUpdate: string
  mood: 'confident' | 'angry' | 'playful' | 'desperate'
  aggression: 1 | 2 | 3 | 4 | 5
}

/** 보스 공격 패턴 부품 — 결정론 구현 3종, LLM이 페이즈별로 프로파일에 맞춰 선택 */
export type BossAttack = 'radial_burst' | 'targeted_slam' | 'charge'

export interface BossPhase {
  /** 페이즈 이름 (연출용, 한국어) */
  name: string
  attack: BossAttack
  /** 페이즈 진입 시 지원 스폰 (0~2그룹) */
  minions: { type: EnemyType; count: number; modifiers?: Modifier[] }[]
  hazards?: HazardSpec[]
  /** 페이즈 진입 대사 */
  taunt: string
}

/** 보스전 설계 — 누적 프로파일의 총결산 */
export interface BossDesign {
  /** 판결문: 축적된 관찰 기록의 낭독 (보스전 인트로, 2~3문장) */
  verdict: string
  phases: BossPhase[]
  /** 플레이어가 죽었을 때 보스의 마지막 말 */
  winLine: string
  /** 보스가 파괴될 때 남기는 말 */
  loseLine: string
  mood: 'confident' | 'angry' | 'playful' | 'desperate'
}

/** 판(run) 경계를 넘는 컨텍스트 — 디렉터 요청에 다이제스트와 함께 실림 */
export interface RunContext {
  /** 몇 번째 판인가 (localStorage 누적) */
  runNumber: number
  /** 직전 판의 결말 */
  lastOutcome: 'none' | 'died' | 'victory'
  /** 직전 판에서 죽은 웨이브 (died일 때만 의미) */
  diedAtWave: number
  /** LLM이 누적해 온 플레이어 관찰 기록 (없으면 빈 문자열) */
  profile: string
}

export interface Directive {
  aggression: number
}

/** 클라이언트 → 프록시로 보내는 텔레메트리 다이제스트 (자유 문자열 없음 — 악용 방지) */
export interface TelemetryDigest {
  wave: number
  playerHpPct: number
  dodgeLeftPct: number
  dodgeRightPct: number
  meleeUsePct: number
  rangedUsePct: number
  avgDistToCenter: number
  damageTakenThisWave: number
  killsByType: Partial<Record<EnemyType, number>>
  waveClearSeconds: number
}
