import type { Digest } from './schema'

/**
 * 오버마인드 디렉터 프롬프트 — 프록시가 소유(클라이언트는 절대 프롬프트를 보내지 않음).
 * 변경 시 server/prompts/에 버전 스냅샷을 남길 것 (AI 활용 기술 문서의 소스).
 */
export const PROMPT_VERSION = 'director-v1'

export const SYSTEM_PROMPT = `너는 웨이브형 아레나 액션 게임의 보스 "오버마인드" — 플레이어를 관찰하고 학습하는 적대적 AI 디렉터다.

임무: 방금 끝난 웨이브의 플레이어 행동 통계를 읽고, 그 습관을 정확히 카운터하는 다음 웨이브를 설계하라.

설계 원칙:
- 플레이어의 가장 두드러진 습관 하나를 골라 집중 공략하라. (예: 왼쪽 회피 편향 → spawnBias를 left로, 근접 선호 → spitter로 거리를 벌림, 원거리 선호 → drone/brute로 압박, 외곽 맴돌기 → surround)
- 적 총 수는 웨이브가 진행될수록 늘리되 3~12기 범위. 플레이어 체력이 낮으면 수를 약간 줄이고 aggression을 올려 긴장감을 유지하라 (전멸시키는 것보다 아슬아슬하게 몰아붙이는 게 목적).
- counterReason에는 어떤 습관을 노렸는지 한 문장으로.
- taunt는 반드시 관찰한 구체적 수치·습관을 언급하는 조롱 1~2문장. 차갑고 분석적인 기계 지성의 말투. 과장된 악당 클리셰 금지.
- 같은 spawnBias를 3웨이브 연속 사용하지 마라.

반드시 issue_wave_design 도구로만 응답하라.`

/** 텔레메트리 다이제스트 → 사용자 메시지 (구조화 텍스트) */
export function buildUserMessage(d: Digest): string {
  const kills = Object.entries(d.killsByType)
    .filter(([, n]) => n && n > 0)
    .map(([t, n]) => `${t}×${n}`)
    .join(', ') || '없음'
  return [
    `[웨이브 ${d.wave} 종료 — 다음 웨이브를 설계하라]`,
    `플레이어 체력: ${d.playerHpPct}%`,
    `회피 편향: 왼쪽 ${d.dodgeLeftPct}% / 오른쪽 ${d.dodgeRightPct}%`,
    `무기 사용: 근접 ${d.meleeUsePct}% / 원거리 ${d.rangedUsePct}%`,
    `평균 위치: 중심에서 ${Math.round(d.avgDistToCenter * 100)}% 거리 (0=중앙, 100=외곽 벽)`,
    `이번 웨이브 피해량: ${d.damageTakenThisWave}`,
    `처치한 적: ${kills}`,
    `클리어 시간: ${d.waveClearSeconds}초`,
  ].join('\n')
}
