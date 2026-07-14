import * as THREE from 'three'
import { PLAYER, TOTAL_WAVES, WAVE_INTERMISSION_SEC, ENEMY_TYPES } from './config'
import { World } from './world'
import { Input } from './input'
import { Player } from './player'
import { Enemy } from './enemies'
import { ProjectilePool } from './projectiles'
import { executeWaveDesign } from './waves'
import { Telemetry } from '../ai/telemetry'
import { requestWaveDesign, fallbackDesign } from '../ai/director'
import type { WaveDesign } from '../ai/schema'
import { Hud } from '../ui/hud'

type State = 'title' | 'playing' | 'intermission' | 'gameover' | 'victory'

const _toEnemy = new THREE.Vector3()

export class Game {
  private world: World
  private input: Input
  private hud = new Hud()
  private player!: Player
  private enemies: Enemy[] = []
  private projectiles: ProjectilePool
  private telemetry = new Telemetry()
  private state: State = 'title'
  private wave = 0
  private intermissionTimer = 0
  private pendingDesign: WaveDesign | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.world = new World(canvas)
    this.input = new Input(this.world.camera)
    this.projectiles = new ProjectilePool(this.world.scene)
    // 헤드리스 검증용 상태 훅 (콘솔 출력 없음)
    ;(window as unknown as Record<string, unknown>).__dbg = () => ({
      state: this.state, wave: this.wave, timer: this.intermissionTimer.toFixed(2),
      hp: this.player?.hp, enemies: this.enemies.length,
    })
    // ?autostart — 헤드리스 검증·영상 촬영용 즉시 시작
    if (new URLSearchParams(location.search).has('autostart')) {
      this.startRun()
    } else {
      this.hud.showScreen(
        'OVERMIND',
        '적의 두뇌는 너를 관찰한다.\nWASD 이동 · Space 대시 · 좌클릭 근접 · 우클릭 원거리',
        'START',
        () => this.startRun(),
      )
    }
  }

  private startRun(): void {
    for (const e of this.enemies) this.world.scene.remove(e.mesh)
    this.enemies = []
    this.projectiles.clear()
    if (this.player) this.world.scene.remove(this.player.mesh)

    this.player = new Player(this.world.scene)
    this.player.onDash = (dir, facing) => this.telemetry.recordDash(dir, facing)
    this.telemetry = new Telemetry()
    this.wave = 0
    this.startIntermission()
  }

  /** 웨이브 사이 — 오버마인드가 다음 판을 설계하는 시간 (LLM 지연 흡수 구간) */
  private startIntermission(): void {
    this.state = 'intermission'
    this.intermissionTimer = WAVE_INTERMISSION_SEC
    this.pendingDesign = null
    this.hud.showIntermission('OVERMIND 재구성 중…')

    const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
    requestWaveDesign(digest).then((design) => {
      this.pendingDesign = design
    })
  }

  private startWave(): void {
    const digest = this.telemetry.digest(this.wave, (this.player.hp / PLAYER.hp) * 100)
    const design = this.pendingDesign ?? fallbackDesign(digest)
    this.wave++
    this.state = 'playing'
    this.hud.hideIntermission()
    this.hud.setWave(this.wave, TOTAL_WAVES)
    this.hud.showTaunt(design.taunt)
    this.telemetry.resetWaveStats()
    this.telemetry.startWave()
    this.enemies = executeWaveDesign(design, this.player.pos, this.player.facing, this.world.scene)
  }

  update(dt: number): void {
    if (this.state === 'title' || this.state === 'gameover' || this.state === 'victory') {
      this.world.render()
      return
    }

    this.input.updateAim()
    this.player.update(dt, this.input)
    this.telemetry.tick(dt, this.player.pos)

    if (this.state === 'intermission') {
      this.intermissionTimer -= dt
      // 디자인이 도착했고 최소 연출 시간이 지났으면 시작
      if (this.intermissionTimer <= 0 || (this.pendingDesign && this.intermissionTimer < WAVE_INTERMISSION_SEC - 2)) {
        this.startWave()
      }
    } else {
      this.updateCombat(dt)
    }

    this.projectiles.update(dt)
    this.resolveProjectileHits()

    this.hud.setHp((this.player.hp / PLAYER.hp) * 100)
    this.world.followCamera(this.player.pos, dt)
    this.world.render()
    this.input.endFrame()

    if (this.player.hp <= 0) this.endRun(false)
  }

  private updateCombat(dt: number): void {
    const attacks = this.player.consumeAttacks()
    if (attacks.melee) {
      this.telemetry.recordMelee()
      this.meleeSweep()
    }
    if (attacks.ranged) {
      this.telemetry.recordRanged()
      this.projectiles.spawn(
        this.player.pos, this.player.facing, PLAYER.ranged.speed, PLAYER.ranged.damage, true,
      )
    }

    const hpBefore = this.player.hp
    for (const e of this.enemies) e.update(dt, this.player, this.projectiles)
    if (this.player.hp < hpBefore) this.telemetry.recordDamageTaken(hpBefore - this.player.hp)

    // 사망 처리
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]
      if (e.dead) {
        this.telemetry.recordKill(e.type)
        this.world.scene.remove(e.mesh)
        this.enemies.splice(i, 1)
      }
    }

    if (this.enemies.length === 0) {
      if (this.wave >= TOTAL_WAVES) this.endRun(true)
      else this.startIntermission()
    }
  }

  /** 근접 공격: 전방 부채꼴 범위 판정 */
  private meleeSweep(): void {
    const cosHalfArc = Math.cos((PLAYER.melee.arcDeg / 2) * (Math.PI / 180))
    for (const e of this.enemies) {
      _toEnemy.copy(e.pos).sub(this.player.pos)
      _toEnemy.y = 0
      const dist = _toEnemy.length()
      if (dist > PLAYER.melee.range + ENEMY_TYPES[e.type].radius) continue
      _toEnemy.normalize()
      if (_toEnemy.dot(this.player.facing) >= cosHalfArc) e.takeDamage(PLAYER.melee.damage)
    }
  }

  private resolveProjectileHits(): void {
    for (const p of this.projectiles.list) {
      if (p.dead) continue
      if (p.fromPlayer) {
        for (const e of this.enemies) {
          if (e.dead) continue
          const hitDist = p.radius + ENEMY_TYPES[e.type].radius
          if (p.pos.distanceToSquared(e.pos) < hitDist * hitDist) {
            e.takeDamage(p.damage)
            p.dead = true
            break
          }
        }
      } else {
        const hitDist = p.radius + PLAYER.radius
        if (p.pos.distanceToSquared(this.player.pos) < hitDist * hitDist) {
          const hpBefore = this.player.hp
          this.player.takeDamage(p.damage)
          if (this.player.hp < hpBefore) this.telemetry.recordDamageTaken(hpBefore - this.player.hp)
          p.dead = true
        }
      }
    }
  }

  private endRun(victory: boolean): void {
    this.state = victory ? 'victory' : 'gameover'
    this.hud.showScreen(
      victory ? 'OVERMIND 정지' : 'OVERMIND 승리',
      victory
        ? '너는 예측을 벗어났다.'
        : '"예측대로였다." — 오버마인드는 너의 패턴을 학습했다.',
      'RETRY',
      () => this.startRun(),
    )
  }
}
