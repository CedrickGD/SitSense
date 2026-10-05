import type { IssueId, PostureAlert, Stage } from '@shared/posture'
import {
  AWAY_FULL_RESET_S,
  BAND_HOLD_MAX_S,
  DATA_LOSS_RESET_S,
  DT_CAP_S,
  ESC_DWELL_S,
  ESC_MIN_GAP_S,
  REC_DWELL_S
} from './constants'

export interface EpisodeInput {
  /** severity vs trigger thresholds, restricted to the enabled stages */
  sevTrigger: Stage
  /** severity vs recovery (hysteresis) thresholds */
  sevRecovery: Stage
  /** metric computable this frame, presence ACTIVE, and gates passed */
  dataAvailable: boolean
}

export interface EpisodeConfig {
  dwellS: number
  cooldownS: number
  escalation: boolean
}

export type EpisodePhase = 'idle' | 'pending' | 'alerted' | 'recovering' | 'cooldown'

/**
 * Per-issue episode state machine (docs/specs/detection.md §7).
 * All timing is wall-clock deltas between step() calls; time only accumulates
 * while data is available, so visibility gaps freeze rather than corrupt state.
 * The cooldown is a timestamp, not accumulated time — it keeps running through
 * data loss, exactly as the spec requires.
 *
 * - A gap of more than AWAY_FULL_RESET_S between two step() calls (pause, system sleep,
 *   camera restart: no frames arrive, so presence never goes AWAY) counts as a long
 *   absence: full reset, cooldown included.
 * - A data-loss reset of an episode that already alerted arms the cooldown, as a
 *   recovery does.
 * - With escalation on, a new episode during the cooldown whose stage is worse than the
 *   one that armed it (quietStage) alerts as an 'escalation' once it has met the normal
 *   dwell, held the worse stage for ESC_DWELL and is ESC_MIN_GAP past the last alert.
 */
export class EpisodeMachine {
  private readonly issue: IssueId
  private cfg: EpisodeConfig

  private phaseInternal: Exclude<EpisodePhase, 'cooldown'> = 'idle'
  private lastT: number | null = null
  private dwellAccumMs = 0
  private bandHoldMs = 0
  private dataLossMs = 0
  private episodeStartMs: number | null = null
  private alertedStage: Stage = 0
  private lastAlertT: number | null = null
  private escAccumMs = 0
  private recAccumMs = 0
  private cooldownUntil: number | null = null
  /** highest stage alerted by the episode(s) that armed the running cooldown */
  private quietStage: Stage = 0

  constructor(issue: IssueId, cfg: EpisodeConfig) {
    this.issue = issue
    this.cfg = cfg
  }

  get phase(): EpisodePhase {
    if (this.phaseInternal === 'idle' && this.cooldownUntil !== null) return 'cooldown'
    return this.phaseInternal
  }

  episodeActiveForMs(tMs: number): number | null {
    return this.episodeStartMs === null ? null : tMs - this.episodeStartMs
  }

  updateConfig(cfg: EpisodeConfig): void {
    this.cfg = cfg
  }

  /** Hard reset (issue disabled, calibration, or a long away break). */
  reset(clearCooldown: boolean): void {
    this.toIdle()
    this.lastT = null
    if (clearCooldown) {
      this.cooldownUntil = null
      this.quietStage = 0
      this.lastAlertT = null
    }
  }

