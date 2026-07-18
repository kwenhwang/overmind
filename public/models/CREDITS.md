# 3D 모델 크레딧 · 출처

이 게임에 쓰인 3D 모델은 **두 갈래**다 — ①CC0 퍼블릭 도메인 에셋(적 유닛), ②AI로 생성한 에셋(플레이어·보스). 대회 규정(외부 에셋 출처·라이선스 명시)에 따라 정직하게 기재한다.

## ① 적 유닛 — Quaternius (CC0)

저작자 **Quaternius** (https://quaternius.com), **poly.pizza** 경유 다운로드.
라이선스 **CC0 1.0 (퍼블릭 도메인)** — 출처 표기 의무 없음. 정직성을 위해 명시.

| 파일 | 원본 모델 | poly.pizza |
|---|---|---|
| drone.glb  | Robot Enemy Flying | poly.pizza/m/lF3jeRJwiH |
| spitter.glb | Robot Enemy       | poly.pizza/m/1gNo5ezvmr |
| brute.glb  | Robot Enemy Large  | poly.pizza/m/mPDR0L5uKx |

## ② 플레이어·보스 — Tripo AI 생성 (AI 에셋)

**Tripo** (https://www.tripo3d.ai) — 텍스트/이미지→3D 생성 AI로 제작한 에셋.
Tripo 이용약관(생성물 사용 조건)에 따라 사용. 생성 도구·내역은 AI 활용 기술 문서에도 기재.

| 파일 | 제작 | 비고 |
|---|---|---|
| player.glb | Tripo AI 생성 | sci-fi 파이터. 게임 조명·머티리얼(`configureMaterial`)로 통일 |
| boss.glb   | Tripo AI 생성 | sci-fi 기계 코어. 정적 메시 + 절차적 회전/호버 |

> ⚠️ Tripo 무료 티어 생성물의 상업적/재배포 조건은 Tripo 약관을 최종 확인할 것(공개 레포에 포함되므로).

## 그 외

사운드·이펙트·파티클·데미지 숫자·게임 로직·LLM 통합·셰이더는 **100% 자체 제작**
(외부 파일 0 — WebAudio 신스 + three.js 셰이더).
