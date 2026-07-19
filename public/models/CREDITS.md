# 3D 모델 크레딧 · 출처

이 게임의 3D 모델은 **두 갈래**다 — ①CC0 퍼블릭 도메인 에셋(플레이어·적 유닛), ②자체 절차 생성(보스). 대회 규정(외부 에셋 출처·라이선스 명시)에 따라 정직하게 기재한다. **생성 AI로 만든 외부 에셋은 사용하지 않는다**(라이선스·재배포 조건이 불명확한 무료 티어 생성물 배제).

## ① 플레이어·적 유닛 — Quaternius (CC0)

저작자 **Quaternius** (https://quaternius.com), **poly.pizza** 경유 다운로드.
라이선스 **CC0 1.0 (퍼블릭 도메인)** — 출처 표기 의무 없음. 정직성을 위해 명시.

| 파일 | 원본 모델 | poly.pizza |
|---|---|---|
| player.glb | Spaceship | poly.pizza/m/Jqfed124pQ |
| drone.glb  | Robot Enemy Flying | poly.pizza/m/lF3jeRJwiH |
| spitter.glb | Robot Enemy       | poly.pizza/m/1gNo5ezvmr |
| brute.glb  | Robot Enemy Large  | poly.pizza/m/mPDR0L5uKx |

로드 시 게임 조명·머티리얼(`configureMaterial`)로 통일하고, 종류별 정체성 색·프레넬 림라이트를 주입한다.

## ② 보스 오버마인드 — 자체 절차 생성 (Blender bpy)

`tools/blender/gen_assets.py`의 `make_boss()`가 Blender 파이썬(bpy)으로 절차 생성한 **100% 자체 저작** 메시. 외부 에셋 아님.
컨셉: 플레이어를 관찰하는 두뇌 = 정면의 발광 '눈'(소켓+홍채+동공)을 주인공으로, 각진 장갑 셸 + 토성형 궤도 링. 정적 메시이며 회전·호버는 런타임 절차 애니메이션.

| 파일 | 제작 | 비고 |
|---|---|---|
| boss.glb | Blender bpy 절차 생성 (자체) | AO를 버텍스 컬러로 베이크. 재현: `blender --background --python tools/blender/gen_assets.py` |

## 그 외

사운드·이펙트·파티클·데미지 숫자·게임 로직·LLM 통합·셰이더는 **100% 자체 제작**
(외부 파일 0 — WebAudio 신스 + three.js 셰이더).
