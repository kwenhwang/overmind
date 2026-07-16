import * as THREE from 'three'
import {
  PLAYER, TOTAL_WAVES, WAVE_INTERMISSION_SEC, SPAWN_TELEGRAPH_SEC, ENEMY_TYPES, SCORE, BOSS,
} from './config'
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
import { requestWaveDesign, requestBossDesign, fallbackDesign, memory } from '../ai/director'
import type { BossDesign, BossPhase, WaveDesign } from '../ai/schema'
import { Hud } from '../ui/hud'

type State = 'title' | 'playing' | 'intermission' | 'bossIntro' | 'gameover' | 'victory'

const _toEnemy = new THREE.Vector3()

/** 녹화 연기용 — 데스크톱에서도 모바일식 자동 조준·공격 */
const AUTO_AIM = new URLSearchParams(location.search).has('autoaim')

interface PendingSpawn {
  plan: SpawnPlan[]
  aggression: number
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
  private wave = 0
  private intermissionTimer = 0
  private pendingDesign: WaveDesign | null = null
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
  private fpsProbe = { frames: 0, start: 0, done: false }

  constructor(canvas: HTMLCanvasElement) {
    this.world = new World(canvas)
    this.input = new Input(this.world.camera)
    this.projectiles = new ProjectilePool(this.world.scene)
    this.effects = new Effects(this.world.scene, this.world.camera)

    events.on('lungeWarn', () => sfx.lungeWarn())
    events.on('spitterShot', () => sfx.shoot())

    // 헤드리스 검증용 상태 훅 (콘솔 출력 없음)
    ;(window as unknown as Record<string, unknown>).__dbg = () => ({
      state: this.state, wave: this.wave, timer: this.intermissionTimer.toFixed(2),
      hp: this.player?.hp, enemies: this.enemies.length, score: this.score,
      boss: this.boss ? { hp: Math.round(this.boss.hp), phase: this.boss.phaseIndex } : null,
    })
    // 검증·촬영용: 보스 즉사 (페이즈 강제 진행 포함 — 반복 호출)
    ;(window as unknown as Record<string, unknown>).__killBoss = () => this.boss?.takeDamage(99999)
    // ?autostart — 헤드리스 검증·영상 촬영용 즉시 시작
    if (new URLSearchParams(location.search).has('autostart')) {
      this.startRun()
    } else {
      this.hud.showScreen(
        'OVERMIND',
        IS_TOUCH
          ? '적 웨이브 5개를 버텨라.\n적의 두뇌(AI)가 네 플레이 습관을 관찰하고, 다음 웨이브를 너를 잡도록 재설계한다.\n\n왼쪽 화면 드래그 = 이동 · 오른쪽 탭 = 대시(무적)\n공격은 자동 — 회피에 집중하라'
          : '적 웨이브 5개를 버텨라.\n적의 두뇌(AI)가 네 플레이 습관을 관찰하고, 다음 웨이브를 너를 잡도록 재설계한다.\n같은 패턴을 반복하면 반드시 처벌당한다.\n\nWASD 이동 · Space 대시(무적) · 좌클릭 근접 · 우클릭 원거리',
        'START',
        () => this.startRun(),
      )
    }
  }

