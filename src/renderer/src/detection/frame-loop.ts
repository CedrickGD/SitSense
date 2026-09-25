/**
 * Frame pacing with a hidden-window escape hatch (docs/specs/architecture.md §4).
 *
 * Primary: requestVideoFrameCallback with an FPS throttle. With
 * backgroundThrottling disabled it *should* keep firing while the window is
 * hidden in the tray, but that has regressed across Electron majors — so a
 * watchdog switches to a plain setInterval (timers are exempt from throttling)
 * whenever rVFC starves, and back when it recovers. document.visibilityState
 * is NOT a truthful signal here (it stays 'visible'); rVFC starvation is.
 */
export class FrameLoop {
  private video: HTMLVideoElement
  private onFrame: () => void | Promise<void>
  private intervalMs: number
  private running = false
  private busy = false

  private lastRvfcTick = 0
  /** when the next frame is due; frames are taken on a schedule, not "≥ interval since the last" */
  private due = 0
  private rvfcHandle: number | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private fallbackTimer: ReturnType<typeof setInterval> | null = null

  constructor(video: HTMLVideoElement, fps: number, onFrame: () => void | Promise<void>) {
    this.video = video
    this.onFrame = onFrame
    this.intervalMs = 1000 / fps
  }

  setFps(fps: number): void {
    this.intervalMs = 1000 / fps
    this.due = 0
    if (this.fallbackTimer) {
      // re-arm at the new cadence right away (a capture can't wait for the watchdog)
      clearInterval(this.fallbackTimer)
      this.fallbackTimer = setInterval(() => this.maybeProcess(), this.intervalMs)
    }
  }

  get usingFallback(): boolean {
    return this.fallbackTimer !== null
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastRvfcTick = performance.now()
    this.scheduleRvfc()
    this.watchdog = setInterval(() => this.checkStarvation(), 2000)
  }

  stop(): void {
    this.running = false
    if (this.rvfcHandle !== null && 'cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle)
      this.rvfcHandle = null
    }
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.fallbackTimer) clearInterval(this.fallbackTimer)
    this.watchdog = null
    this.fallbackTimer = null
  }

  private scheduleRvfc(): void {
    if (!this.running) return
    this.rvfcHandle = this.video.requestVideoFrameCallback(() => {
      this.lastRvfcTick = performance.now()
      this.maybeProcess()
      this.scheduleRvfc()
    })
  }

  /**
   * The camera is actually delivering frames. A stalled camera keeps its last
   * frame (readyState stays ≥ 2) and Chromium mutes its track — that silence
   * must not be mistaken for "window hidden" and fed to the model forever.
   */
  private streamLive(): boolean {
    const src = this.video.srcObject
    if (!(src instanceof MediaStream) || this.video.readyState < 2) return false
    const track = src.getVideoTracks()[0]
    return !!track && track.readyState === 'live' && !track.muted
  }

  private checkStarvation(): void {
    if (!this.running) return
    const starvedMs = performance.now() - this.lastRvfcTick
    const threshold = Math.max(3 * this.intervalMs, 1000)
    const streamLive = this.streamLive()
    if (starvedMs > threshold && streamLive) {
      if (!this.fallbackTimer) {
        this.fallbackTimer = setInterval(() => this.maybeProcess(), this.intervalMs)
      }
    } else if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }

  private maybeProcess(): void {
    const now = performance.now()
    // half-interval tolerance: callback jitter must not push a due frame to
    // the next tick (a plain "≥ interval since last" gate ran at ~60–80% fps)
    if (now < this.due - this.intervalMs / 2) return
    if (this.busy) return // skip if the previous inference is still running (CPU delegate)
    if (!this.streamLive()) return
    // advance on the schedule (keeps the average rate exact); after a stall,
    // restart the schedule from now instead of bursting to catch up
    this.due = Math.max(this.due, now - this.intervalMs / 2) + this.intervalMs
    this.busy = true
    Promise.resolve(this.onFrame()).finally(() => {
      this.busy = false
    })
  }
}
