// Maps the pure SetupSession state (posture/calibration.ts) to the store's
// SetupUiState contract (state/store.ts), and runs the camera check of setup step 1
// (SetupProbe → useSetupProbe). Pure apart from the tiny probe store — tested in
// __tests__/setup-ui.test.ts.

import { create } from 'zustand'
import type { CalibrationBaseline, ViewKind } from '@shared/posture'
import type { AiReviewMeasurements } from '@shared/ai'
import { aiUnavailableNote } from '@renderer/ai/helpers'
import { assessPosture, type CheckId } from '@renderer/posture/assess'
import { FAIL_MESSAGES, type SetupState } from '@renderer/posture/calibration'
import type { PostureFeatures } from '@renderer/posture/types'
import type { BaselineSummary, SetupReviewResult, SetupUiState } from '@renderer/state/store'

/** What the controller adds on top of the session's own state. */
export interface SetupExtras {
  reviewing: { label: string } | null
  reviewNote: string | null
  reviewResult: SetupReviewResult | null
  baselineSummary: BaselineSummary | null
  saveError: string | null
}

export const NO_EXTRAS: SetupExtras = {
  reviewing: null,
  reviewNote: null,
  reviewResult: null,
  baselineSummary: null,
  saveError: null
}

const r2 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 50) / 50
const r1 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10)

export function toSetupUi(st: SetupState, x: SetupExtras): SetupUiState {
  return {
    phase: st.phase,
    suspended: null,
    instruction: st.instruction,
    checks: st.assessment.checks.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      instruction: c.instruction
    })),
    view: st.features?.view.kind ?? null,
    holdProgress: r2(st.holdProgress),
    captureProgress: r2(st.captureProgress),
    canForce: st.canForce,
    autoCapture: st.autoCapture,
    forced: st.forced,
    failReason: st.failReason,
    failMessage: st.failReason ? FAIL_MESSAGES[st.failReason] : null,
    notice: st.notice,
    unverifiedChecks: [...st.unverifiedChecks],
    needsVerification: st.needsVerification,
    reviewing: st.phase === 'reviewing' ? x.reviewing : null,
    reviewNote: x.reviewNote,
    reviewResult: x.reviewResult,
    reviewRejections: st.reviewRejections,
    baselineSummary: st.phase === 'done' ? x.baselineSummary : null,
    saveError: x.saveError
  }
}

export function summarizeBaseline(b: CalibrationBaseline, forced: boolean): BaselineSummary {
  return {
    view: b.view.kind,
    verified: b.verified,
    forced,
    neckFwdDeg: r1(b.neckFwd) ?? 0,
    trunkFwdDeg: r1(b.trunkFwd),
    headPitchDeg: r1(b.headPitch),
    shoulderTiltDeg: r1(b.shoulderTilt),
    headRollDeg: r1(b.headRollRel),
    trunkLatDeg: r1(b.trunkLat),
    gravity: b.upSource
  }
}

// ───────────────────────────── the setup review request ─────────────────────────────

/** What an unverified essential check means, in the words the reviewer needs (§11.3). */
const MUST_JUDGE: Partial<Record<CheckId, string>> = {
  trunkUpright: 'back angle (slumped, reclined or lying in the chair?)',
  headOverShoulders: 'head position (ears over the shoulders?)'
}

/**
 * The setup review's measurements. A capture the on-device judge could not fully verify
 * from this camera must not reach the model as a plain "good": the request names what it
 * could not check and asks the model to judge exactly that — and to say "adjust" when it
 * can't tell (ui-v3.md §7.4, §11.3). The validator caps localInstruction at 200 chars.
 */
export function setupReviewMeasurements(base: AiReviewMeasurements, unverified: readonly CheckId[]): AiReviewMeasurements {
  const what = unverified.map((id) => MUST_JUDGE[id]).filter((s): s is string => !!s)
  if (what.length === 0) return base
  return {
    ...base,
    localVerdict: 'adjust',
    localInstruction: `Not verifiable on-device from this camera: ${what.join('; ')}. Judge it from the image; answer adjust if unsure.`.slice(0, 200)
  }
}

/** "your back" / "your back and your head position" — for the unreachable-reviewer note. */
export function unverifiedPhrase(unverified: readonly CheckId[]): string {
  const parts: string[] = []
  if (unverified.includes('trunkUpright')) parts.push('your back')
  if (unverified.includes('headOverShoulders')) parts.push('your head position')
  return parts.length > 0 ? parts.join(' and ') : 'your posture'
}

/**
 * The note when the setup review could not run. A capture the on-device judge verified is
 * saved on its own verdict; one it could not verify stays unsaved and the note says why
 * (ui-v3.md §7.4.3: the flow does not fall back to passing).
 */
export function reviewFailNote(label: string | null, message: string, unverified: readonly CheckId[]): string {
  if (unverified.length === 0) return aiUnavailableNote(message)
  return `Couldn't reach ${label ?? 'your AI model'} — I still can't check ${unverifiedPhrase(unverified)}.`
}

