# director-v2-modifiers (2026-07-15)

v1 → v2 변경: 객관식(적 구성·방향 선택)에서 **부품 조합 설계**로 전환.
- 모디파이어 6종(thorns/shielded_front/split_on_death/explode_on_death/mirror_dash/enrage_far),
  해저드 2종 × 배치 5곳 카탈로그를 프롬프트에 명시 — 각 부품이 "처벌하는 습관"을 정의.
- LLM의 역할: 텔레메트리에서 습관 1~2개를 골라 부품 2~3개를 유기 조합한 "함정" 설계 + 인과 설명.
- 룰테이블로 열거 불가능한 (연속 텔레메트리 공간 × 조합 공간) 매핑이 LLM 필연성의 근거.
- 실 시스템 프롬프트 원문: `server/src/prompt.ts` SYSTEM_PROMPT (PROMPT_VERSION=director-v2-modifiers)

실측 예 (wave2, 근접75%·왼회피85%·외곽80%):
가시 드론 4 + 정면실드 스피터 2 + 가속 브루트 1 + 왼쪽 spike_zone + 후방 slow_field,
counterReason "가시 드론은 붙어서 싸우는 습관을 벌하고, 왼쪽 가시 지대는 도망치려는 경로를 미리 봉쇄"
