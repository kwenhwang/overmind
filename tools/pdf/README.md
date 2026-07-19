# 제출물 PDF 생성

게임 소개서 PDF는 디자인된 HTML을 chromium(playwright)으로 렌더한다. 사유 스킬 불필요.

```bash
# 1) 에셋 렌더가 필요하면 먼저 (public/models → tools/pdf/assets/FINAL_*.png)
#    blender --background --python tools/blender/render_cmp.py -- tools/pdf/assets \
#      FINAL_boss=public/models/boss.glb FINAL_player=public/models/player.glb   # 필요시 VIEWS=front
# 2) HTML 조립 → PDF
python3 tools/pdf/build_intro.py tools/pdf/assets tools/pdf/intro.html
node tools/pdf/render.mjs "$PWD/tools/pdf/intro.html" "$PWD/docs/game-intro.pdf"
```

내용의 정본은 `docs/game-intro.md`. 문구를 바꾸면 `build_intro.py`도 함께 갱신할 것.