// ───────────────────────────── step 1: camera check ─────────────────────────────

/**
 * What setup step 1 ("Let's check your camera", ui-v3.md §7.2) can see, smoothed over
 * the last second so the rows don't flicker. Written by the controller while the setup
 * flow is open and its coaching session has not started yet.
 */
export interface SetupProbeState {
  /** frames are arriving from the camera and the detector */
  frames: boolean
  /** the head and at least one shoulder are in the picture (most recent ~0.6 s) */
  inView: boolean
  /** inView has held for PROBE_READY_MS — "Start coaching" may be pressed */
  ready: boolean
  /** most common camera view while in view; null while not in view */
  view: ViewKind | null
  /**
   * 'seen' = usable hips · 'hidden' = in the picture but covered (a desk) · 'out' = outside
   * the picture; null while not in view
   */
  hips: 'seen' | 'hidden' | 'out' | null
  /**
   * The on-device judge can verify the back angle from this view (assess.ts `unverified`
   * does not list trunkUpright); null while not in view.
   */
  backCheckable: boolean | null
}

export const IDLE_PROBE: SetupProbeState = {
  frames: false,
  inView: false,
  ready: false,
  view: null,
  hips: null,
  backCheckable: null
}

/** "You" must have been in view this long before coaching can start (§7.2) */
export const PROBE_READY_MS = 1000
const PROBE_WINDOW_MS = 1000
const PROBE_IN_VIEW_MS = 600
/** no frame for this long = the camera stopped delivering */
const PROBE_STALE_MS = 1500

type HipsSeen = SetupProbeState['hips']

interface ProbeSample {
  t: number
  view: ViewKind | null
  hips: HipsSeen
  back: boolean | null
}

function sampleOf(f: PostureFeatures | null, t: number): ProbeSample {
  if (!f) return { t, view: null, hips: null, back: null }
  const hips: HipsSeen = f.vis.hips > 0 ? 'seen' : (f.vis.hipsInFrame ?? 0) > 0 ? 'hidden' : 'out'
  const back = !assessPosture(f).unverified.includes('trunkUpright')
  return { t, view: f.view.kind, hips, back }
}

function mode<T>(items: readonly T[]): T | null {
  const counts = new Map<T, number>()
  let best: T | null = null
  let bestN = 0
  for (const it of items) {
    const n = (counts.get(it) ?? 0) + 1
    counts.set(it, n)
    // ties go to the most recent value (items are oldest first)
    if (n >= bestN) {
      best = it
      bestN = n
    }
  }
  return best
}

/** Smooths per-frame features into SetupProbeState. Pure: driven by (features, tMs). */
export class SetupProbe {
  private samples: ProbeSample[] = []
  private inViewSince: number | null = null

  reset(): void {
    this.samples = []
    this.inViewSince = null
  }

  /** One processed frame: its features (null = the head and a shoulder were not found). */
  push(f: PostureFeatures | null, t: number): SetupProbeState {
    this.samples.push(sampleOf(f, t))
    while (this.samples.length > 0 && t - this.samples[0].t > PROBE_WINDOW_MS) this.samples.shift()
    return this.state(t)
  }

  /** The state at time t (also when frames stopped arriving). */
  state(t: number): SetupProbeState {
    const last = this.samples[this.samples.length - 1]
    if (!last || t - last.t > PROBE_STALE_MS) {
      this.inViewSince = null
      return IDLE_PROBE
    }
    const recent = this.samples.filter((s) => t - s.t <= PROBE_IN_VIEW_MS)
    const seen = recent.filter((s) => s.view !== null).length
    const inView = recent.length > 0 && seen * 2 >= recent.length && last.view !== null
    if (!inView) {
      this.inViewSince = null
      return { ...IDLE_PROBE, frames: true }
    }
    if (this.inViewSince === null) this.inViewSince = t
    const visible = this.samples.filter((s) => s.view !== null)
    const backs = visible.map((s) => s.back)
    return {
      frames: true,
      inView: true,
      ready: t - this.inViewSince >= PROBE_READY_MS,
      view: mode(visible.map((s) => s.view)),
      hips: mode(visible.map((s) => s.hips)),
      backCheckable: backs.filter(Boolean).length * 2 > backs.length
    }
  }
}

/** Step 1's camera check (written by the controller, read by the setup screen). */
export const useSetupProbe = create<SetupProbeState>(() => IDLE_PROBE)

/** Publish a probe state, skipping identical ones. */
export function publishProbe(next: SetupProbeState): void {
  const cur = useSetupProbe.getState()
  if (
    cur.frames === next.frames &&
    cur.inView === next.inView &&
    cur.ready === next.ready &&
    cur.view === next.view &&
    cur.hips === next.hips &&
    cur.backCheckable === next.backCheckable
  ) {
    return
  }
  useSetupProbe.setState(next, true)
}
