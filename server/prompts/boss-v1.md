# boss-v1 (2026-07-16)

보스전 = 누적 관찰의 총결산. 별도 시스템 프롬프트(BOSS_SYSTEM_PROMPT) + issue_boss_design 도구.
- 입력: 최종 텔레메트리 + 누적 프로파일 (boss:true 플래그로 라우팅)
- 출력: verdict(판결문 — 습관 근거 총평 2~3문장) / phases 2~3개(name·attack·minions·hazards·taunt)
  / winLine·loseLine / mood
- 공격 부품 3종(결정론 구현): radial_burst(근접 처벌) · targeted_slam(정지/카이팅 처벌) · charge(원거리 처벌)
- 실측 예 (외곽 카이팅+왼회피 프로파일): verdict "싸우는 척하며 거리를 사는 타입…",
  페이즈 압축(slam+왼쪽 감속)→역추적(탄막+후방 가시 "네가 만든 통로를 닫아 주겠다")→붕괴(charge+enrage_far)
- max_completion_tokens 1600 (페이즈 3개 한국어 대사 분량)
