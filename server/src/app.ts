import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { digestSchema, waveDesignSchema, bossDesignSchema } from './schema'
import { callLlm, pickProvider } from './llm'
import { issueToken, tokenIssuedAt, verifyToken, verifyTokenSignature } from './token'

export interface Env {
  /** 우선 사용 (gpt-5.4-mini 기본) */
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  /** 'openai' | 'anthropic' — 미설정 시 키 존재 순서로 자동 */
  PROVIDER?: string
  /** 쉼표 구분 허용 오리진. 미설정 시 로컬 개발용 전체 허용 */
  ALLOWED_ORIGINS?: string
  MODEL?: string
  /** gpt-5 계열 reasoning_effort (기본 'none', 'off'면 파라미터 제외) */
  REASONING_EFFORT?: string
  /** 일일 LLM 호출 상한 (기본 2000). 최종 방어선은 프로바이더 콘솔의 지출 한도 */
  MAX_DAILY_CALLS?: string
  /** 세션 토큰 HMAC 서명 키. 미설정 시 토큰 검증 생략(하위호환) */
  SESSION_SECRET?: string
  /**
   * 진단·에셋·RL 데이터 **조회**용 개발자 키 (2026-08-04 보안 감사).
   * 미설정이면 조회 라우트는 열리지 않고 503을 낸다 — 하위호환으로 열어두면
   * 설정을 깜빡한 배포가 곧 유출이라, 여기서는 fail-closed가 맞다.
   */
  DIAG_KEY?: string
  /** 진단 캡처 저장 KV (게임 내 진단 버튼 업로드) */
  DIAG?: {
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
    get(key: string): Promise<string | null>
  }
}

const RATE_LIMIT_PER_MIN = 10

// 인메모리 카운터 — CF Worker는 아이솔레이트별이라 근사치지만,
// 진짜 상한은 Anthropic 콘솔 지출 한도가 담당한다 (다층 방어의 한 층일 뿐).
const perIp = new Map<string, { count: number; windowStart: number }>()
let daily = { date: '', calls: 0 }

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = perIp.get(ip)
  if (!entry || now - entry.windowStart > 60_000) {
    perIp.set(ip, { count: 1, windowStart: now })
    if (perIp.size > 10_000) perIp.clear() // 메모리 방어
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT_PER_MIN
}

function overDailyBudget(max: number): boolean {
  const today = new Date().toISOString().slice(0, 10)
  if (daily.date !== today) daily = { date: today, calls: 0 }
  if (daily.calls >= max) return true
  daily.calls++
  return false
}

// LLM 열화 감시 — LLM계열 폴백(no_key·budget·llm_error·schema_mismatch·proxy_error)이
// 연속되면 KV에 인시던트를 남기고 /health가 노출한다 (외부 가동감시가 키워드로 잡는 용도).
// 아이솔레이트별 카운터라 근사치지만, 키 만료 같은 전역 장애는 모든 아이솔레이트에서 쌓인다.
// 회복 시 플래그를 지우지 않는다(멀티 아이솔레이트 핑퐁 방지) — TTL 만료로 자연 해제.
let llmFailStreak = 0
let degradedPutAt = 0
const LLM_DEGRADED = { key: 'stat:llm_degraded', after: 5, ttl: 21_600, refreshMs: 3_600_000 }

async function noteLlmFallback(env: Env, reason: string): Promise<void> {
  llmFailStreak++
  if (llmFailStreak < LLM_DEGRADED.after) return
  // 임계 도달 순간 1회 + 장애 지속 중 1h마다 갱신 — 저트래픽 장애도 TTL(6h)이 끊기지 않게
  const now = Date.now()
  if (llmFailStreak !== LLM_DEGRADED.after && now - degradedPutAt < LLM_DEGRADED.refreshMs) return
  if (!env.DIAG) return
  try {
    await env.DIAG.put(
      LLM_DEGRADED.key,
      JSON.stringify({ at: new Date().toISOString(), reason, streak: llmFailStreak }),
      { expirationTtl: LLM_DEGRADED.ttl },
    )
    degradedPutAt = now
  } catch (err) {
    console.error('llm_degraded_put_failed', err)
  }
}

