import type { IssueId, PostureAlert, Stage } from '@shared/posture'
import {
  BAND_HOLD_MAX_S,
  DATA_LOSS_RESET_S,
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
      this.lastAlertT = null
    }
  }

  step(input: EpisodeInput, tMs: number): PostureAlert[] {
    const dtMs = this.lastT === null ? 0 : Math.max(0, tMs - this.lastT)
    this.lastT = tMs
    const alerts: PostureAlert[] = []

    if (this.cooldownUntil !== null && tMs >= this.cooldownUntil) this.cooldownUntil = null

    if (!input.dataAvailable) {
      // timers freeze; a long outage resets the episode silently
      if (this.phaseInternal !== 'idle') {
        this.dataLossMs += dtMs
        if (this.dataLossMs > DATA_LOSS_RESET_S * 1000) this.toIdle()
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
        if (this.dwellAccumMs >= this.cfg.dwellS * 1000 && input.sevTrigger >= 1 && !inCooldown) {
          alerts.push(this.fire(input.sevTrigger, 'initial', tMs))
          this.phaseInternal = 'alerted'
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
          if (
            this.cfg.escalation &&
            this.escAccumMs >= ESC_DWELL_S * 1000 &&
            this.lastAlertT !== null &&
            tMs - this.lastAlertT >= ESC_MIN_GAP_S * 1000
          ) {
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
          this.cooldownUntil = tMs + this.cfg.cooldownS * 1000
          this.toIdle()
        }
        break
      }
    }

    return alerts
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
