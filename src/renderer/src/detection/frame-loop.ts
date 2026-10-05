/**
 * Frame pacing with a hidden-window escape hatch (docs/specs/architecture.md §4).
 *
 * Primary: requestVideoFrameCallback with an FPS throttle. With
 * backgroundThrottling disabled it *should* keep firing while the window is
 * hidden in the tray, but that has regressed across Electron majors — so a
 * watchdog switches to a plain setInterval (timers are exempt from throttling)
 * whenever rVFC starves, and back when it recovers. document.visibilityState
 * is NOT a truthful signal here (it stays 'visible'); rVFC starvation is.
 *
 * Pacing is a deadline grid, not "now − last ≥ interval": vsync snapping and
 * timer jitter make the right tick arrive a little early, and a strict check
 * then skips it (10 fps came out at ~8.4, ~6.3 in the tray fallback). Ticks may
 * arrive a quarter interval early; after a stall the grid re-anchors instead of
 * bursting to catch up.
 *
 * Frozen frames: the fallback timer could re-run inference on the same decoded
 * frame forever when the camera stalls without ending its track. When the
 * element's decoded-frame counter is known to be live (it advanced recently),
 * a fallback tick without a new frame is skipped, and a counter that stops for
 * STALL_MS is reported through `onStall` (the controller decides what to do —
 * the counter may also stop simply because a hidden element isn't composited,
 * so it is a hint, not proof, and processing never stops on it).
 */

export interface FrameLoopOptions {
  /** the camera seems to have stopped delivering frames (called once per stall) */
  onStall?: () => void
}

/** a decoded-frame counter that advanced within this window counts as live */
const COUNTER_LIVE_MS = 2000
/** no new frame for this long (with a live counter before) = stall */
export const STALL_MS = 5000

export class FrameLoop {
  private video: HTMLVideoElement
  private onFrame: () => void | Promise<void>
  private onStall: (() => void) | undefined
  private intervalMs: number
  private running = false
  private busy = false

  private lastRvfcTick = 0
  private nextDue = 0
  private rvfcHandle: number | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private fallbackTimer: ReturnType<typeof setInterval> | null = null

  /** decoded-frame counter bookkeeping (frozen-frame / stall detection) */
  private lastCounter = -1
  private counterChangedAt = 0
  private counterEverChanged = false
  private processedCounter = -1
  private stallReported = false

  constructor(video: HTMLVideoElement, fps: number, onFrame: () => void | Promise<void>, opts: FrameLoopOptions = {}) {
    this.video = video
    this.onFrame = onFrame
    this.onStall = opts.onStall
    this.intervalMs = 1000 / fps
  }

  setFps(fps: number): void {
    this.intervalMs = 1000 / fps
    // a raised rate (setup) takes effect on the next frame
    this.nextDue = Math.min(this.nextDue, performance.now() + this.intervalMs)
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer)
      this.fallbackTimer = null // watchdog restarts it at the new cadence
    }
  }

  get fps(): number {
    return 1000 / this.intervalMs
  }

  get usingFallback(): boolean {
    return this.fallbackTimer !== null
  }

  start(): void {
    if (this.running) return
    this.running = true
    const now = performance.now()
    this.lastRvfcTick = now
    this.counterChangedAt = now
    this.nextDue = now
    this.scheduleRvfc()
    this.watchdog = setInterval(() => this.checkStarvation(), 1000)
  }

  stop(): void {
    this.running = false
    if (this.rvfcHandle !== null && 'cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle)
    }
    this.rvfcHandle = null
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.fallbackTimer) clearInterval(this.fallbackTimer)
    this.watchdog = null
    this.fallbackTimer = null
  }

  private scheduleRvfc(): void {
    if (!this.running) return
    this.rvfcHandle = this.video.requestVideoFrameCallback(() => {
      this.lastRvfcTick = performance.now()
      // rVFC only fires for a new presented frame: never a duplicate
      this.maybeProcess(true)
      this.scheduleRvfc()
    })
  }

  /** Total decoded frames of the element, or null when the browser doesn't expose it. */
  private frameCounter(): number | null {
    try {
      const q = this.video.getVideoPlaybackQuality?.()
      return q ? q.totalVideoFrames : null
    } catch {
      return null
    }
  }

  private sampleCounter(now: number): number | null {
    const c = this.frameCounter()
    if (c === null) return null
    if (c !== this.lastCounter) {
      if (this.lastCounter >= 0) this.counterEverChanged = true
      this.lastCounter = c
      this.counterChangedAt = now
      this.stallReported = false
    }
    return c
  }

  private checkStarvation(): void {
    if (!this.running) return
    const now = performance.now()
    this.sampleCounter(now)
    const starvedMs = now - this.lastRvfcTick
    const threshold = Math.max(3 * this.intervalMs, 1000)
    const streamLive = this.video.srcObject instanceof MediaStream && this.video.readyState >= 2
    if (starvedMs > threshold && streamLive) {
      if (!this.fallbackTimer) {
        this.fallbackTimer = setInterval(() => this.maybeProcess(false), this.intervalMs / 2)
      }
    } else if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer)
      this.fallbackTimer = null
    }
    // no rVFC tick and no new decoded frame for a while: the camera may have stalled
    if (
      this.onStall &&
      !this.stallReported &&
      this.counterEverChanged &&
      streamLive &&
      starvedMs > STALL_MS &&
      now - this.counterChangedAt > STALL_MS
    ) {
      this.stallReported = true
      this.onStall()
    }
  }

  private maybeProcess(fromRvfc: boolean): void {
    const now = performance.now()
    if (now < this.nextDue - this.intervalMs / 4) return
    if (this.busy) return // skip if the previous inference is still running (CPU delegate)
    if (this.video.readyState < 2) return
    const counter = this.sampleCounter(now)
    if (!fromRvfc && counter !== null && counter === this.processedCounter) {
      // the timer fallback must not feed the same frozen frame again — but only while
      // the counter is demonstrably live (a hidden element may not count frames at all)
      // (past that, frames are processed again: a real stall is the controller's job via
      // onStall / the track's mute event; tray monitoring must never stop on a hint)
      if (this.counterEverChanged && now - this.counterChangedAt < COUNTER_LIVE_MS) return
    }
    // stay on an ideal grid so the average equals the configured fps
    this.nextDue = Math.max(this.nextDue + this.intervalMs, now + 0.75 * this.intervalMs)
    if (counter !== null) this.processedCounter = counter
    this.busy = true
    Promise.resolve()
      .then(() => this.onFrame())
      .catch((err) => console.error('[frame-loop] frame failed:', err))
      .finally(() => {
        this.busy = false
      })
  }
}