export function createApp(getEnv: (c: { env: unknown }) => Env) {
  const app = new Hono()

  app.use('*', async (c, next) => {
    const env = getEnv(c)
    const origins = env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim())
    return cors({
      origin: origins && origins.length > 0 ? origins : '*',
      allowMethods: ['POST', 'GET', 'OPTIONS'],
      allowHeaders: ['content-type', 'x-session-token', 'x-run-token'],
    })(c, next)
  })

  // llm 필드: 외부 가동감시(Uptime Kuma)가 '"llm":"ok"' 키워드 부재로 경보하는 용도.
  // gates 필드: 시크릿 주입을 깜빡한 배포가 게이트를 '조용히 무효화'하는 함정 대비 —
  // 키 값은 절대 노출하지 않고 켜짐/꺼짐만 알린다. 감시는 '"session":"on"' 부재로 잡는다.
  app.get('/health', async (c) => {
    const env = getEnv(c)
    // KV 없는 런타임(node 예비)에선 판별 불가 — 'ok' 오보 대신 'unknown'
    let llm = 'unknown'
    if (env.DIAG) {
      try {
        llm = (await env.DIAG.get(LLM_DEGRADED.key)) ? 'degraded' : 'ok'
      } catch {
        llm = 'unknown'
      }
    }
    return c.json({
      ok: true,
      llm,
      gates: { diag: env.DIAG_KEY ? 'on' : 'off', session: env.SESSION_SECRET ? 'on' : 'off' },
    })
  })

  // ── 진단·에셋·RL KV (2026-08-04 보안 감사) ────────────────────────────────
  // 비대칭 설계인 이유를 적어둔다:
  //   업로드(POST)는 **브라우저**가 부른다(게임 내 '진단 전송' 버튼, 뷰어의 '서버로
  //   전송'). 클라이언트에 넣은 시크릿은 시크릿이 아니므로 POST에 DIAG_KEY를 걸 수 없다 —
  //   대신 per-IP 리미터 + 세션 토큰(requireSession, 2026-08-18)으로 문턱을 올린다.
  //   조회(GET)는 **개발자만** curl로 부른다. 여기가 진짜 구멍이었다: /diag GET이
  //   사용자 실기기 화면 캡처(dataURL)를 인증 없이 아무에게나 내주고 있었고,
  //   워커 URL은 배포 번들에 하드코딩(src/ai/director.ts)돼 있어 누구나 안다.
  //   그래서 GET만 DIAG_KEY로 잠근다.
  const requireDiagKey = (c: Context) => {
    const env = getEnv(c)
    if (!env.DIAG_KEY) return c.json({ ok: false, reason: 'diag_key_unset' }, 503)
    if (c.req.header('x-diag-key') !== env.DIAG_KEY) {
      return c.json({ ok: false, reason: 'unauthorized' }, 401)
    }
    return null
  }

  /**
   * 호출자 IP — CF 워커는 cf-connecting-ip, 그 밖(node 예비 런타임·프록시 뒤)은 XFF.
   * cf-connecting-ip만 읽으면 헤더가 없는 런타임에서 **모든 사용자가 한 버킷**('unknown')에
   * 묶여 남의 제출이 내 429가 된다(codex 교차검증 지적 2026-09-13). /directive와 같은 해석을 쓴다.
   */
  //
  // XFF는 **마지막** 항목을 쓴다(predeploy codex 2026-09-29, T-2026W38-396): 첫 항목은 클라이언트가
  // 마음대로 적어 보낼 수 있어 헤더만 바꾸면 per-IP 제한을 무제한 우회한다. 마지막 항목은 우리 앞단
  // 프록시(nginx 등)가 덧붙인 직전 홉이라 클라이언트가 못 고친다. CF 워커는 cf-connecting-ip가 우선이다.
  const clientIp = (c: Context) =>
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',').pop()?.trim() ?? 'unknown'

  // 업로드 도배 방지 — LLM 경로와 같은 per-IP 창을 쓴다(별도 예산이 아니라 남용 방지).
  const uploadThrottled = (c: Context) => rateLimited(`upload:${clientIp(c)}`)

  /**
   * 업로드(POST) 문턱 — /directive와 같은 세션 토큰을 재사용한다 (2026-08-18).
   * 키가 아니라 문턱인 이유: /session은 공개 발급이라 스크립트도 토큰을 받을 수 있다.
   * 그래도 (a) 헤더 없는 무작정 POST를 막고 (b) 토큰 30분 TTL로 재사용을 끊고
   * (c) 리미터와 곱해져 KV 오염 비용을 올린다. 진짜 비밀은 조회(GET)의 DIAG_KEY 쪽이다.
   * SESSION_SECRET 미설정 시엔 검증을 생략한다 — 로컬(node.ts)·KV 없는 예비 런타임
   * 호환. 라이브 설정 여부는 /health의 gates.session으로 밖에서 확인한다.
   */
  const requireSession = async (c: Context): Promise<Response | null> => {
    const env = getEnv(c)
    if (!env.SESSION_SECRET) return null
    const ok = await verifyToken(env.SESSION_SECRET, c.req.header('x-session-token'))
    return ok ? null : c.json({ ok: false, reason: 'no_token' }, 401)
  }

  // 진단 캡처 업로드 — 게임 내 '진단 전송' 버튼이 화면(dataURL)+렌더 정보를 올림.
  app.post('/diag', async (c) => {
    const env = getEnv(c)
    const denied = await requireSession(c)
    if (denied) return denied
    if (!env.DIAG) return c.json({ ok: false, reason: 'no_kv' })
    if (uploadThrottled(c)) return c.json({ ok: false, reason: 'rate_limited' }, 429)
    const body = await c.req.text() // {img, info} JSON 문자열 (최대 ~수백KB)
    if (body.length > 20 * 1024 * 1024) return c.json({ ok: false, reason: 'too_large' }, 413)
    await env.DIAG.put('latest', body, { expirationTtl: 86400 })
    return c.json({ ok: true })
  })

  app.get('/diag', async (c) => {
    const denied = requireDiagKey(c)
    if (denied) return denied
    const env = getEnv(c)
    const v = env.DIAG ? await env.DIAG.get('latest') : null
    return v ? c.body(v, 200, { 'content-type': 'application/json' }) : c.json({ ok: false })
  })

  // 에셋 업로드 — 뷰어의 '서버로 전송' 버튼이 생성한 GLB(base64)+슬롯을 올림.
  // 개발자가 curl로 받아 public/models/에 통합. 최신본 'model-latest' 고정키.
  app.post('/model', async (c) => {
    const env = getEnv(c)
    const denied = await requireSession(c)
    if (denied) return denied
    if (!env.DIAG) return c.json({ ok: false, reason: 'no_kv' })
    if (uploadThrottled(c)) return c.json({ ok: false, reason: 'rate_limited' }, 429)
    const body = await c.req.text() // {slot, name, glb(base64)} JSON
    if (body.length > 24 * 1024 * 1024) return c.json({ ok: false, reason: 'too_large' }, 413)
    await env.DIAG.put('model-latest', body, { expirationTtl: 86400 })
    return c.json({ ok: true })
  })

  app.get('/model', async (c) => {
    const denied = requireDiagKey(c)
    if (denied) return denied
    const env = getEnv(c)
    const v = env.DIAG ? await env.DIAG.get('model-latest') : null
    return v ? c.body(v, 200, { 'content-type': 'application/json' }) : c.json({ ok: false })
  })

  // 게임플레이 로그(RL 데이터셋) 업로드/조회 — ?rl 모드 에피소드. KV 재사용.
  app.post('/rl', async (c) => {
    const env = getEnv(c)
    const denied = await requireSession(c)
    if (denied) return denied
    if (!env.DIAG) return c.json({ ok: false, reason: 'no_kv' })
    if (uploadThrottled(c)) return c.json({ ok: false, reason: 'rate_limited' }, 429)
    const body = await c.req.text()
    if (body.length > 24 * 1024 * 1024) return c.json({ ok: false, reason: 'too_large' }, 413)
    await env.DIAG.put('rl-latest', body, { expirationTtl: 604800 }) // 7일
    return c.json({ ok: true })
  })
  app.get('/rl', async (c) => {
    const denied = requireDiagKey(c)
    if (denied) return denied
    const env = getEnv(c)
    const v = env.DIAG ? await env.DIAG.get('rl-latest') : null
    return v ? c.body(v, 200, { 'content-type': 'application/json' }) : c.json({ ok: false })
  })

  /**
   * 점수 상한 2층 — 위조 점수가 공개 리더보드 최상단을 점거하는 것을 막는다.
   *
   * 1) 웨이브별 상한(SCORE_PER_WAVE_CAP): 클라가 보낸 wave 기준이라 **위조 가능한 값**이다.
   *    그래서 이건 천장일 뿐 근거가 아니다.
   * 2) 토큰 경과시간 상한(SCORE_PER_SEC_CAP): 근거는 /session이 서명해 준 발급 시각이다 —
   *    SECRET을 모르면 못 고친다. "그 시각 이후 지금까지 사람이 실제로 벌 수 있었을 최대치"를
   *    넘는 점수는 거절한다. 즉 위조하려면 진짜 플레이와 **같은 벽시계 시간**을 들여야 한다
   *    (codex 교차검증 지적 2026-09-13: wave만 보면 토큰 하나로 1,100,000점 즉시 주입 가능).
   *
   * 수치 근거(2026-09-13 라이브 리더보드 실측): 최고 기록 v9 웨이브9 166,850점.
   * 웨이브당 ~18.5k(→ 상한 100k, 5배 여유), 한 판을 10분으로 잡아 ~278점/초
   * (→ 상한 1,500점/초, 5배 여유). 짧은 판의 오차는 SCORE_FREE_ALLOWANCE로 흡수한다.
   */
  /**
   * 자동화(우리 감사 렌즈·QA 프로브)의 라이브 리더보드 오염 차단 + 자가청소 (T-2026W38-396, 2026-09-19).
   *
   * 계기 — 공개 보드가 두 번 오염됐다. 둘 다 외부 공격이 아니라 **우리 야간 감사 렌즈**였다:
   *   · v9 1위 `qa-probe-p0` 9,999,999점(웨이브11, 2026-09-18) — 보안 렌즈가 위조 점수 경로를 라이브에서 시험.
   *   · v11 `test-ux-revi` 1점(웨이브1, 2026-09-12) — UX 렌즈가 헤드리스로 판을 끝내고 이름을 남겨 6일 잔류.
   * 빗장은 두 겹이고 여기가 서버 겹이다(클라 겹 = `isAutomatedSession()` · src/ai/director.ts):
   *   (a) 예약 이름(프로브·테스트 티가 나는 이름)은 공개 버전 보드에 못 들어간다 — 모래상자 버전으로 가라.
   *   (b) **이미 KV에 앉은 오염은 읽기에서 안 보이고, 다음 제출 때 격리 키로 옮겨진다.**
   *       배포만 하면 저절로 청소되는 쪽을 골랐다 — 수동 KV 수술은 자격(CF 토큰)이 있는 사람만 할 수 있고,
   *       그 대기 때문에 v11 오염이 6일을 살아남았다. 다만 **지우지는 않는다**: 격리 키에 옮겨 적고 나서만 뺀다.
   */
  // 영문 낱말은 **낱말 경계**로만 본다 — 부분 문자열로 보면 contest·robot 같은 정상 이름이 거절되고
  // 기존 기록이 오염으로 오판돼 격리된다(predeploy codex 2026-09-29). 경계 = 영숫자가 아닌 글자·양끝.
  const RESERVED_NAME =
    /(테스트|(^|[^a-z0-9])(qa[-_ ]?probe|probe|test|bot|audit|e2e|smoke|crawler|headless|playwright|puppeteer|selenium|lighthouse)(?=$|[^a-z0-9]))/i
  /** 자동화가 점수를 넣어도 되는 유일한 버전 키 — 공개 보드가 아니라 모래상자다 */
  const SANDBOX_VERSION = 'sandbox'
  /** 격리 보관 상한 — 증거는 남기되 KV 값이 무한히 자라지 않게 */
  const QUARANTINE_MAX = 50

  const SCORE_PER_WAVE_CAP = 100_000
  const SCORE_PER_SEC_CAP = 1_500
  const SCORE_FREE_ALLOWANCE = 2_000
  /** 판 시작 시계로 인정할 토큰의 최대 나이 — 한 세션(브라우저 탭)의 수명을 넘는 것은 안 본다 */
  const SCORE_CLOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000

  type BoardEntry = { name: string; score: number; wave: number; at: number }

  /** 공개 보드에 있으면 안 되는 항목 — 위조 점수(현행 상한 초과)이거나 자동화 이름 */
  const isPolluted = (e: BoardEntry): boolean =>
    !Number.isFinite(e?.score) ||
    // 저장된 wave도 제출 경로와 같이 11로 묶는다 — 가짜 큰 wave가 상한을 같이 키워 필터를 우회하면 안 된다
    e.score > SCORE_PER_WAVE_CAP * Math.max(1, Math.min(11, Math.floor(Number(e?.wave) || 0))) ||
    RESERVED_NAME.test(String(e?.name ?? ''))

  /** 저장된 보드를 깨끗한 것/오염된 것으로 가른다 (모래상자 버전은 원본 그대로 둔다) */
  const partitionBoard = (board: BoardEntry[], version: string) => {
    if (version === SANDBOX_VERSION) return { clean: board, dirty: [] as BoardEntry[] }
    const clean: BoardEntry[] = []
    const dirty: BoardEntry[] = []
    for (const e of board) (isPolluted(e) ? dirty : clean).push(e)
    return { clean, dirty }
  }

  // 전역 리더보드 — 점수 제출/조회 (KV 'leaderboard', 상위 50 유지)
  //
  // 제출(POST)은 업로드 라우트(/diag·/model·/rl)와 같은 문턱을 쓴다 (2026-09-13, T-2026W37-244).
  // 그 전에는 인증도 리미터도 없어 `curl -XPOST .../score '{"score":9999999}'`가 그대로
  // 공개 리더보드에 들어갔다. 세션 토큰은 /session이 공개 발급이라 '키'는 아니지만,
  // (a) 헤더 없는 무작정 POST를 끊고 (b) per-IP 리미터와 (c) 웨이브별 점수 상한과 곱해져
  // 위조 비용을 올린다. 게임 클라이언트는 이미 같은 토큰을 들고 다닌다(src/ai/director.ts).
  app.post('/score', async (c) => {
    const env = getEnv(c)
    const denied = await requireSession(c)
    if (denied) return denied
    if (!env.DIAG) return c.json({ ok: false, reason: 'no_kv' })
    if (rateLimited(`score:${clientIp(c)}`)) {
      return c.json({ ok: false, reason: 'rate_limited' }, 429)
    }
    const body = (await c.req.json().catch(() => null)) as { name?: string; score?: number; wave?: number; version?: string } | null
    if (!body || typeof body.score !== 'number' || !Number.isFinite(body.score) || body.score < 0) {
      return c.json({ ok: false, reason: 'bad_score' }, 400)
    }
    // 웨이브는 점수 상한의 근거가 되므로 먼저 정규화한다 — 상한만 크게 부르려는 wave 위조 차단
    const wave = Math.max(0, Math.min(11, Math.floor(Number(body.wave) || 0)))
    if (body.score > SCORE_PER_WAVE_CAP * Math.max(1, wave)) {
      return c.json({ ok: false, reason: 'implausible_score' }, 400)
    }
    // 서명된 발급 시각 대비 '벌 수 있었을 최대치' — 갓 받은 토큰으로는 큰 점수를 못 넣는다.
    // (인증 토큰의 서명은 위 requireSession이 이미 검증했다. SESSION_SECRET 미설정 런타임은 종전대로.)
    //
    // 시계는 클라가 **지금 들고 있는 가장 오래된 토큰**(x-run-token)으로 잡는다. 인증 토큰은
    // TTL 30분마다 갱신되므로, 그것만 보면 긴 세션에서 판 도중 갱신이 일어나 정상 점수가
    // too_fast로 거절된다(codex 교차검증 지적 2026-09-13 — /directive 프리페치가 토큰을 갱신한다).
    // 판 시작 시계는 인증이 아니라 '우리가 그때 발급했다'는 사실만 필요하므로 만료를 보지 않고
    // 서명만 검증한다. 더 이른 쪽만 채택하므로 이 헤더로 상한을 **좁힐 수는 있어도 못 넓힌다**.
    let clockAt = env.SESSION_SECRET ? tokenIssuedAt(c.req.header('x-session-token')) : null
    if (clockAt !== null) {
      const runTok = c.req.header('x-run-token')
      const runAt = tokenIssuedAt(runTok)
      if (
        runAt !== null &&
        runAt < clockAt &&
        Date.now() - runAt < SCORE_CLOCK_MAX_AGE_MS &&
        (await verifyTokenSignature(env.SESSION_SECRET!, runTok))
      ) {
        clockAt = runAt
      }
      const elapsedSec = Math.max(0, (Date.now() - clockAt) / 1000)
      if (body.score > SCORE_FREE_ALLOWANCE + SCORE_PER_SEC_CAP * elapsedSec) {
        return c.json({ ok: false, reason: 'too_fast' }, 400)
      }
    }
    // 밸런스 버전별 리더보드 분리 — 난이도가 바뀌면 점수 비교가 불공정하므로 키를 버전으로 나눔
    const version = (String(body.version ?? 'v0').replace(/[^a-z0-9._-]/gi, '').slice(0, 16)) || 'v0'
    const entry = {
      name: String(body.name ?? '익명').slice(0, 12).replace(/[<>&]/g, ''),
      score: Math.floor(body.score),
      wave,
      at: Date.now(),
    }
    // 자동화 제출 차단 — 프로브가 공개 보드에 이름을 남기지 못하게 한다.
    // 막기만 하면 렌즈가 갈 곳이 없어 또 라이브를 때리므로, 갈 곳(모래상자)을 사유에 적어 돌려준다.
    if (version !== SANDBOX_VERSION && RESERVED_NAME.test(entry.name)) {
      return c.json(
        { ok: false, reason: 'reserved_name', hint: `automation must submit with version="${SANDBOX_VERSION}"` },
        400,
      )
    }
    const key = `leaderboard:${version}`
    try {
      const raw = await env.DIAG.get(key)
      const stored = raw ? (JSON.parse(raw) as BoardEntry[]) : []
      const { clean, dirty } = partitionBoard(stored, version)
      let board = clean
      let keepDirty = false
      if (dirty.length > 0) {
        // 지우기 전에 옮겨 적는다 — 격리 기록에 실패하면 청소를 포기하고 오염을 그대로 둔다.
        // (증거 없는 삭제보다 눈에 보이는 오염이 낫다. 읽기 경로는 어차피 걸러 보여준다.)
        try {
          const qKey = `${key}:quarantine`
          const prevRaw = await env.DIAG.get(qKey)
          const prev = prevRaw ? (JSON.parse(prevRaw) as BoardEntry[]) : []
          await env.DIAG.put(qKey, JSON.stringify([...dirty, ...prev].slice(0, QUARANTINE_MAX)))
          console.error('leaderboard_quarantined', key, dirty.length)
        } catch (qErr) {
          console.error('leaderboard_quarantine_failed', qErr)
          board = stored
          keepDirty = true
        }
      }
      board = [...board, entry]
      board.sort((a, b) => b.score - a.score)
      // 격리에 실패했으면 상위 50 절단이 오염 항목을 증거 없이 지우지 않게 잘린 오염분을 되붙인다
      // (predeploy codex 2026-09-29 3차 — 청소 포기가 절단으로 뒷문 삭제가 되던 자리).
      const top = keepDirty
        ? [...board.slice(0, 50), ...board.slice(50).filter((e) => dirty.includes(e))]
        : board.slice(0, 50)
      await env.DIAG.put(key, JSON.stringify(top))
      return c.json({ ok: true, rank: top.findIndex((e) => e === entry) + 1, total: board.length })
    } catch (err) {
      // 단일 키 리더보드는 KV 키당 1write/sec 제한에 동시 제출이 걸릴 수 있음 — 무음 유실 금지
      console.error('score_kv_failed', err)
      return c.json({ ok: false, reason: 'kv_write_failed' }, 503)
    }
  })
  app.get('/leaderboard', async (c) => {
    const env = getEnv(c)
    const version = (String(c.req.query('v') ?? 'v0').replace(/[^a-z0-9._-]/gi, '').slice(0, 16)) || 'v0'
    const raw = env.DIAG ? await env.DIAG.get(`leaderboard:${version}`) : null
    // 읽기에서도 거른다 — 배포 즉시 공개 보드가 깨끗해진다(KV 정리는 다음 제출 때 따라온다).
    return c.json(raw ? partitionBoard(JSON.parse(raw) as BoardEntry[], version).clean : [])
  })

  // 게임 시작 시 1회 — 단기 서명 토큰 발급 (봇 진입 장벽)
  app.get('/session', async (c) => {
    const env = getEnv(c)
    if (!env.SESSION_SECRET) return c.json({ token: '' })
    return c.json({ token: await issueToken(env.SESSION_SECRET) })
  })

  app.post('/directive', async (c) => {
    const env = getEnv(c)
    const ip =
      clientIp(c)

    if (rateLimited(ip)) return c.json({ fallback: true, reason: 'rate_limited' }, 429)

    // 세션 토큰 검증 (SECRET 설정 시) — Origin 없는 봇/curl 차단
    if (env.SESSION_SECRET) {
      const ok = await verifyToken(env.SESSION_SECRET, c.req.header('x-session-token'))
      if (!ok) return c.json({ fallback: true, reason: 'no_token' }, 401)
    }

    const parsed = digestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ fallback: true, reason: 'bad_input' }, 400)

    if (!pickProvider(env)) {
      await noteLlmFallback(env, 'no_key')
      return c.json({ fallback: true, reason: 'no_key' })
    }
    if (overDailyBudget(Number(env.MAX_DAILY_CALLS) || 2000)) {
      await noteLlmFallback(env, 'budget')
      return c.json({ fallback: true, reason: 'budget' })
    }

    try {
      const raw = await callLlm(env, parsed.data)
      if (raw === null) {
        // llm.ts가 원인(401·빈 응답·JSON 파손)을 이미 console.error로 남긴 케이스.
        // null을 스키마에 넣으면 schema_mismatch로 위장되므로 사유를 구분한다.
        await noteLlmFallback(env, 'llm_error')
        return c.json({ fallback: true, reason: 'llm_error' })
      }
      const design = (parsed.data.boss ? bossDesignSchema : waveDesignSchema).safeParse(raw)
      if (!design.success) {
        console.error('schema_mismatch', JSON.stringify(raw)?.slice(0, 300))
        await noteLlmFallback(env, 'schema_mismatch')
        return c.json({ fallback: true, reason: 'schema_mismatch' })
      }
      llmFailStreak = 0
      return c.json({ ...design.data, fallback: false })
    } catch (err) {
      console.error('proxy_error', err)
      await noteLlmFallback(env, 'proxy_error')
      return c.json({ fallback: true, reason: 'proxy_error' })
    }
  })

  return app
}