  private startRun(): void {
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
    this.hud.hideBossBar()
    this.world.setCoreVisible(true)
    if (this.player) this.world.scene.remove(this.player.mesh)

    this.player = new Player(this.world.scene)
    this.player.onDash = (dir, facing) => {
      this.telemetry.recordDash(dir, facing)
      sfx.dash()
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
    this.pendingDesign = null
    this.clearHazards()
    this.hud.showIntermission('OVERMIND 재구성 중…')

    const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
    this.hud.showReport(digest, memory.profile()) // 오버마인드가 "본 것"과 "기억"을 노출
    requestWaveDesign(digest).then((design) => {
      this.pendingDesign = design
      this.hud.showCounter(design.counterReason)
    })
  }

  private startWave(): void {
    const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
    const design = this.pendingDesign ?? fallbackDesign(digest)
    this.wave++
    this.state = 'playing'
    this.hud.hideIntermission()
    this.hud.hideReport()
    this.hud.setWave(this.wave, TOTAL_WAVES)
    this.hud.showTaunt(design.taunt)
    sfx.taunt()
    this.telemetry.resetWaveStats()
    this.telemetry.startWave()
    this.world.setMood(design.mood)

    // 해저드 — 텔레그래프 시점부터 보여서 배치 의도가 읽히게
    this.clearHazards()
    for (const h of (design.hazards ?? []).slice(0, 2)) {
      const pos = resolveHazardPos(h.placement, this.player.pos, this.player.facing)
      this.hazardZones.push(new Hazard(h, pos, this.world.scene))
    }

    // 스폰은 경고 링 텔레그래프 후 — "의도된 배치"로 읽히게
    const plan = planWaveSpawns(design, this.player.pos, this.player.facing)
    this.pendingSpawn = {
      plan,
      aggression: design.aggression,
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
    for (const h of this.hazardZones) this.world.scene.remove(h.mesh)
    this.hazardZones = []
  }

  /** 웨이브 5 클리어 → 최종 프로토콜: LLM이 누적 프로파일로 보스전을 설계 */
  private startBossIntro(): void {
    this.state = 'bossIntro'
    this.bossIntroElapsed = 0
    this.verdictTimer = -1
    this.clearHazards()
    this.hud.showIntermission('최종 프로토콜 기동…')
    const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
    requestBossDesign(digest).then((design) => {
      this.bossDesign = design
    })
  }

  private updateBossIntro(dt: number): void {
    this.bossIntroElapsed += dt
    // 설계 도착 + 최소 연출 2초 후: 판결문 낭독
    if (this.bossDesign && this.verdictTimer < 0 && this.bossIntroElapsed >= 2) {
      this.hud.hideIntermission()
      this.hud.showTaunt(this.bossDesign.verdict, 10)
      sfx.taunt()
      this.verdictTimer = 6
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
    this.hud.showTaunt(phase.taunt)
    sfx.taunt()
    this.effects.shake(0.35)
    this.clearHazards()
    for (const h of (phase.hazards ?? []).slice(0, 2)) {
      const pos = resolveHazardPos(h.placement, this.player.pos, this.player.facing)
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
      this.score += SCORE.boss
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
      this.world.render()
      return
    }

    // 히트스톱: 전투 시간만 느려지고 카메라·이펙트 감쇠는 실시간
    const combatDt = dt * this.effects.timeScale(dt)
    const hpAtFrameStart = this.player.hp

    // 해저드 효과 (가시 피해·감속) — 이동 계산 전에 적용
    let speedMul = 1
    if (this.state === 'playing') {
      for (const h of this.hazardZones) speedMul = Math.min(speedMul, h.update(combatDt, this.player))
    }
    this.player.speedMul = speedMul

    this.input.updateAim()
    this.player.update(combatDt, this.input)
    this.telemetry.tick(combatDt, this.player.pos)

    if (this.state === 'intermission') {
      this.intermissionTimer -= dt
      const elapsed = WAVE_INTERMISSION_SEC - this.intermissionTimer
      // LLM 설계가 도착했으면 최소 연출 시간(2.5초) 후 시작.
      // 미도착이면 유예(-4초)까지 기다렸다가 폴백으로 시작 — "재구성 중" 연출이 지연을 흡수.
      if ((this.pendingDesign && elapsed >= 2.5) || this.intermissionTimer <= -4) {
        this.startWave()
      }
    } else if (this.state === 'bossIntro') {
      this.updateBossIntro(dt)
    } else {
      this.updateSpawnTelegraph(combatDt)
      this.updateCombat(combatDt)
      if (this.boss) {
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
      sfx.playerHurt()
      this.effects.shake(0.55)
      this.effects.damageNumber(this.player.pos, `-${Math.round(taken)}`, 'player')
    }

    this.effects.update(combatDt)
    this.hud.setHp((this.player.hp / PLAYER.hp) * 100)
    this.world.followCamera(this.player.pos, dt)
    this.effects.applyShake(this.world.camera, dt)
    this.world.render()
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
      const { plan, aggression } = this.pendingSpawn
      this.clearPendingSpawn()
      this.enemies = spawnEnemies(plan, aggression, this.world.scene)
      for (const e of this.enemies) this.effects.burst(e.pos, e.color, 4, 4)
      sfx.waveStart()
    }
  }

  private updateCombat(dt: number): void {
    // 모바일(또는 ?autoaim — 녹화용): 최근접 표적(적 또는 보스) 자동 조준·공격
    if (IS_TOUCH || AUTO_AIM) {
      const nearest = this.findNearestEnemy()
      let targetPos = nearest?.pos ?? null
      if (this.boss && !this.boss.dead) {
        const bossDist = this.boss.pos.distanceToSquared(this.player.pos)
        if (!targetPos || bossDist < targetPos.distanceToSquared(this.player.pos)) {
          targetPos = this.boss.pos
        }
      }
      if (targetPos) {
        _toEnemy.copy(targetPos).sub(this.player.pos)
        _toEnemy.y = 0
        const dist = _toEnemy.length()
        this.player.autoCombat(_toEnemy.normalize(), dist)
      }
    }

    const attacks = this.player.consumeAttacks()
    if (attacks.melee) {
      this.telemetry.recordMelee()
      sfx.meleeSwing()
      this.effects.meleeArc(this.player.pos, this.player.facing, PLAYER.melee.range, PLAYER.melee.arcDeg)
      this.meleeSweep()
    }
    if (attacks.ranged) {
      this.telemetry.recordRanged()
      sfx.shoot()
      this.projectiles.spawn(
        this.player.pos, this.player.facing, PLAYER.ranged.speed, PLAYER.ranged.damage, true,
      )
    }

    for (const e of this.enemies) e.update(dt, this.player, this.projectiles)

    // 사망 처리 (분열·자폭은 여기서 발동)
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]
      if (e.dead) {
        this.onEnemyKilled(e)
        this.world.scene.remove(e.root)
        this.enemies.splice(i, 1)
      }
    }

    if (this.enemies.length === 0 && !this.pendingSpawn && !this.boss) {
      this.score += SCORE.waveClear
      this.hud.setScore(this.score, this.combo)
      this.effects.hitstop(0.28) // 클리어 슬로모
      if (this.wave >= TOTAL_WAVES) this.startBossIntro()
      else this.startIntermission()
    }
  }

  private onEnemyKilled(e: Enemy): void {
    this.telemetry.recordKill(e.type)
    sfx.enemyDie()
    this.effects.burst(e.pos, e.color, 14, 8)
    this.effects.shake(0.25)

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
      if (e.pos.distanceTo(this.player.pos) < 3.4) this.player.takeDamage(15)
    }
    this.combo++
    this.comboTimer = 3
    const gained = SCORE[e.type] * this.combo
    this.score += gained
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

  /** 근접 공격: 전방 부채꼴 범위 판정 + 넉백 + 히트스톱 */
  private meleeSweep(): void {
    const cosHalfArc = Math.cos((PLAYER.melee.arcDeg / 2) * (Math.PI / 180))
    let hitAny = false
    for (const e of this.enemies) {
      _toEnemy.copy(e.pos).sub(this.player.pos)
      _toEnemy.y = 0
      const dist = _toEnemy.length()
      if (dist > PLAYER.melee.range + ENEMY_TYPES[e.type].radius) continue
      _toEnemy.normalize()
      if (_toEnemy.dot(this.player.facing) >= cosHalfArc) {
        const applied = e.takeDamage(
          PLAYER.melee.damage, _toEnemy, e.type === 'brute' ? 4 : 11, this.player.pos,
        )
        if (!applied) {
          this.effects.damageNumber(e.pos, '차단', 'blocked')
          sfx.enemyHit()
          continue
        }
        this.effects.burst(e.pos, 0xd9f99d, 5, 5)
        this.effects.damageNumber(e.pos, String(PLAYER.melee.damage))
        hitAny = true
        // thorns: 근접 반격 가시 — 근접 의존을 처벌
        if (e.has('thorns') && !this.player.isDashing) {
          this.player.takeDamage(4)
          this.effects.damageNumber(this.player.pos, '가시 -4', 'player')
        }
      }
    }
    // 보스도 근접 대상
    if (this.boss && !this.boss.dead) {
      _toEnemy.copy(this.boss.pos).sub(this.player.pos)
      _toEnemy.y = 0
      const dist = _toEnemy.length()
      if (dist <= PLAYER.melee.range + BOSS.radius) {
        _toEnemy.normalize()
        if (_toEnemy.dot(this.player.facing) >= cosHalfArc) {
          if (this.boss.takeDamage(PLAYER.melee.damage)) {
            this.effects.burst(this.boss.pos, 0xffb86b, 6, 6)
            this.effects.damageNumber(this.boss.pos, String(PLAYER.melee.damage))
            hitAny = true
          } else {
            this.effects.damageNumber(this.boss.pos, '무적', 'blocked')
          }
        }
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
              this.effects.burst(this.boss.pos, 0xffb86b, 3, 4)
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
              this.effects.burst(e.pos, 0xa5f3fc, 3, 4)
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
          this.player.takeDamage(p.damage)
          p.dead = true
        }
      }
    }
  }

  private endRun(victory: boolean): void {
    this.state = victory ? 'victory' : 'gameover'
    memory.endRun(victory, this.wave)
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
    this.hud.showScreen(
      victory ? 'OVERMIND 정지' : 'OVERMIND 승리',
      `${line}\n\n점수 ${this.score.toLocaleString()} · 최고 기록 ${best.toLocaleString()}`,
      'RETRY',
      () => this.startRun(),
    )
  }
}
