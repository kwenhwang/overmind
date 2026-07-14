# OVERMIND

> 적의 두뇌는 너를 관찰한다.

웨이브형 3D 아레나 액션. 보스 "오버마인드"의 두뇌는 LLM이다 — 당신의 플레이(회피 방향 편향, 무기 선호, 위치 습관)를 관찰하고, 그 습관을 대사로 지목하며, 다음 웨이브를 당신을 잡기 위해 재설계한다.

**NAN 2026 (NHN Game × AI Hackathon) 예선 출품작.**

## 플레이

- **웹에서 바로 플레이**: (GitHub Pages 링크 — 배포 후 갱신)
- 조작: `WASD` 이동 · `Space`/`Shift` 대시(무적) · `좌클릭` 근접 · `우클릭` 원거리 (키보드 대체: `J`/`K`)
- 웨이브 5개를 버티면 승리. 같은 패턴을 반복하면 오버마인드가 반드시 처벌한다.

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
cd server && npm install && npm run dev  # LLM 프록시 (ANTHROPIC_API_KEY 필요, 없으면 폴백 동작)
```

## 개발 도구

Claude Code (Claude Fable 5)로 개발. 사용 도구·프롬프트·활용 내역은 `docs/ai-tech-doc.md` 참조.
