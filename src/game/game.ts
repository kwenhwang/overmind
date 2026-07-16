import * as THREE from 'three'
import {
  PLAYER, TOTAL_WAVES, WAVE_INTERMISSION_SEC, SPAWN_TELEGRAPH_SEC, ENEMY_TYPES, SCORE,
} from './config'
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
import { requestWaveDesign, fallbackDesign } from '../ai/director'
import type { WaveDesign } from '../ai/schema'
import { Hud } from '../ui/hud'

type State = 'title' | 'playing' | 'intermission' | 'gameover' | 'victory'

const _toEnemy = new THREE.Vector3()

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
    })
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
    this.hud.showReport(digest) // 오버마인드가 "본 것"을 플레이어에게 노출
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
    } else {
      this.updateSpawnTelegraph(combatDt)
      this.updateCombat(combatDt)
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
    // 모바일: 최근접 적 자동 조준·공격 (이동과 회피에 집중하는 조작 체계)
    if (IS_TOUCH) {
      const nearest = this.findNearestEnemy()
      if (nearest) {
        _toEnemy.copy(nearest.pos).sub(this.player.pos)
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

    if (this.enemies.length === 0 && !this.pendingSpawn) {
      this.score += SCORE.waveClear
      this.hud.setScore(this.score, this.combo)
      if (this.wave >= TOTAL_WAVES) this.endRun(true)
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
    if (victory) sfx.victory()
    else sfx.defeat()
    const best = Math.max(this.score, Number(localStorage.getItem('overmind-best') ?? 0))
    localStorage.setItem('overmind-best', String(best))
    this.hud.showScreen(
      victory ? 'OVERMIND 정지' : 'OVERMIND 승리',
      (victory
        ? '너는 예측을 벗어났다.'
        : '"예측대로였다." — 오버마인드는 너의 패턴을 학습했다.') +
        `\n\n점수 ${this.score.toLocaleString()} · 최고 기록 ${best.toLocaleString()}`,
      'RETRY',
      () => this.startRun(),
    )
  }
}