  step(input: EpisodeInput, tMs: number): PostureAlert[] {
    // no step for this long (pause, sleep, camera restart): the same as a long AWAY break
    if (this.lastT !== null && tMs - this.lastT > AWAY_FULL_RESET_S * 1000) this.reset(true)
    // capped Δt: a stall, sleep gap, or away-freeze seam contributes at most
    // DT_CAP to any accumulator (timestamps like cooldownUntil are unaffected)
    const dtMs = this.lastT === null ? 0 : Math.min(Math.max(0, tMs - this.lastT), DT_CAP_S * 1000)
    this.lastT = tMs
    const alerts: PostureAlert[] = []

    if (this.cooldownUntil !== null && tMs >= this.cooldownUntil) {
      this.cooldownUntil = null
      this.quietStage = 0
    }

    if (!input.dataAvailable) {
      // timers freeze; a long outage resets the episode silently
      if (this.phaseInternal !== 'idle') {
        this.dataLossMs += dtMs
        if (this.dataLossMs > DATA_LOSS_RESET_S * 1000) {
          // an episode that already alerted ends like a recovery: the quiet period starts
          if (this.phaseInternal === 'alerted' || this.phaseInternal === 'recovering') this.armCooldown(tMs)
          this.toIdle()
        }
      }
      return alerts
    }
    this.dataLossMs = 0

    const inCooldown = this.cooldownUntil !== null && tMs < this.cooldownUntil

    switch (this.phaseInternal) {
      case 'idle':
        if (input.sevTrigger >= 1) {
          this.phaseInternal = 'pending'
          this.episodeStartMs = tMs
          this.dwellAccumMs = 0
          this.bandHoldMs = 0
          this.escAccumMs = 0
        }
        break

      case 'pending': {
        if (input.sevTrigger >= 1) {
          this.dwellAccumMs += dtMs
          this.bandHoldMs = 0
        } else if (input.sevRecovery >= 1) {
          // hysteresis band: hold the accumulator, but not forever
          this.bandHoldMs += dtMs
          if (this.bandHoldMs > BAND_HOLD_MAX_S * 1000) {
            this.toIdle()
            break
          }
        } else {
          this.toIdle()
          break
        }
        const dwellMet = this.dwellAccumMs >= this.cfg.dwellS * 1000 && input.sevTrigger >= 1
        if (dwellMet && !inCooldown) {
          alerts.push(this.fire(input.sevTrigger, 'initial', tMs))
          this.phaseInternal = 'alerted'
          break
        }
        // quiet period: only a stage worse than the one that started it gets through
        if (inCooldown && this.cfg.escalation && input.sevTrigger > this.quietStage) {
          this.escAccumMs += dtMs
          if (dwellMet && this.escAccumMs >= ESC_DWELL_S * 1000 && this.escGapOk(tMs)) {
            alerts.push(this.fire(input.sevTrigger, 'escalation', tMs))
            this.phaseInternal = 'alerted'
          }
        } else {
          this.escAccumMs = 0
        }
        break
      }

      case 'alerted': {
        if (input.sevRecovery === 0) {
          this.phaseInternal = 'recovering'
          this.recAccumMs = 0
          this.escAccumMs = 0
          break
        }
        if (input.sevTrigger > this.alertedStage) {
          this.escAccumMs += dtMs
          if (this.cfg.escalation && this.escAccumMs >= ESC_DWELL_S * 1000 && this.escGapOk(tMs)) {
            alerts.push(this.fire(input.sevTrigger, 'escalation', tMs))
          }
        } else {
          this.escAccumMs = 0
        }
        break
      }

      case 'recovering': {
        if (input.sevTrigger >= 1) {
          // relapse — same episode, no new alert
          this.phaseInternal = 'alerted'
          break
        }
        if (input.sevRecovery >= 1) {
          this.recAccumMs = 0
          break
        }
        this.recAccumMs += dtMs
        if (this.recAccumMs >= REC_DWELL_S * 1000) {
          this.armCooldown(tMs)
          this.toIdle()
        }
        break
      }
    }

    return alerts
  }

  /** Start (or extend) the quiet period after an alerted episode ends. */
  private armCooldown(tMs: number): void {
    const until = tMs + this.cfg.cooldownS * 1000
    this.cooldownUntil = this.cooldownUntil === null ? until : Math.max(this.cooldownUntil, until)
    this.quietStage = Math.max(this.quietStage, this.alertedStage) as Stage
  }

  /** escalations are rate-limited against the previous alert of any kind */
  private escGapOk(tMs: number): boolean {
    return this.lastAlertT !== null && tMs - this.lastAlertT >= ESC_MIN_GAP_S * 1000
  }

  private fire(stage: Stage, kind: PostureAlert['kind'], tMs: number): PostureAlert {
    this.alertedStage = stage
    this.lastAlertT = tMs
    this.escAccumMs = 0
    return {
      issue: this.issue,
      stage,
      kind,
      durationMs: this.episodeStartMs !== null ? tMs - this.episodeStartMs : 0
    }
  }

  private toIdle(): void {
    this.phaseInternal = 'idle'
    this.dwellAccumMs = 0
    this.bandHoldMs = 0
    this.recAccumMs = 0
    this.escAccumMs = 0
    this.dataLossMs = 0
    this.episodeStartMs = null
    this.alertedStage = 0
  }
}
