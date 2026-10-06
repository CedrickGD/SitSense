// Shared React hooks for the v3 shell and pages (docs/specs/ui-v3.md §2.2, §3.4.1).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CameraError } from '@shared/posture'
import { useAppStore } from '@renderer/state/store'
import { postureScore, ScoreSmoother } from './score'

// ───────────────────────────── window size / breakpoints ─────────────────────────────

/** Breakpoints use the WINDOW width: compact < 1000 ≤ standard < 1280 ≤ wide. */
export type Breakpoint = 'compact' | 'standard' | 'wide'

export const BP_STANDARD = 1000
export const BP_WIDE = 1280

export function breakpointFor(width: number): Breakpoint {
  if (width < BP_STANDARD) return 'compact'
  if (width < BP_WIDE) return 'standard'
  return 'wide'
}

const subscribeResize = (cb: () => void): (() => void) => {
  window.addEventListener('resize', cb)
  return () => window.removeEventListener('resize', cb)
}

/** window.innerWidth, re-rendering on resize (1200 during server rendering / tests). */
export function useWindowWidth(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 1200
  )
}

/** window.innerHeight, re-rendering on resize (800 during server rendering / tests). */
export function useWindowHeight(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerHeight,
    () => 800
  )
}

/** 'compact' | 'standard' | 'wide' for the current window width. */
export function useBreakpoint(): Breakpoint {
  const w = useWindowWidth()
  return breakpointFor(w)
}

// ───────────────────────────── clock ─────────────────────────────

/** Date.now(), refreshed every `intervalMs` while `active` (countdowns, "for 2m 10s"). */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, active])
  return now
}

// ───────────────────────────── monitoring state ─────────────────────────────

export interface MonitoringState {
  paused: boolean
  /** epoch ms the pause ends, null = until resumed */
  resumeAt: number | null
  running: boolean
  cameraError: CameraError
  detectorError: 'model' | 'inference' | null
  /** a baseline is saved */
  calibrated: boolean
  /** the saved baseline is for another camera (not applied) */
  mismatch: boolean
  /** posture is being measured right now: not paused, running, no camera/detector error */
  live: boolean
  /** live, set up for this camera, and the person is in view */
  watching: boolean
}

/**
 * The one gate for anything "live". The store keeps the last snapshot (frozen) while
 * paused or after the camera fails, so posture displays must check `live` / `watching`.
 */
export function useMonitoring(): MonitoringState {
  const paused = useAppStore((s) => s.pause.paused)
  const resumeAt = useAppStore((s) => s.pause.resumeAt)
  const running = useAppStore((s) => s.detection.running)
  const cameraError = useAppStore((s) => s.detection.cameraError)
  const detectorError = useAppStore((s) => s.detectorError)
  const calibrated = useAppStore((s) => !!s.settings?.calibration)
  const mismatch = useAppStore((s) => s.baselineCameraMismatch)
  const present = useAppStore((s) => s.snapshot !== null && s.snapshot.presence === 'active')
  const live = !paused && running && !cameraError && !detectorError
  return {
    paused,
    resumeAt,
    running,
    cameraError,
    detectorError,
    calibrated,
    mismatch,
    live,
    watching: live && calibrated && !mismatch && present
  }
}

/**
 * What the sidebar's monitoring pill says (§2.3): priority paused > camera (or the pose
 * model failed to load) > not set up > set up for another camera (nothing judged, no
 * nudges) > monitoring.
 */
export type MonitoringPillState = 'monitoring' | 'paused' | 'camera' | 'setup' | 'mismatch'

export function monitoringPillState(
  m: Pick<MonitoringState, 'paused' | 'cameraError' | 'calibrated'> & Partial<Pick<MonitoringState, 'detectorError' | 'mismatch'>>
): MonitoringPillState {
  if (m.paused) return 'paused'
  if (m.cameraError || m.detectorError === 'model') return 'camera'
  if (!m.calibrated) return 'setup'
  if (m.mismatch) return 'mismatch'
  return 'monitoring'
}

// ───────────────────────────── live score ─────────────────────────────

/**
 * The smoothed live score (τ = 2 s), or null when it can't be scored (§3.4.1 gate).
 * Re-renders a few times a second only while the display is catching up.
 */
export function useLiveScore(): { score: number | null; raw: number | null } {
  const snapshot = useAppStore((s) => s.snapshot)
  const issues = useAppStore((s) => s.settings?.issues)
  const m = useMonitoring()
  const enabled = issues
    ? { sink: issues.sink.enabled, headForward: issues.headForward.enabled, lean: issues.lean.enabled, tooClose: issues.tooClose.enabled }
    : {}
  const raw = postureScore(snapshot, enabled, {
    paused: m.paused,
    cameraError: m.cameraError ?? m.detectorError,
    running: m.running,
    baselineMismatch: m.mismatch
  })

  const smoother = useRef(new ScoreSmoother())
  const [display, setDisplay] = useState<number | null>(() => smoother.current.update(raw, Date.now()))

  useEffect(() => {
    setDisplay(smoother.current.update(raw, Date.now()))
    if (raw === null) return
    const t = setInterval(() => {
      const v = smoother.current.update(raw, Date.now())
      setDisplay(v)
      if (v === null || Math.abs(v - raw) < 0.4) clearInterval(t)
    }, 200)
    return () => clearInterval(t)
  }, [raw])

  return { score: display === null ? null : Math.round(display), raw }
}
