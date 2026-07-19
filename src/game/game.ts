import * as THREE from 'three'
import {
  PLAYER, TOTAL_WAVES, WAVE_INTERMISSION_SEC, SPAWN_TELEGRAPH_SEC, SCORE, BOSS, GAME_VERSION,
} from './config'
import type { EnemyType } from './config'
import { Boss } from './boss'
import { World } from './world'
import { Input, IS_TOUCH } from './input'
import { Player } from './player'
import { Enemy } from './enemies'
import { ProjectilePool } from './projectiles'
import { planWaveSpawns, spawnEnemies, createSpawnMarkers, type SpawnPlan } from './waves'
import { Hazard, resolveHazardPos } from './hazards'
import { Effects } from './effects'
import { sfx } from './sfx'
import { events } from './events'
import { Telemetry } from '../ai/telemetry'
import { requestWaveDesign, requestBossDesign, fallbackDesign, memory, uploadDiag, uploadRL, submitScore, fetchLeaderboard } from '../ai/director'
import { Recorder } from './recorder'
import { pickThree } from './upgrades'
import type { BossDesign, BossPhase, TelemetryDigest, WaveDesign } from '../ai/schema'
import { Hud } from '../ui/hud'

type State = 'title' | 'playing' | 'intermission' | 'bossIntro' | 'gameover' | 'victory'

const _toEnemy = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

/** 녹화 연기용 — 데스크톱에서도 모바일식 자동 조준·공격 */
const AUTO_AIM = new URLSearchParams(location.search).has('autoaim')
/** ?rl — 게임플레이 로깅(강화학습 데이터셋). 기본 off (오버헤드 0) */
const RL_MODE = new URLSearchParams(location.search).has('rl')
/** 쉬운 조작 — 자동 조준·사격 (이동+대시만). 아이·입문자용, localStorage 저장 */
function easyMode(): boolean {
  return localStorage.getItem('overmind-easy') === '1'
}

interface PendingSpawn {
  plan: SpawnPlan[]
  aggression: number
  hpMul: number
  timer: number
  markers: THREE.Mesh[]
}

export class Game {
  private world: World
  private input: Input
  private hud = new Hud()
  private effects: Effects
  private player!: Player
  private enemies: Enemy[] = []
  private projectiles: ProjectilePool
  private telemetry = new Telemetry()
  private state: State = 'title'
  private easy = false
  private upgradePending = false
  private scoreSubmitted = false
  private rl: Recorder | null = null
  private tickFire = false
  private tickMelee = false
  private wave = 0
  private intermissionTimer = 0
  private pendingDesign: WaveDesign | null = null
  /** 이 웨이브에 대해 다음 설계를 이미 프리페치했는지 (중복 요청 방지) */
  private prefetchedWave = -1
  /** 현재 웨이브에 스폰된 적 수 (프리페치 트리거 임계 계산용) */
  private waveEnemyCount = 0
  private pendingSpawn: PendingSpawn | null = null
  private hazardZones: Hazard[] = []
  private boss: Boss | null = null
  private bossDesign: BossDesign | null = null
  private bossIntroElapsed = 0
  private verdictTimer = -1
  /** 보스 파괴 시퀀스 (연쇄 폭발 후 승리 화면) */
  private bossDeathTimer = -1
  private bossDeathPos = new THREE.Vector3()
  private score = 0
  private combo = 0
  private comboTimer = 0
  /** 난이도별 점수 배율 — 쉬운 조작(자동 조준·사격)은 0.5배 + 리더보드도 분리 */
  private scoreMul = 1
  // 녹화 모드는 실시간 fps가 무의미 — 프로브 생략(블룸 유지)
  private fpsProbe = { frames: 0, start: 0, done: new URLSearchParams(location.search).has('record') }
  // ?norender — 헤드리스 검증용 렌더 스킵 (swiftshader 병목 제거, 로직만 구동)
  private noRender = new URLSearchParams(location.search).has('norender')

