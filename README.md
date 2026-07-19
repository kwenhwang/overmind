# OVERMIND

> 적의 두뇌는 너를 관찰한다.

웨이브형 3D 아레나 액션. 보스 "오버마인드"의 두뇌는 LLM이다 — 당신의 플레이(회피 방향 편향, 무기 선호, 위치 습관)를 관찰하고, 그 습관을 대사로 지목하며, 다음 웨이브를 당신을 잡기 위해 재설계한다.

**NAN 2026 (NHN Game × AI Hackathon) 예선 출품작.**

## 플레이

- **웹에서 바로 플레이**: https://kwenhwang.github.io/overmind/
- 조작: `WASD`/방향키 이동 · **좌클릭**(또는 `K`/`J`) 원거리 사격 · **우클릭**(또는 `Space`/`Shift`) 대시(무적) · 근접은 밀착 시 자동. 모바일은 조준·사격·근접 전부 자동, 이동·대시만.
- 웨이브 11개를 버티고 최종 보스를 파괴하면 승리. 같은 패턴을 반복하면 오버마인드가 반드시 처벌한다.

## 구조

```
src/game/   결정론적 게임 코드 (L0 반사 + 전투·웨이브 실행)
src/ai/     3계층 두뇌 — telemetry(관찰) → director(L2 LLM 전략) → utilityBrain(L1 전술)
src/ui/     HUD (DOM)
server/     LLM 프록시 (Hono — Cloudflare Worker/Node 겸용, 프롬프트·스키마 소유)
docs/       AI 활용 기술 문서
```

- LLM은 프레임 단위 조작을 하지 않는다. 조작·전투·물리는 100% 결정론 코드이고, LLM은 웨이브 사이에 "관찰 → 카운터 설계(JSON) → 조롱(언어)"만 담당한다.
- 프록시 장애 시 규칙기반 폴백 두뇌로 끊김 없이 플레이 가능 (덜 똑똑해질 뿐).
- 심사자는 API 키 없이 링크 클릭만으로 플레이 가능.

## 로컬 실행

```bash
npm install && npm run dev          # 게임 (http://localhost:5173)
cd server && npm install && npm run dev  # LLM 프록시 (OPENAI_API_KEY 권장 · ANTHROPIC_API_KEY도 지원, 없으면 폴백 동작)
```

## 문서

- [게임 소개서](docs/game-intro.md) — 목표·조작·시스템·실행 방법
- [AI 활용 기술 문서](docs/ai-tech-doc.md) — LLM 디렉터 아키텍처·주요 프롬프트·개발 파이프라인
- 프롬프트 버전 이력: `server/prompts/`

## 개발 도구

Claude Code (Anthropic Claude)로 전면 개발 — 게임 코드·사운드(WebAudio 신스)·셰이더·검증. 3D 모델은 CC0 에셋(플레이어·적 유닛, Quaternius)과 자체 절차 생성(보스, Blender bpy)으로 마련. 상세·라이선스는 [AI 활용 기술 문서](docs/ai-tech-doc.md)·[에셋 크레딧](public/models/CREDITS.md) 참조.
