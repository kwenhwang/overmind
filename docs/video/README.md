# 시연 영상 편집 에셋

콘티는 `docs/video-storyboard.md`. 여기엔 편집에 바로 쓸 완성 에셋을 둔다.

## endcard.png (1920×1080)
마지막 3초 정지 컷. 소스는 `endcard.html`(수정 후 재렌더):
```bash
node tools/video/shot.mjs "$PWD/docs/video/endcard.html" "$PWD/docs/video/endcard.png"
```

## subtitles.srt
S1~S5 하단 자막 5줄. **타임코드는 시작 템플릿** — 실제 녹화 푸티지 길이에 맞춰
편집기(Premiere/DaVinci/CapCut 등)에서 각 컷 시작점에 스냅해 미세조정할 것.
S6(엔드카드)는 자막 없이 endcard.png 자체 텍스트를 쓴다.
스타일 권장: 흰색 + 검은 외곽선, 하단 중앙, 한 번에 1줄.