  constructor(canvas: HTMLCanvasElement) {
    this.world = new World(canvas)
    this.input = new Input(this.world.camera)

    // 진단 전송 버튼 — 사용자 실기기 화면+렌더정보를 개발자에게 업로드
    const diagBtn = document.getElementById('diag-btn') as HTMLButtonElement | null
    if (diagBtn) {
      diagBtn.onclick = async () => {
        diagBtn.textContent = '전송 중…'
        const cap = this.world.captureDiag()
        // 이 순간의 게임 상태(적 수·화면 내 적·좌표) 동봉 → 렌더 실패 vs 타이밍 구분
        cap.info.game = {
          state: this.state,
          enemies: this.enemies.length,
          onScreen: this.enemies.filter((e) => {
            const v = e.pos.clone().project(this.world.camera)
            return v.x > -1 && v.x < 1 && v.y > -1 && v.y < 1 && v.z < 1
          }).length,
          boss: !!this.boss,
          nearest: this.enemies[0] ? Math.round(this.enemies[0].pos.distanceTo(this.player.pos)) : -1,
          hp: this.player.hp,
          wave: this.wave,
          damage: this.player.damageBySource, // 피해 출처별 누적 — 개발자 분석용
        }
        const ok = await uploadDiag(cap)
        diagBtn.textContent = ok ? '전송됨 ✓' : '전송 실패'
        diagBtn.classList.toggle('sent', ok)
        setTimeout(() => (diagBtn.textContent = '진단 전송'), 3000)
      }
    }
    this.projectiles = new ProjectilePool(this.world.scene)
    this.effects = new Effects(this.world.scene, this.world.camera)

    events.on('lungeWarn', () => sfx.lungeWarn())
    events.on('spitterShot', () => sfx.shoot())

    // 헤드리스 검증용 상태 훅 (콘솔 출력 없음)
    ;(window as unknown as Record<string, unknown>).__dbg = () => ({
      state: this.state, wave: this.wave, timer: this.intermissionTimer.toFixed(2),
      hp: this.player?.hp, enemies: this.enemies.length, score: this.score,
      boss: this.boss ? { hp: Math.round(this.boss.hp), phase: this.boss.phaseIndex } : null,
      design: this.pendingDesign
        ? { bias: this.pendingDesign.spawnBias, reason: this.pendingDesign.counterReason, taunt: this.pendingDesign.taunt, hazards: this.pendingDesign.hazards?.map((h) => h.placement), spawns: this.pendingDesign.spawns.map((s) => `${s.type}x${s.count}${(s.modifiers ?? []).length ? '(' + s.modifiers!.join(',') + ')' : ''}`) }
        : null,
      prefetchedWave: this.prefetchedWave,
      dodge: this.telemetry.debugDodge(),
      nearest: this.enemies.length ? Math.round(this.findNearestEnemy()?.pos.distanceTo(this.player.pos) ?? -1) : -1,
      proj: this.projectiles.list.length,
      nearestScreen: (() => {
        const e = this.findNearestEnemy()
        if (!e) return null
        const v = e.pos.clone().project(this.world.camera)
        return { x: Math.round(((v.x + 1) / 2) * innerWidth), y: Math.round(((1 - v.y) / 2) * innerHeight) }
      })(),
      onScreen: this.enemies.filter((e) => {
        const v = e.pos.clone().project(this.world.camera)
        return v.x > -1 && v.x < 1 && v.y > -1 && v.y < 1 && v.z < 1
      }).length,
      // 분대 스태거·반사회피 검증용 카운트
      permits: this.enemies.filter((e) => !e.dead && e.attackPermit).length,
      dodging: this.enemies.filter((e) => !e.dead && e.isDodging).length,
      // 포위 진단: 살아있는 근접 적의 플레이어 기준 각도(도) — 무리 전술 확산 검증·튜닝용
      encAngles: this.enemies
        .filter((e) => !e.dead && e.type !== 'spitter')
        .map((e) => Math.round((Math.atan2(e.pos.z - this.player.pos.z, e.pos.x - this.player.pos.x) * 180) / Math.PI)),
    })
    // 검증·촬영용: 보스 즉사 (페이즈 강제 진행 포함 — 반복 호출)
    ;(window as unknown as Record<string, unknown>).__killBoss = () => this.boss?.takeDamage(99999)
    // 검증용: 보스 예측 조준 확인 — moveDir +x일 때 예측 지점이 플레이어보다 앞(오른쪽)이면 리드 작동
    ;(window as unknown as Record<string, unknown>).__bossDbg = () =>
      this.boss
        ? {
            hp: Math.round(this.boss.hp),
            phase: this.boss.phaseIndex,
            habitBias: Number(this.boss.habitBias.toFixed(2)),
            playerX: Number(this.player.pos.x.toFixed(2)),
            predMoveRight: this.boss.debugPredict(this.player, 1, 0),
          }
        : null
    // 검증용: 임의 텔레메트리 → 카운터 설계 (인과 보장 레이어 확인)
    ;(window as unknown as Record<string, unknown>).__designFor = (d: TelemetryDigest) => fallbackDesign(d)
    // 검증용: 근접 적 N기를 원형으로 스폰 (무리 전술 포위 확산 확인)
    ;(window as unknown as Record<string, unknown>).__spawnRing = (type = 'drone', n = 6, mods: string[] = []) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const pos = new THREE.Vector3(Math.cos(a) * 10, 0, Math.sin(a) * 10)
        const e = new Enemy(type as EnemyType, pos, this.world.scene, mods as never)
        e.aggression = 4
        this.enemies.push(e)
      }
    }

    // 쉬운 조작 토글 (타이틀) — localStorage 저장, 터치도 항상 자동전투라 데스크톱에서만 노출
    const easyToggle = document.getElementById('easy-toggle') as HTMLInputElement | null
    const easyLabel = document.getElementById('easy-label')
    if (easyToggle && easyLabel) {
      if (IS_TOUCH) easyLabel.style.display = 'none'
      easyToggle.checked = easyMode()
      easyToggle.onchange = () => localStorage.setItem('overmind-easy', easyToggle.checked ? '1' : '0')
    }
    // ?autostart — 헤드리스 검증·영상 촬영용 즉시 시작
    if (new URLSearchParams(location.search).has('autostart')) {
      this.startRun()
    } else {
      this.hud.showScreen(
        'OVERMIND',
        IS_TOUCH
          ? '적 웨이브 11개를 버텨라.\n적의 두뇌(AI)가 네 플레이 습관을 관찰하고, 다음 웨이브를 너를 잡도록 재설계한다.\n\n왼쪽 화면 드래그 = 이동 · 오른쪽 탭 = 대시(무적)\n공격은 자동 — 회피에 집중하라'
          : '적 웨이브 11개를 버텨라.\n적의 두뇌(AI)가 네 플레이 습관을 관찰하고, 다음 웨이브를 너를 잡도록 재설계한다.\n\n이동 WASD·방향키 · 조준 마우스 · 사격 좌클릭\n대시(무적) Space 또는 우클릭 · 근접은 밀착 시 자동',
        'START',
        () => this.startRun(),
      )
    }
  }

  private startRun(): void {
    this.easy = easyMode() // 타이틀 토글 반영
    this.scoreMul = this.easy ? 0.5 : 1
    this.rl = RL_MODE ? new Recorder() : null
    for (const e of this.enemies) this.world.scene.remove(e.root)
    this.enemies = []
    this.projectiles.clear()
    this.effects.clear()
    this.clearPendingSpawn()
    this.clearHazards()
    this.boss?.dispose()
    this.boss = null
    this.bossDesign = null
    this.bossDeathTimer = -1
    this.prefetchedWave = -1
    this.waveEnemyCount = 0
    this.upgradePending = false
    this.scoreSubmitted = false
    this.hud.hideBossBar()
    this.hud.hideUpgrades()
    this.hud.hideLeaderboard()
    this.world.setCoreVisible(true)
    if (this.player) this.world.scene.remove(this.player.mesh)

    this.player = new Player(this.world.scene)
    this.player.onDash = (dir) => {
      this.telemetry.recordDash(dir)
      sfx.dash()
      this.world.ripple(this.player.pos) // 대시 파동 — 바닥이 반응
      // mirror_dash 모디파이어: 오버마인드가 회피 자체에 반응한다
      for (const e of this.enemies) e.mirrorDash(dir)
    }
    this.telemetry = new Telemetry()
    this.wave = 0
    this.score = 0
    this.combo = 0
    this.hud.setScore(0, 0)
    memory.startRun()
    // ?boss — 보스전 직행 (검증·영상 촬영용 디버그)
    if (new URLSearchParams(location.search).has('boss')) {
      this.wave = TOTAL_WAVES
      this.hud.setWave(this.wave, TOTAL_WAVES)
      this.startBossIntro()
      return
    }
    this.startIntermission()
  }

  /** 웨이브 사이 — 오버마인드가 다음 판을 설계하는 시간 (LLM 지연 흡수 구간) */
  private startIntermission(): void {
    this.state = 'intermission'
    this.intermissionTimer = WAVE_INTERMISSION_SEC
    // pendingDesign은 프리페치가 채웠을 수 있으므로 여기서 지우지 않는다 (재요청 시 else에서 초기화)
    this.clearHazards()
    this.hud.showIntermission('OVERMIND 재구성 중…')

    const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
    this.hud.showReport(digest, memory.profile()) // 오버마인드가 "본 것"과 "기억"을 노출
    if (this.wave === 0) {
      // 첫 웨이브: 아직 관측 데이터가 없어 LLM이 할 일이 없음 → 폴백 즉시 (게임 시작 지연 방지)
      this.pendingDesign = fallbackDesign(digest)
    } else if (this.prefetchedWave === this.wave) {
      // 전투 중 프리페치가 이미 이 웨이브의 설계를 받았으면 그대로 사용 (LLM 대사 노출)
      if (this.pendingDesign) this.hud.showCounter(this.pendingDesign.counterReason)
    } else {
      // 빠른 클리어 등으로 프리페치가 없으면 지금 요청 — 업그레이드 선택 시간 동안 도착
      this.pendingDesign = null
      this.requestDesign(digest)
    }

    // 업그레이드 3택 — 매 웨이브는 잦아 스노우볼로 밸런스 붕괴 → '격 웨이브'(2·4)만.
    // 성장 대결 구도는 유지하되 AI 카운터 챌린지가 트리비얼해지지 않게 절제.
    if (this.wave >= 2 && this.wave % 2 === 0) {
      this.upgradePending = true
      const choices = pickThree()
      let picked = false
      const pick = (i: number): void => {
        if (picked) return
        picked = true
        choices[i].apply(this.player)
        this.upgradePending = false
      }
      this.hud.showUpgrades(choices, pick)
      // 안전장치: 선택 UI가 안 먹혀도(모바일 등) 게임이 인터미션에서 멈추지 않게 15초 후 자동선택
      setTimeout(() => {
        if (!picked) {
          this.hud.hideUpgrades()
          pick(0)
        }
      }, 15000)
    }
  }

  /** 웨이브 설계 요청 (프리페치·인터미션 공용). 도착 시 pendingDesign 갱신 + 인터미션이면 카운터 노출 */
  private requestDesign(digest: TelemetryDigest): void {
    requestWaveDesign(digest).then((design) => {
      this.pendingDesign = design
      if (this.state === 'intermission') this.hud.showCounter(design.counterReason)
    })
  }

  private startWave(): void {
    const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
    const design = this.pendingDesign ?? fallbackDesign(digest)
    this.pendingDesign = null // 소비 후 즉시 비움 — 다음 웨이브가 직전 stale 설계를 재사용하던 버그 차단
    this.wave++
    this.state = 'playing'
    this.hud.hideIntermission()
    this.hud.hideReport()
    this.hud.hideUpgrades()
    this.hud.setWave(this.wave, TOTAL_WAVES)
    this.hud.showTaunt(design.taunt)
    sfx.taunt()
    this.telemetry.resetWaveStats()
    this.telemetry.startWave()
    this.world.setMood(design.mood)

    // 해저드 — 텔레그래프 시점부터 보여서 배치 의도가 읽히게
    this.clearHazards()
    for (const h of (design.hazards ?? []).slice(0, 2)) {
      const pos = resolveHazardPos(h.placement, this.player.pos)
      this.hazardZones.push(new Hazard(h, pos, this.world.scene))
    }

    // 스폰은 경고 링 텔레그래프 후 — "의도된 배치"로 읽히게
    const plan = planWaveSpawns(design, this.player.pos)
    this.pendingSpawn = {
      plan,
      aggression: design.aggression,
      hpMul: 1 + (this.wave - 1) * 0.2, // 후반 웨이브 적 체력↑ (W1=1.0 … W8=2.05)
      timer: SPAWN_TELEGRAPH_SEC,
      markers: createSpawnMarkers(plan, this.world.scene),
    }
  }

  private clearPendingSpawn(): void {
    if (this.pendingSpawn) {
      for (const m of this.pendingSpawn.markers) this.world.scene.remove(m)
      this.pendingSpawn = null
    }
  }

  private clearHazards(): void {
    for (const h of this.hazardZones) {
      this.world.scene.remove(h.mesh)
      h.dispose()
    }
    this.hazardZones = []
  }

  /** 웨이브 5 클리어 → 최종 프로토콜: LLM이 누적 프로파일로 보스전을 설계 */
  private startBossIntro(): void {
    this.state = 'bossIntro'
    this.bossIntroElapsed = 0
    this.verdictTimer = -1
    this.clearHazards()
    this.hud.showIntermission('최종 프로토콜 기동…')
    // 웨이브5 중 프리페치로 이미 받았으면 그대로 사용 (LLM 판결문 노출). 아니면 지금 요청.
    if (!this.bossDesign) {
      const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
      requestBossDesign(digest).then((design) => {
        this.bossDesign = design
      })
    }
  }

  private updateBossIntro(dt: number): void {
    this.bossIntroElapsed += dt
    // 설계 도착 + 최소 연출 2초 후: 판결문 낭독
    if (this.bossDesign && this.verdictTimer < 0 && this.bossIntroElapsed >= 2) {
      this.hud.hideIntermission()
      // 분석 낭독 대신 한 줄 위협만 — "관찰했다"의 증거는 웨이브 리포트가 이미 보여줌. 보스는 짧고 위압적으로.
      const line = this.bossDesign.verdict.split(/(?<=[.!?…。])\s/)[0].slice(0, 60)
      this.hud.showTaunt(line, 4.5)
      sfx.taunt()
      this.verdictTimer = 3.5
    }
    if (this.verdictTimer > 0) {
      this.verdictTimer -= dt
      if (this.verdictTimer <= 0) this.spawnBoss()
    }
  }

  private spawnBoss(): void {
    const design = this.bossDesign!
    this.world.setMood(design.mood)
    this.world.setCoreVisible(false) // 중앙 코어가 '내려온다'
    this.boss = new Boss(design, this.world.scene, this.effects)
    this.boss.onPhase = (i) => this.enterBossPhase(design.phases[i])
    this.hud.showBossBar(design.phases[0].name)
    this.state = 'playing'
    sfx.waveStart()
    this.effects.shake(0.5)
    this.enterBossPhase(design.phases[0])
  }

  /** 페이즈 진입 — LLM이 설계한 지원 스폰·해저드·대사 실행 */
  private enterBossPhase(phase: BossPhase): void {
    this.hud.setBossPhaseName(phase.name)
    // 페이즈0 바크는 방금 낭독한 인트로와 겹쳐 '연속 수다'가 되므로 생략 — 실제 전환(1+)에서만 짧게.
    if (this.boss && this.boss.phaseIndex > 0) {
      this.hud.showTaunt(phase.taunt)
      sfx.taunt()
    }
    this.effects.shake(0.35)
    this.clearHazards()
    for (const h of (phase.hazards ?? []).slice(0, 2)) {
      const pos = resolveHazardPos(h.placement, this.player.pos)
      this.hazardZones.push(new Hazard(h, pos, this.world.scene))
    }
    if (this.boss) {
      for (const group of phase.minions.slice(0, 2)) {
        for (let i = 0; i < Math.min(group.count, 4); i++) {
          const a = Math.random() * Math.PI * 2
          const pos = this.boss.pos
            .clone()
            .add(new THREE.Vector3(Math.cos(a) * 4, 0, Math.sin(a) * 4))
          const minion = new Enemy(group.type, pos, this.world.scene, group.modifiers ?? [])
          minion.aggression = 4
          this.enemies.push(minion)
          this.effects.burst(pos, minion.color, 4, 4)
        }
      }
    }
  }

  /** 보스 파괴 — 즉시 화면 전환하지 않고 연쇄 폭발 시퀀스(1.8초) 후 승리 */
  private onBossDefeated(): void {
    if (!this.boss || this.bossDeathTimer >= 0) return
    this.bossDeathTimer = 1.8
    this.bossDeathPos.copy(this.boss.pos)
    this.effects.hitstop(0.35)
    this.effects.shake(0.8)
    sfx.enemyDie()
    // 남은 미니언 동반 폭발 — 승리의 화룡점정
    for (const e of this.enemies) {
      e.dead = true
      this.effects.burst(e.pos, e.color, 10, 8)
      this.world.scene.remove(e.root)
    }
    this.enemies = []
  }

  private updateBossDeath(dt: number): void {
    this.bossDeathTimer -= dt
    // 연쇄 폭발 (프레임 확률 기반 — 저사양에서도 밀도 유지)
    if (Math.random() < dt * 14) {
      const off = new THREE.Vector3((Math.random() - 0.5) * 3.4, 0, (Math.random() - 0.5) * 3.4)
      this.effects.burst(this.bossDeathPos.clone().add(off), Math.random() < 0.5 ? 0xff5f2e : 0xffffff, 8, 9)
      this.effects.shake(0.35)
      sfx.enemyHit()
    }
    if (this.bossDeathTimer <= 0 && this.boss) {
      this.effects.burst(this.bossDeathPos, 0xffffff, 34, 15)
      this.effects.shake(1.2)
      sfx.enemyDie()
      this.boss.dispose()
      this.boss = null
      this.hud.hideBossBar()
      this.score += Math.round(SCORE.boss * this.scoreMul)
      this.hud.setScore(this.score, this.combo)
      this.endRun(true)
    }
  }

  update(dt: number): void {
    // 첫 3초(실시간) fps 실측 — 24fps 미만이면 블룸 오프 (저사양 심사 기기 대응)
    if (!this.fpsProbe.done) {
      if (this.fpsProbe.start === 0) this.fpsProbe.start = performance.now()
      this.fpsProbe.frames++
      const realSec = (performance.now() - this.fpsProbe.start) / 1000
      if (realSec >= 3) {
        this.fpsProbe.done = true
        if (this.fpsProbe.frames / realSec < 24) this.world.disableBloom()
      }
    }

    if (this.state === 'title' || this.state === 'gameover' || this.state === 'victory') {
      if (!this.noRender) this.world.render()
      return
    }

    // 히트스톱: 전투 시간만 느려지고 카메라·이펙트 감쇠는 실시간
    const combatDt = dt * this.effects.timeScale(dt)
    const hpAtFrameStart = this.player.hp

    // 해저드 효과 (가시 피해·감속) — 이동 계산 전에 적용
    let speedMul = 1
    if (this.state === 'playing') {
      for (const h of this.hazardZones) {
        speedMul = Math.min(speedMul, h.update(combatDt, this.player))
        h.updateLabel(this.world.camera)
      }
    }
    this.player.speedMul = speedMul

    this.input.updateAim()
    this.player.update(combatDt, this.input)
    this.telemetry.tick(combatDt, this.player.pos, this.player.moveDir)

    if (this.state === 'intermission') {
      this.intermissionTimer -= dt
      const elapsed = WAVE_INTERMISSION_SEC - this.intermissionTimer
      // 업그레이드 선택 대기 중이면 웨이브 시작 보류 (선택이 곧 진행 트리거 — 선택 시간이 LLM 지연을 흡수).
      // 선택 완료 후: LLM 설계 도착 시 최소 연출(2.5초) 후, 미도착이면 유예(-5초) 뒤 폴백 시작.
      if (!this.upgradePending && ((this.pendingDesign && elapsed >= 2.5) || this.intermissionTimer <= -5)) {
        this.startWave()
      }
    } else if (this.state === 'bossIntro') {
      this.updateBossIntro(dt)
    } else {
      this.updateSpawnTelegraph(combatDt)
      this.updateCombat(combatDt)
      if (this.boss) {
        // 라이브 습관 편향 주입 [-1,1] — 양수=오른쪽(월드+X)으로 잘 피함. 보스가 예측 조준에 반영.
        const dd = this.telemetry.debugDodge()
        this.boss.habitBias = (dd.right - dd.left) / 100
        this.boss.update(combatDt, this.player, this.projectiles)
        this.hud.setBossHp(this.boss.hpPct)
        if (this.boss.dead) this.onBossDefeated()
        if (this.bossDeathTimer >= 0) this.updateBossDeath(dt)
      }
      // 대시 잔상
      if (this.player.isDashing) this.effects.dashGhost(this.player.pos)
    }

    this.projectiles.update(combatDt)
    this.resolveProjectileHits()

    // 콤보 감쇠
    if (this.comboTimer > 0) {
      this.comboTimer -= dt
      if (this.comboTimer <= 0) {
        this.combo = 0
        this.hud.setScore(this.score, 0)
      }
    }

    // 피격 연출·기록 (피해 출처 불문 일원화)
    if (this.player.hp < hpAtFrameStart) {
      const taken = hpAtFrameStart - this.player.hp
      this.telemetry.recordDamageTaken(taken)
      this.rl?.addReward(-0.1 * taken)
      sfx.playerHurt()
      this.effects.shake(0.55)
      // 데미지 숫자에 출처 표기 + 화면 붉은 플래시 → "뭐에 맞았는지" 즉시 인지
      this.effects.damageNumber(this.player.pos, `-${Math.round(taken)} ${this.player.lastHitSource}`, 'player')
      const hf = document.getElementById('hit-flash')
      if (hf) {
        hf.classList.remove('on')
        void hf.offsetWidth
        hf.classList.add('on')
      }
    }

    // RL 로깅 — 이번 틱 (관측·행동·보상). 전투 중에만 (?rl 모드)
    if (this.rl && this.state === 'playing') {
      this.rl.tick(combatDt, this.player, this.enemies, this.boss?.dead ? null : (this.boss?.pos ?? null), this.wave, {
        move: this.player.moveDir,
        dash: this.player.isDashing,
        fire: this.tickFire,
        melee: this.tickMelee,
        aim: this.player.facing,
      })
    }
    this.tickFire = false
    this.tickMelee = false

    this.effects.update(combatDt)
    this.hud.setHp((this.player.hp / PLAYER.hp) * 100)
    this.world.followCamera(this.player.pos, dt)
    this.effects.applyShake(this.world.camera, dt)
    if (!this.noRender) this.world.render()
    this.input.endFrame()

    if (this.player.hp <= 0) this.endRun(false)
  }

  private updateSpawnTelegraph(dt: number): void {
    if (!this.pendingSpawn) return
    this.pendingSpawn.timer -= dt
    const blink = Math.sin(performance.now() * 0.02) * 0.35 + 0.55
    for (const m of this.pendingSpawn.markers) {
      ;(m.material as THREE.MeshBasicMaterial).opacity = blink
      m.rotation.z += dt * 3
    }
    if (this.pendingSpawn.timer <= 0) {
      const { plan, aggression, hpMul } = this.pendingSpawn
      this.clearPendingSpawn()
      this.enemies = spawnEnemies(plan, aggression, this.world.scene, hpMul)
      this.waveEnemyCount = this.enemies.length
      for (const e of this.enemies) this.effects.burst(e.pos, e.color, 4, 4)
      sfx.waveStart()
    }
  }

  private updateCombat(dt: number): void {
    // 자동 사격(모바일·쉬운·녹화): 최근접 표적으로 조준 후 발사. 수동 모드는 마우스 조준.
    if (IS_TOUCH || AUTO_AIM || this.easy) {
      let targetPos = this.findNearestEnemy()?.pos ?? null
      if (this.boss && !this.boss.dead) {
        if (!targetPos || this.boss.pos.distanceToSquared(this.player.pos) < targetPos.distanceToSquared(this.player.pos))
          targetPos = this.boss.pos
      }
      if (targetPos) {
        _toEnemy.copy(targetPos).sub(this.player.pos).setY(0)
        this.player.autoFire(_toEnemy.normalize())
      }
    }

    // 근접 자동 발동(모든 모드): 밀착한 적/보스가 있으면 전방위 근접
    if (this.enemyInMeleeRange() && this.player.requestMelee()) {
      this.tickMelee = true
      this.telemetry.recordMelee()
      sfx.meleeSwing()
      this.effects.meleeArc(this.player.pos, this.player.facing, PLAYER.melee.range, PLAYER.melee.arcDeg)
    }

    const attacks = this.player.consumeAttacks()
    if (attacks.melee) this.meleeSweep()
    if (attacks.ranged) {
      this.tickFire = true
      this.telemetry.recordRanged()
      sfx.shoot()
      this.effects.muzzleFlash(this.player.pos, this.player.facing) // 총구 섬광 — 사격 손맛
      // multishot: 조준 방향 중심으로 각도 분산 발사
      const n = this.player.stats.multishot
      const spread = 0.14
      for (let i = 0; i < n; i++) {
        const a = (i - (n - 1) / 2) * spread
        _toEnemy.copy(this.player.facing).applyAxisAngle(_up, a)
        this.projectiles.spawn(this.player.pos, _toEnemy, PLAYER.ranged.speed, this.player.stats.rangedDamage, true)
      }
      // 반사 회피: 조준선(~25°) 안·근거리의 적에게 회피 기회 (provokeDodge 내부에서 일부만 실제로 피함)
      for (const e of this.enemies) {
        if (e.dead) continue
        _toEnemy.copy(e.pos).sub(this.player.pos)
        _toEnemy.y = 0
        const d = _toEnemy.length()
        if (d < 0.5 || d > 16) continue
        _toEnemy.multiplyScalar(1 / d)
        if (_toEnemy.dot(this.player.facing) > 0.9) e.provokeDodge(this.player.facing)
      }
    }

    this.coordinateEnemies() // 무리 전술: 포위 슬롯 배정 (도주로 차단)
    for (const e of this.enemies) e.update(dt, this.player, this.projectiles)
    this.separateEnemies() // 겹침 해소: 한 점에 뭉치지 않게 (공격/돌진 중인 적은 라인 유지)

    // 사망 처리 (분열·자폭은 여기서 발동)
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]
      if (e.dead) {
        this.onEnemyKilled(e)
        this.world.scene.remove(e.root)
        this.enemies.splice(i, 1)
      }
    }

    // 설계 프리페치 — LLM 응답(~16s)이 인터미션/보스인트로에 늦지 않도록 전투 중 미리 요청.
    // 이 웨이브가 60% 정리됐을 때(대부분의 회피·사격 습관 확보) 발사 → 남은 시간이 LLM 지연을 흡수.
    if (
      !this.boss && this.prefetchedWave !== this.wave &&
      !this.pendingSpawn && this.waveEnemyCount > 0 &&
      this.enemies.length <= Math.max(2, Math.ceil(this.waveEnemyCount * 0.4))
    ) {
      this.prefetchedWave = this.wave
      const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
      if (this.wave < TOTAL_WAVES) {
        this.requestDesign(digest) // 다음 웨이브 설계
      } else {
        // 최종 웨이브 → 보스 판결문(누적 프로파일의 총결산, 최고의 LLM 순간) 프리페치
        requestBossDesign(digest).then((d) => (this.bossDesign = d))
      }
    }

    if (this.enemies.length === 0 && !this.pendingSpawn && !this.boss) {
      this.score += Math.round(SCORE.waveClear * this.scoreMul)
      this.rl?.addReward(5)
      this.hud.setScore(this.score, this.combo)
      this.effects.hitstop(0.28) // 클리어 슬로모
      if (this.wave >= TOTAL_WAVES) this.startBossIntro()
      else this.startIntermission()
    }
  }

  private onEnemyKilled(e: Enemy): void {
    this.telemetry.recordKill(e.type)
    this.rl?.addReward(1)
    sfx.enemyDie()
    // 처치 팝 — 무게를 타입별로: 브루트(탱크)는 묵직하게, 잔몹은 경쾌하게
    const heavy = e.type === 'brute'
    this.effects.burst(e.pos, e.color, heavy ? 24 : 16, heavy ? 10 : 8)
    this.effects.shake(heavy ? 0.5 : 0.28)
    this.effects.hitstop(heavy ? 0.08 : 0.038) // 처치 순간 미세 정지 = "팝"
    this.world.ripple(e.pos) // 처치 파동

    // split_on_death: 소형 드론 2기로 분열
    if (e.has('split_on_death')) {
      for (let i = 0; i < 2; i++) {
        const offset = new THREE.Vector3(Math.cos(i * Math.PI) * 1.2, 0, Math.sin(i * Math.PI) * 1.2)
        const mini = new Enemy('drone', e.pos.clone().add(offset), this.world.scene, [], {
          scaleMul: 0.55,
          hpMul: 0.35,
        })
        mini.aggression = e.aggression
        this.enemies.push(mini)
      }
    }
    // explode_on_death: 자폭 — 근접 처치를 처벌
    if (e.has('explode_on_death')) {
      this.effects.burst(e.pos, 0xf97316, 22, 11)
      this.effects.shake(0.5)
      if (e.pos.distanceTo(this.player.pos) < 4.2) this.player.takeDamage(24, "자폭")
    }
    this.combo++
    this.comboTimer = 3
    const gained = SCORE[e.type] * this.combo
    this.score += Math.round(gained * this.scoreMul)
    this.effects.damageNumber(e.pos, `+${gained}`, 'score')
    this.hud.setScore(this.score, this.combo)
  }

  private findNearestEnemy(): Enemy | null {
    let best: Enemy | null = null
    let bestDist = Infinity
    for (const e of this.enemies) {
      if (e.dead) continue
      const d = e.pos.distanceToSquared(this.player.pos)
      if (d < bestDist) {
        bestDist = d
        best = e
      }
    }
    return best
  }

  /** 밀착한 적/보스가 근접 사거리 안에 있는지 — 자동 근접 발동 트리거 */
  private enemyInMeleeRange(): boolean {
    for (const e of this.enemies) {
      if (!e.dead && e.pos.distanceTo(this.player.pos) <= PLAYER.melee.range + e.radius) return true
    }
    if (this.boss && !this.boss.dead && this.boss.pos.distanceTo(this.player.pos) <= PLAYER.melee.range + BOSS.radius)
      return true
    return false
  }

  /** 근접 공격: 전방위 범위 판정(자동이라 조준 없음) + 넉백 + 히트스톱 */
  /**
   * 무리 전술 조율 — 살아있는 근접 추격 적들을 플레이어 둘레의 각도 슬롯에 균등 배정.
   * 각자 따로 몰려드는 대신 사방을 에워싸고, 첫 슬롯을 플레이어 도주 방향에 두어
   * 길목을 막는다 → 거리유지+몰이사냥·카이팅 무력화. (결정론, ML 아님)
   */
  private coordinateEnemies(): void {
    const px = this.player.pos.x
    const pz = this.player.pos.z
    // 추격(포위 대상) 적만 — 원거리(spitter)나 죽은 적은 슬롯에서 제외
    const ring: Enemy[] = []
    for (const e of this.enemies) {
      if (!e.dead && e.type !== 'spitter') ring.push(e)
    }
    const n = ring.length
    if (n === 0) return
    // 도주 방향(플레이어 이동각). 정지 시 0.
    const md = this.player.moveDir
    const escape = md.x * md.x + md.z * md.z > 0.04 ? Math.atan2(md.z, md.x) : 0
    // 현재 각도로 정렬 → 슬롯 배정 안정화(덜 튐)·서로 안 교차
    ring.sort(
      (a, b) =>
        Math.atan2(a.pos.z - pz, a.pos.x - px) - Math.atan2(b.pos.z - pz, b.pos.x - px),
    )
    const step = (Math.PI * 2) / n
    for (let i = 0; i < n; i++) {
      // 균등 포위 + 첫 슬롯을 도주 방향에 두어 길목 차단
      ring[i].targetAngle = escape + i * step
      ring[i].attackPermit = false
    }
    // 분대 공격 스태거: 지금 공격 준비된 근접 적 중 가장 가까운 K기에만 허가 → 한 번에 몇 기만 덤빔.
    // 하나가 돌진/쿨다운에 들어가면 다음이 허가받아 '순번 압박'이 됨.
    const ready = ring
      .filter((e) => e.readyToAttack(this.player.pos))
      .sort((a, b) => a.pos.distanceToSquared(this.player.pos) - b.pos.distanceToSquared(this.player.pos))
    const permits = Math.max(1, Math.min(3, Math.ceil(n / 4)))
    for (let i = 0; i < Math.min(permits, ready.length); i++) ready[i].attackPermit = true
  }

  /** 겹침 해소 — 반경 합보다 가까운 적 쌍을 서로 밀어냄(각자 침투량 절반).
   *  공격/돌진 중(isAttacking) 적은 밀지 않아 예고한 공격 라인이 유지됨. */
  private separateEnemies(): void {
    const list = this.enemies
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      if (a.dead) continue
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (b.dead) continue
        const dx = b.pos.x - a.pos.x
        const dz = b.pos.z - a.pos.z
        const min = (a.radius + b.radius) * 0.9
        const d2 = dx * dx + dz * dz
        if (d2 >= min * min || d2 < 1e-6) continue
        const d = Math.sqrt(d2)
        const push = (min - d) * 0.5
        const nx = dx / d
        const nz = dz / d
        if (!a.isAttacking) { a.pos.x -= nx * push; a.pos.z -= nz * push }
        if (!b.isAttacking) { b.pos.x += nx * push; b.pos.z += nz * push }
      }
    }
  }

  private meleeSweep(): void {
    let hitAny = false
    for (const e of this.enemies) {
      if (e.dead) continue
      _toEnemy.copy(e.pos).sub(this.player.pos)
      _toEnemy.y = 0
      const dist = _toEnemy.length()
      if (dist > PLAYER.melee.range + e.radius) continue
      _toEnemy.normalize()
      const applied = e.takeDamage(this.player.stats.meleeDamage, _toEnemy, e.type === 'brute' ? 4 : 11, this.player.pos)
      if (!applied) {
        this.effects.damageNumber(e.pos, '차단', 'blocked')
        sfx.enemyHit()
        continue
      }
      this.effects.burst(e.pos, 0xd9f99d, 5, 5)
      this.effects.damageNumber(e.pos, String(this.player.stats.meleeDamage))
      hitAny = true
      // thorns: 근접 반격 가시 — 근접 의존을 처벌
      if (e.has('thorns') && !this.player.isDashing) {
        this.player.takeDamage(9, "가시 반격")
        this.effects.damageNumber(this.player.pos, '가시 -4', 'player')
      }
    }
    if (this.boss && !this.boss.dead && this.boss.pos.distanceTo(this.player.pos) <= PLAYER.melee.range + BOSS.radius) {
      if (this.boss.takeDamage(this.player.stats.meleeDamage)) {
        this.effects.burst(this.boss.pos, 0xffb86b, 6, 6)
        this.effects.damageNumber(this.boss.pos, String(this.player.stats.meleeDamage))
        hitAny = true
      } else {
        this.effects.damageNumber(this.boss.pos, '무적', 'blocked')
      }
    }
    if (hitAny) {
      sfx.meleeHit()
      this.effects.hitstop(0.055)
      this.effects.shake(0.18)
    }
  }

  private resolveProjectileHits(): void {
    for (const p of this.projectiles.list) {
      if (p.dead) continue
      if (p.fromPlayer) {
        // 보스 명중 판정
        if (this.boss && !this.boss.dead) {
          const hitDist = p.radius + BOSS.radius
          if (p.pos.distanceToSquared(this.boss.pos) < hitDist * hitDist) {
            if (this.boss.takeDamage(p.damage)) {
              sfx.enemyHit()
              this.effects.burst(this.boss.pos, 0xffb86b, 5, 6)
              this.effects.damageNumber(this.boss.pos, String(p.damage))
            } else {
              this.effects.damageNumber(this.boss.pos, '무적', 'blocked')
            }
            p.dead = true
            continue
          }
        }
        for (const e of this.enemies) {
          if (e.dead) continue
          const hitDist = p.radius + e.radius
          if (p.pos.distanceToSquared(e.pos) < hitDist * hitDist) {
            _toEnemy.copy(p.vel).setY(0).normalize()
            // 투사체의 발사 방향 반대편이 공격 출처
            const from = p.pos.clone().addScaledVector(p.vel, -0.3)
            const applied = e.takeDamage(p.damage, _toEnemy, 3, from)
            if (applied) {
              sfx.enemyHit()
              this.effects.burst(e.pos, 0xa5f3fc, 6, 8) // 명중 스파크 — 크런치
              this.effects.damageNumber(e.pos, String(p.damage))
            } else {
              this.effects.damageNumber(e.pos, '차단', 'blocked')
            }
            p.dead = true
            break
          }
        }
      } else {
        const hitDist = p.radius + PLAYER.radius
        if (p.pos.distanceToSquared(this.player.pos) < hitDist * hitDist) {
          this.player.takeDamage(p.damage, "스피터 탄")
          p.dead = true
        }
      }
    }
  }

  private endRun(victory: boolean): void {
    this.state = victory ? 'victory' : 'gameover'
    memory.endRun(victory, this.wave)
    // RL 에피소드 종료 — 보상 마감 후 업로드 (개발자가 /rl로 조회, 학습 데이터셋)
    if (this.rl) {
      this.rl.addReward(victory ? 20 : -10)
      void uploadRL(this.rl.finish(victory ? 'victory' : 'died', this.wave, this.score))
      this.rl = null
    }
    if (victory) sfx.victory()
    else sfx.defeat()
    const best = Math.max(this.score, Number(localStorage.getItem('overmind-best') ?? 0))
    localStorage.setItem('overmind-best', String(best))
    // 보스전 도달 시엔 LLM이 설계한 승패 대사를 사용
    const line = victory
      ? this.bossDesign
        ? `"${this.bossDesign.loseLine}"`
        : '너는 예측을 벗어났다.'
      : this.bossDesign
        ? `"${this.bossDesign.winLine}"`
        : '"예측대로였다." — 오버마인드는 너의 패턴을 학습했다.'
    // 피해 내역 — "왜 깍였는지" 한눈에 (가장 많이 당한 순)
    const dmg = Object.entries(this.player.damageBySource)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([src, n]) => `${src} ${Math.round(n)}`)
      .join(' · ')
    const dmgLine = dmg ? `\n\n피해: ${dmg}` : ''
    // 판 종료 시 요약 자동 전송 — 진단 버튼이 승리/게임오버 화면에 가려도 개발자가 실플레이 분석 가능
    void uploadDiag({
      img: '',
      info: {
        runSummary: {
          outcome: victory ? 'victory' : 'died',
          wave: this.wave,
          score: this.score,
          hpLeft: Math.round(this.player.hp),
          mode: this.easy ? 'easy' : IS_TOUCH ? 'mobile' : 'desktop',
          damage: this.player.damageBySource,
          build: __BUILD__,
          at: Date.now(),
        },
      },
    })
    this.hud.showScreen(
      victory ? 'OVERMIND 정지' : 'OVERMIND 승리',
      `${line}\n\n점수 ${this.score.toLocaleString()} · 최고 기록 ${best.toLocaleString()}${dmgLine}`,
      'RETRY',
      () => this.startRun(),
    )
    void this.submitAndShowBoard()
  }

  /** 리더보드 제출·표시 — 저장된 이름이 있으면 자동 제출, 없으면 등록 버튼으로 */
  private async submitAndShowBoard(): Promise<void> {
    const name = localStorage.getItem('overmind-name') ?? ''
    if (name && !this.scoreSubmitted) {
      this.scoreSubmitted = true
      await submitScore(name, this.score, this.wave, GAME_VERSION + (this.easy ? "-easy" : ""))
    }
    const board = await fetchLeaderboard(GAME_VERSION + (this.easy ? "-easy" : ""))
    this.hud.showLeaderboard(board, this.score, name, async (newName) => {
      localStorage.setItem('overmind-name', newName)
      if (!this.scoreSubmitted) {
        this.scoreSubmitted = true
        await submitScore(newName, this.score, this.wave, GAME_VERSION + (this.easy ? "-easy" : ""))
      }
      const updated = await fetchLeaderboard(GAME_VERSION + (this.easy ? "-easy" : ""))
      this.hud.showLeaderboard(updated, this.score, newName, () => {})
    })
  }
}
