import base64, os, sys
CMP = sys.argv[1]  # asset render dir
OUT = sys.argv[2]  # output html path

def d(name):
    with open(os.path.join(CMP, name), "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()

boss = d("FINAL_boss_front.png")
player = d("FINAL_player.png")

HTML = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>
  @page {{ size: A4; margin: 0; }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  :root {{
    --ground:#0a0b0f; --panel:#13151c; --panel2:#171a22; --line:#262a34;
    --ink:#eef0f5; --sub:#aeb4c2; --mut:#7c8493;
    --pink:#ff4d8d; --amber:#ff7a33; --red:#ff3b3b;
  }}
  html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  body {{ font-family:"Noto Sans CJK KR","NanumGothic",sans-serif; color:var(--ink);
    font-size:10.3pt; line-height:1.6; }}
  .page {{ width:210mm; min-height:297mm; padding:15mm 15mm 12mm; background:var(--ground);
    position:relative; page-break-after:always; overflow:hidden; }}
  .page:last-child {{ page-break-after:auto; }}
  .disp {{ font-family:"NanumSquare",sans-serif; font-weight:800; letter-spacing:-.01em; }}
  .mono {{ font-family:"NanumGothicCoding",monospace; }}
  .eyebrow {{ font-family:"NanumGothicCoding",monospace; font-size:8pt; letter-spacing:.28em;
    text-transform:uppercase; color:var(--pink); }}

  /* ── 히어로 ── */
  .hero {{ display:grid; grid-template-columns:1.15fr .85fr; gap:8mm; align-items:center;
    border-bottom:1px solid var(--line); padding-bottom:8mm; }}
  .title {{ font-size:44pt; line-height:.98; color:#fff; letter-spacing:.01em;
    text-shadow:0 0 26px rgba(255,77,141,.28); }}
  .tagline {{ font-family:"NanumSquare",sans-serif; font-weight:700; font-size:15pt; color:var(--ink);
    margin-top:3mm; }}
  .tagline .obs {{ color:var(--amber); }}
  .oneliner {{ color:var(--sub); font-size:10.3pt; margin-top:4mm; max-width:95%; }}
  .heroimg {{ position:relative; }}
  .heroimg .glow {{ position:absolute; inset:-6mm; background:radial-gradient(circle at 50% 46%,
    rgba(255,122,51,.28), rgba(255,59,59,.10) 42%, transparent 66%); }}
  .heroimg img {{ position:relative; width:100%; border-radius:4mm; display:block; }}
  .heroimg .cap {{ position:relative; text-align:center; color:var(--mut); font-size:7.6pt;
    margin-top:2mm; font-family:"NanumGothicCoding",monospace; letter-spacing:.04em; }}

  /* ── 팩트 스트립 ── */
  .facts {{ display:grid; grid-template-columns:repeat(4,1fr); gap:0; margin:7mm 0 8mm;
    border:1px solid var(--line); border-radius:3mm; overflow:hidden; }}
  .facts > div {{ padding:4mm 4.5mm; border-right:1px solid var(--line); background:var(--panel); }}
  .facts > div:last-child {{ border-right:0; }}
  .facts dt {{ font-family:"NanumGothicCoding",monospace; font-size:7.4pt; letter-spacing:.14em;
    text-transform:uppercase; color:var(--mut); margin-bottom:1.5mm; }}
  .facts dd {{ font-family:"NanumSquare",sans-serif; font-weight:700; font-size:9.6pt; color:var(--ink); }}

  h2 {{ font-family:"NanumSquare",sans-serif; font-weight:800; font-size:14pt; color:#fff;
    display:flex; align-items:center; gap:3mm; margin-bottom:4mm; }}
  h2::before {{ content:""; width:3.4mm; height:3.4mm; background:var(--pink); border-radius:1mm;
    box-shadow:0 0 10px rgba(255,77,141,.6); }}
  .lead {{ color:var(--sub); margin-bottom:5mm; }}
  .lead b {{ color:var(--ink); }}

  .loop {{ display:grid; grid-template-columns:repeat(3,1fr); gap:5mm; }}
  .step {{ background:var(--panel); border:1px solid var(--line); border-radius:3mm; padding:5mm; }}
  .step .n {{ font-family:"NanumGothicCoding",monospace; font-size:9pt; color:var(--amber);
    letter-spacing:.1em; margin-bottom:2mm; }}
  .step h3 {{ font-family:"NanumSquare",sans-serif; font-weight:800; font-size:10.6pt; color:var(--ink);
    margin-bottom:2mm; }}
  .step p {{ color:var(--sub); font-size:9.2pt; }}
  .step .q {{ color:var(--amber); font-style:normal; }}

  .memory {{ margin-top:6mm; background:linear-gradient(90deg,rgba(255,59,59,.08),transparent);
    border-left:2px solid var(--red); border-radius:0 2mm 2mm 0; padding:4mm 5mm; color:var(--sub); font-size:9.4pt; }}
  .memory b {{ color:var(--ink); }}

  /* ── 2페이지 ── */
  .grid2 {{ display:grid; grid-template-columns:1fr 1fr; gap:8mm; }}
  table {{ width:100%; border-collapse:collapse; font-size:9.2pt; }}
  th,td {{ text-align:left; padding:2.6mm 3mm; border-bottom:1px solid var(--line); vertical-align:top; }}
  th {{ font-family:"NanumGothicCoding",monospace; font-size:7.6pt; letter-spacing:.1em;
    text-transform:uppercase; color:var(--mut); font-weight:400; }}
  td.k {{ color:var(--sub); white-space:nowrap; }}
  td b {{ color:var(--ink); }}
  .key {{ display:inline-block; font-family:"NanumGothicCoding",monospace; font-size:8pt;
    background:var(--panel2); border:1px solid var(--line); border-radius:1.4mm; padding:.4mm 1.6mm; color:var(--ink); }}
  .sys li {{ list-style:none; padding:2.4mm 0; border-bottom:1px solid var(--line); color:var(--sub); font-size:9.3pt; }}
  .sys li:last-child {{ border-bottom:0; }}
  .sys b {{ color:var(--ink); font-family:"NanumSquare",sans-serif; font-weight:700; }}
  .endcond {{ display:grid; grid-template-columns:1fr 1fr; gap:5mm; margin-top:2mm; }}
  .endcond div {{ border:1px solid var(--line); border-radius:2.5mm; padding:4mm; background:var(--panel); }}
  .endcond .win {{ color:#5fd39a; font-family:"NanumSquare",sans-serif; font-weight:800; font-size:9.6pt; }}
  .endcond .lose {{ color:var(--red); font-family:"NanumSquare",sans-serif; font-weight:800; font-size:9.6pt; }}
  .endcond p {{ color:var(--sub); font-size:8.8pt; margin-top:1.5mm; }}

  .run {{ margin-top:7mm; background:var(--panel); border:1px solid var(--line); border-radius:3mm; padding:6mm; }}
  .run .url {{ font-family:"NanumGothicCoding",monospace; font-size:12pt; color:var(--pink);
    letter-spacing:.01em; margin:2mm 0 3mm; }}
  .run ol {{ margin-left:5mm; color:var(--sub); font-size:9.4pt; }}
  .run li {{ margin:1mm 0; }}
  .playerchip {{ display:flex; align-items:center; gap:4mm; margin-top:5mm;
    color:var(--mut); font-size:8.6pt; }}
  .playerchip img {{ width:24mm; border-radius:2mm; border:1px solid var(--line); }}

  footer {{ position:absolute; left:15mm; right:15mm; bottom:9mm; display:flex; justify-content:space-between;
    align-items:center; border-top:1px solid var(--line); padding-top:3mm;
    font-family:"NanumGothicCoding",monospace; font-size:7.6pt; color:var(--mut); }}
  footer .b {{ color:var(--sub); }}
</style></head><body>

<section class="page">
  <div class="eyebrow">NAN 2026 · NHN GAME × AI HACKATHON · 예선 출품작</div>
  <div class="hero" style="margin-top:5mm">
    <div>
      <div class="title disp">OVERMIND</div>
      <div class="tagline">적의 두뇌는 <span class="obs">너를 관찰한다.</span></div>
      <div class="oneliner">플레이어의 습관을 실시간으로 관찰·학습하는 <b style="color:#fff">진짜 AI(LLM) 보스</b>와
        싸우는 웨이브 서바이벌 3D 아레나 액션. 같은 패턴을 반복하면 반드시 처벌당한다.</div>
    </div>
    <div class="heroimg">
      <div class="glow"></div>
      <img src="{boss}" alt="오버마인드 보스">
      <div class="cap">OVERMIND — 관찰하는 눈</div>
    </div>
  </div>

  <dl class="facts">
    <div><dt>장르</dt><dd>탑다운 3D 아레나 액션<br><span style="font-weight:400;color:var(--mut);font-size:8.4pt">웨이브 서바이벌 + 보스전</span></dd></div>
    <div><dt>플랫폼</dt><dd>웹 브라우저<br><span style="font-weight:400;color:var(--mut);font-size:8.4pt">PC·모바일 · 설치 불필요</span></dd></div>
    <div><dt>플레이 타임</dt><dd>7 ~ 10분<br><span style="font-weight:400;color:var(--mut);font-size:8.4pt">한 판</span></dd></div>
    <div><dt>개발</dt><dd>1인<br><span style="font-weight:400;color:var(--mut);font-size:8.4pt">Claude Code 전면 활용</span></dd></div>
  </dl>

  <h2>무엇이 다른가</h2>
  <div class="lead">오버마인드(적 AI)는 각본이 아니라 <b>실제 LLM</b>이다. 웨이브 동안 당신의 회피 방향·무기 선호·위치 습관을 관찰하고 —</div>
  <div class="loop">
    <div class="step"><div class="n mono">01 · 관찰</div><h3>본 것을 공개</h3>
      <p>웨이브 사이 관찰 리포트로 습관을 수치로 지목한다. <span class="q">"회피 편향 ← 왼쪽 87%"</span></p></div>
    <div class="step"><div class="n mono">02 · 설계</div><h3>함정을 조합</h3>
      <p>그 습관을 정조준한 적 구성·모디파이어·해저드를 실시간 설계한다. <span class="q">가시 드론 + 도주로에 가시 지대</span></p></div>
    <div class="step"><div class="n mono">03 · 발화</div><h3>말로 밝힌다</h3>
      <p>왜 그렇게 설계했는지 직접 조롱한다. <span class="q">"넌 항상 왼쪽으로 구르더군."</span></p></div>
  </div>
  <div class="memory">죽어도 끝나지 않는다 — 오버마인드는 <b>판을 넘어 당신을 기억</b>하고, 재도전하면 지난 판의 죽음을 언급하며 맞이한다.
    웨이브 11개를 버티면 축적된 기록의 총결산: 당신에 대한 <b>판결문</b>을 낭독하고, 당신의 습관에 맞춰 설계된 페이즈로 직접 싸우는 <b>보스전</b>이 열린다.</div>

  <footer><span class="b">OVERMIND — 게임 소개서</span><span>적의 두뇌는 너를 관찰한다</span><span>1 / 2</span></footer>
</section>

<section class="page">
  <h2>게임 방법</h2>
  <div class="lead" style="margin-bottom:6mm"><b style="color:#fff">목표 —</b> 적 웨이브 11개를 버티고, 최종 보스 오버마인드를 파괴하라.</div>

  <div class="grid2">
    <div>
      <table>
        <tr><th></th><th>PC</th><th>모바일</th></tr>
        <tr><td class="k">이동</td><td><span class="key">W A S D</span> / 방향키</td><td>좌측 드래그<br><span style="color:var(--mut);font-size:8pt">가상 조이스틱</span></td></tr>
        <tr><td class="k">원거리 사격</td><td>마우스 <b>좌클릭</b> <span class="key">K</span></td><td>자동</td></tr>
        <tr><td class="k">대시(무적)</td><td>마우스 <b>우클릭</b> <span class="key">Space</span></td><td>우측 화면 탭</td></tr>
        <tr><td class="k">근접 공격</td><td>밀착 시 <b>자동</b></td><td>자동</td></tr>
        <tr><td class="k">조준</td><td>마우스</td><td>자동(최근접)</td></tr>
      </table>
      <p style="color:var(--mut);font-size:8.6pt;margin-top:3mm">모바일은 조준·사격·근접이 전부 자동 — 이동과 대시(회피)에만 집중한다.</p>
    </div>
    <div>
      <ul class="sys">
        <li><b>적 3종</b> — 드론(예고 후 돌진)·스피터(원거리 포격)·브루트(저속 강타). 모든 공격은 예고(발광·경고 링) 후 발동되어 회피 가능.</li>
        <li><b>모디파이어</b> — 오버마인드가 적에 부착하는 강화: 가시·정면 실드·분열·자폭·대시 미러·원거리 가속.</li>
        <li><b>해저드</b> — 가시 지대·감속 지대. 당신의 회피 방향을 봉쇄하도록 배치된다.</li>
        <li><b>점수·랭킹</b> — 처치 콤보와 웨이브 보너스로 온라인 리더보드(버전별)에 등록.</li>
      </ul>
    </div>
  </div>

  <h2 style="margin-top:9mm">종료 조건</h2>
  <div class="endcond">
    <div><div class="win">승리</div><p>최종 보스 오버마인드 파괴.</p></div>
    <div><div class="lose">패배</div><p>체력 0 — 단, 오버마인드는 이 판에서 관찰한 것을 기억한 채 다음 판을 기다린다.</p></div>
  </div>

  <div class="run">
    <h2 style="margin-bottom:2mm">실행 방법</h2>
    <div class="url">https://kwenhwang.github.io/overmind/</div>
    <ol>
      <li>브라우저에서 접속 후 <b style="color:var(--ink)">START</b> — 별도 설치·로그인·<b style="color:var(--ink)">API 키 불필요</b>.</li>
      <li>권장: 데스크톱 Chrome/Edge/Safari 최신 + 사운드 ON. 모바일 완전 지원.</li>
      <li>소스 코드: github.com/kwenhwang/overmind (로컬 실행은 README 참조).</li>
      <li>네트워크가 차단된 환경에서도 동작 — LLM 프록시 불통 시 규칙기반 AI로 자동 전환.</li>
    </ol>
    <div class="playerchip">
      <img src="{player}" alt="플레이어 전투기">
      <span>플레이어 — 아케이드 전투기. 3D 에셋은 CC0(Quaternius)와 자체 절차 생성(보스)으로 마련, 게임 코드·사운드·셰이더는 Claude Code로 전면 개발.</span>
    </div>
  </div>

  <footer><span class="b">OVERMIND — 게임 소개서</span><span>NAN 2026 예선 출품작</span><span>2 / 2</span></footer>
</section>
</body></html>"""

with open(OUT, "w") as f:
    f.write(HTML)
print("wrote", OUT, len(HTML), "bytes")
