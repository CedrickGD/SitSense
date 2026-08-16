import { DT_CAP_S, MEDIAN_WINDOW, OUTLIER_MAX_CONSEC, OUTLIER_SCALE_JUMP } from './constants'

/**
 * Median-of-3 prefilter + fps-adaptive EMA (docs/specs/detection.md §4).
 * The median kills single-frame spikes; the EMA smooths jitter with a time
 * constant independent of frame rate: α(Δt) = 1 − exp(−Δt/τ).
 */
export class MetricSmoother {
  private readonly tauS: number
  private buffer: number[] = []
  private ema: number | null = null

  constructor(tauS: number) {
    this.tauS = tauS
  }

  get value(): number | null {
    return this.ema
  }

  push(raw: number, dtS: number): number {
    this.buffer.push(raw)
    if (this.buffer.length > MEDIAN_WINDOW) this.buffer.shift()
    const med = median(this.buffer)
    if (this.ema === null) {
      this.ema = med
    } else {
      const dt = Math.min(dtS, DT_CAP_S)
      const alpha = 1 - Math.exp(-dt / this.tauS)
      this.ema += alpha * (med - this.ema)
    }
    return this.ema
  }

  /** Forget everything (used when returning from AWAY) — next push seeds fresh. */
  reseed(): void {
    this.buffer = []
    this.ema = null
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Per-frame outlier gate on the unified scale: a >35% single-frame jump is a
 * tracking glitch — discard the frame. A change that persists for 3 frames is
 * real (the user actually moved) and gets accepted.
 */
export class ScaleOutlierGate {
  private lastAccepted: number | null = null
  private consecutiveDiscards = 0

  check(rawScale: number): boolean {
    if (this.lastAccepted === null || this.consecutiveDiscards >= OUTLIER_MAX_CONSEC) {
      this.accept(rawScale)
      return true
    }
    if (Math.abs(rawScale / this.lastAccepted - 1) > OUTLIER_SCALE_JUMP) {
      this.consecutiveDiscards++
      return false
    }
    this.accept(rawScale)
    return true
  }

  reset(): void {
    this.lastAccepted = null
    this.consecutiveDiscards = 0
  }

  private accept(v: number): void {
    this.lastAccepted = v
    this.consecutiveDiscards = 0
  }
}
