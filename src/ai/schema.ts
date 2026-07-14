import type { EnemyType } from '../game/config'

/**
 * L2(LLM 디렉터) 출력 스키마 — 프록시의 strict tool use 스키마와 1:1 대응.
 * LLM은 이 데이터를 "설계"할 뿐, 실행은 전부 결정론적 게임 코드(wave executor)가 한다.
 */
export interface WaveDesign {
  /** 다음 웨이브의 적 구성 */
  spawns: { type: EnemyType; count: number }[]
  /** 스폰 편향 — 플레이어 습관을 카운터하는 위치 선택 */
  spawnBias: 'surround' | 'front' | 'behind' | 'left' | 'right'
  /** 이 설계가 플레이어의 어떤 습관을 노렸는지 — 대사로 노출되는 인과의 핵심 */
  counterReason: string
  /** 오버마인드 조롱 대사 (한국어 1~2문장) */
  taunt: string
  mood: 'confident' | 'angry' | 'playful' | 'desperate'
  aggression: 1 | 2 | 3 | 4 | 5
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
