import type { Player } from './player'

/**
 * 웨이브 사이 업그레이드 선택 (아레나 서바이버 성공 공식).
 * "오버마인드가 강해지는 만큼 나도 강해진다" — 상승 대결 구도 + 빌드 다양성 + 재도전 동기.
 */
export interface Upgrade {
  id: string
  name: string
  desc: string
  apply: (p: Player) => void
}

export const UPGRADES: Upgrade[] = [
  { id: 'fire_rate', name: '과부하 사격', desc: '사격 속도 +25%', apply: (p) => (p.stats.rangedCooldown *= 0.8) },
  { id: 'fire_dmg', name: '고출력 탄', desc: '사격 데미지 +40%', apply: (p) => (p.stats.rangedDamage = Math.round(p.stats.rangedDamage * 1.4)) },
  { id: 'multishot', name: '분열 사격', desc: '투사체 +1', apply: (p) => (p.stats.multishot += 1) },
  { id: 'max_hp', name: '장갑 강화', desc: '최대 체력 +30, 18 회복', apply: (p) => { p.stats.maxHp += 30; p.heal(18) } },
  { id: 'dash', name: '추진기 개조', desc: '대시 쿨다운 -25%', apply: (p) => (p.stats.dashCooldown *= 0.75) },
  { id: 'speed', name: '기동 강화', desc: '이동 속도 +15%', apply: (p) => (p.stats.speed *= 1.15) },
  { id: 'melee', name: '근접 증폭', desc: '근접 데미지 +50%', apply: (p) => (p.stats.meleeDamage = Math.round(p.stats.meleeDamage * 1.5)) },
  { id: 'repair', name: '긴급 수리', desc: '체력 45 회복', apply: (p) => p.heal(45) },
]

/** 서로 다른 업그레이드 3개 무작위 추출 */
export function pickThree(): Upgrade[] {
  const pool = [...UPGRADES]
  const out: Upgrade[] = []
  for (let i = 0; i < 3 && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  }
  return out
}
