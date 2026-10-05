import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameLoop, STALL_MS } from '../frame-loop'

class FakeMediaStream {}

/** A fake <video>: rVFC fires once per camera frame (with jitter) unless `starved`. */
function fakeVideo(opts: { cameraFps: number; jitterMs?: number; starved?: boolean }) {
  let frames = 0
  let handle = 0
  let frozen = false
  const pending = new Map<number, ReturnType<typeof setTimeout>>()
  const camTimer = setInterval(() => {
    if (!frozen) frames++
  }, 1000 / opts.cameraFps)
  const video = {
    readyState: 4,
    srcObject: new FakeMediaStream(),
    requestVideoFrameCallback(cb: () => void): number {
      const id = ++handle
      if (opts.starved) return id
      const jitter = (opts.jitterMs ?? 0) * Math.random()
      pending.set(
        id,
        setTimeout(() => {
          pending.delete(id)
          if (!frozen) cb()
        }, 1000 / opts.cameraFps + jitter)
      )
      return id
    },
    cancelVideoFrameCallback(id: number): void {
      const t = pending.get(id)
      if (t) clearTimeout(t)
      pending.delete(id)
    },
    getVideoPlaybackQuality: () => ({ totalVideoFrames: frames })
  }
  return {
    video: video as unknown as HTMLVideoElement,
    freeze: () => {
      frozen = true
    },
    dispose: () => clearInterval(camTimer)
  }
}

describe('FrameLoop pacing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    ;(globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const [cameraFps, target] of [
    [30, 10],
    [30, 15],
    [15, 10],
    [30, 5]
  ] as const) {
    it(`delivers ~${target} fps from a ${cameraFps} fps camera (rVFC)`, async () => {
      const cam = fakeVideo({ cameraFps, jitterMs: 3 })
      let n = 0
      const loop = new FrameLoop(cam.video, target, () => {
        n++
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(20_000)
      loop.stop()
      cam.dispose()
      const fps = n / 20
      // a 15 fps camera can only give 10 fps as 7.5 (every 2nd frame) or 15 — the grid lands between
      const tol = cameraFps === 15 ? 0.15 : 0.06
      expect(fps).toBeGreaterThan(target * (1 - tol))
      expect(fps).toBeLessThanOrEqual(target * 1.02)
    })
  }

  it('keeps the rate through the timer fallback when rVFC starves (tray)', async () => {
    const cam = fakeVideo({ cameraFps: 30, starved: true })
    let n = 0
    const loop = new FrameLoop(cam.video, 10, () => {
      n++
    })
    loop.start()
    await vi.advanceTimersByTimeAsync(3_000) // watchdog switches to the fallback
    n = 0
    await vi.advanceTimersByTimeAsync(20_000)
    expect(loop.usingFallback).toBe(true)
    loop.stop()
    cam.dispose()
    expect(n / 20).toBeGreaterThan(9.4)
    expect(n / 20).toBeLessThanOrEqual(10.2)
  })

  it('does not feed a frozen frame again and reports the stall', async () => {
    const cam = fakeVideo({ cameraFps: 30, starved: true })
    let n = 0
    const onStall = vi.fn()
    const loop = new FrameLoop(
      cam.video,
      10,
      () => {
        n++
      },
      { onStall }
    )
    loop.start()
    await vi.advanceTimersByTimeAsync(5_000)
    cam.freeze()
    const before = n
    await vi.advanceTimersByTimeAsync(1_500)
    // at most the one frame already due when the camera froze
    expect(n - before).toBeLessThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(STALL_MS + 2_000)
    expect(onStall).toHaveBeenCalledTimes(1)
    loop.stop()
    cam.dispose()
  })
})
