// Maps the pure SetupSession state (posture/calibration.ts) to the store's
// SetupUiState contract (state/store.ts), and runs the camera check of setup step 1
// (SetupProbe → useSetupProbe). Pure apart from the tiny probe store — tested in
// __tests__/setup-ui.test.ts.

import { create } from 'zustand'
import type { CalibrationBaseline, ViewKind } from '@shared/posture'
import type { AiPostureReview, AiReviewMeasurements } from '@shared/ai'
import { aiUnavailableNote } from '@renderer/ai/helpers'
import { INSTRUCTIONS, assessPosture, type CheckId, type PostureAssessment } from '@renderer/posture/assess'
import { FAIL_MESSAGES, LiveSetupGravity, type SetupState } from '@renderer/posture/calibration'
import { VIEW_ANGLED_MAX_YAW, VIEW_FRONT_MAX_YAW } from '@renderer/posture/constants'
import type { Frame, PostureFeatures } from '@renderer/posture/types'
import { median } from '@renderer/posture/vec'
import type { BaselineSummary, SetupReviewResult, SetupUiState, SetupViewFix } from '@renderer/state/store'

/** Why the essential checks can't be verified (store.ts SetupViewFix). */
export type ViewFix = SetupViewFix

/** A setup review verdict, with what the reviewer was asked to judge (`covered`). */
export type SetupReviewOutcome = SetupReviewResult

/** The setup UI state as this module produces it (store.ts SetupUiState). */
export type SetupUi = SetupUiState

/** What the controller adds on top of the session's own state. */
export interface SetupExtras {
  reviewing: { label: string } | null
  reviewNote: string | null
  reviewResult: SetupReviewOutcome | null
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

/**
 * `view` is the smoothed camera view (SetupViewTracker); left out, the latest frame's own
 * (unsmoothed) view is used.
 */
export function toSetupUi(st: SetupState, x: SetupExtras, view?: ViewKind | null): SetupUi {
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
    view: view !== undefined ? view : (st.features?.view.kind ?? null),
    viewFix: viewFixOf(st.assessment, st.features),
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

/** Why the live assessment's essentials can't be verified (see ViewFix). */
export function viewFixOf(a: PostureAssessment, f: PostureFeatures | null): ViewFix | null {
  if (a.unverified.length === 0) return null
  switch (a.viewInstruction) {
    case INSTRUCTIONS.showHips:
    case INSTRUCTIONS.showHipsForHead:
    case INSTRUCTIONS.hipsHidden:
      return 'hips'
    case INSTRUCTIONS.backFromFront:
    case INSTRUCTIONS.backFromAngle:
      return 'angle'
    case INSTRUCTIONS.levelCamera:
      return 'level'
    case INSTRUCTIONS.sitBackLookAhead:
      return 'lean'
    // the neck reads a little past the limit (inside the margin for an imprecise gravity
    // reference): bringing the head back fixes it, not the camera
    case INSTRUCTIONS.headForward:
      return 'head'
    default:
      return (f?.vis.hips ?? 0) > 0 ? 'angle' : 'hips'
  }
}

/**
 * A successful setup review as the UI shows it. `reviewing` is the session state the capture
 * was sent in: its unverifiedChecks are what the reviewer was asked to judge. They are
 * recorded here because the session clears them on acceptReview().
 */
export function reviewOutcome(res: Extract<AiPostureReview, { ok: true }>, reviewing: SetupState | null): SetupReviewOutcome {
  return {
    label: res.connectionLabel,
    model: res.model,
    verdict: res.verdict,
    summary: res.summary,
    instructions: [...res.instructions],
    covered: [...(reviewing?.unverifiedChecks ?? [])]
  }
}

// ───────────────────────────── step 2: the camera view chip ─────────────────────────────

/** a front/angled/side boundary must be crossed by this much before the view changes (deg) */
export const VIEW_KIND_HYST_DEG = 4
const VIEW_WINDOW_MS = 2000

const plainViewKind = (yaw: number): ViewKind =>
  yaw < VIEW_FRONT_MAX_YAW ? 'front' : yaw < VIEW_ANGLED_MAX_YAW ? 'angled' : 'side'

/** The view kind for a (smoothed) yaw: stays `cur` unless a boundary is clearly crossed. */
export function nextViewKind(cur: ViewKind | null, yaw: number): ViewKind {
  const h = VIEW_KIND_HYST_DEG
  switch (cur) {
    case 'front':
      return yaw >= VIEW_ANGLED_MAX_YAW ? 'side' : yaw >= VIEW_FRONT_MAX_YAW + h ? 'angled' : 'front'
    case 'angled':
      return yaw < VIEW_FRONT_MAX_YAW - h ? 'front' : yaw >= VIEW_ANGLED_MAX_YAW + h ? 'side' : 'angled'
    case 'side':
      return yaw < VIEW_FRONT_MAX_YAW ? 'front' : yaw < VIEW_ANGLED_MAX_YAW - h ? 'angled' : 'side'
    default:
      return plainViewKind(yaw)
  }
}

/**
 * Step 2's camera view: the median yaw of the last two seconds of frames, with hysteresis at the
 * front/angled/side boundaries (a single frame's kind flickers for a camera near 25° or
 * 60°). null while the user is not in view. Driven by the session's states.
 */
export class SetupViewTracker {
  private yaws: Array<{ t: number; yaw: number }> = []
  private kind: ViewKind | null = null

  reset(): void {
    this.yaws = []
    this.kind = null
  }

  push(st: SetupState, t: number): ViewKind | null {
    if (st.assessment.byId.inView.status !== 'good') {
      this.reset()
      return null
    }
    if (st.features) this.yaws.push({ t, yaw: st.features.view.yawDeg })
    while (this.yaws.length > 0 && t - this.yaws[0].t > VIEW_WINDOW_MS) this.yaws.shift()
    if (this.yaws.length > 0) this.kind = nextViewKind(this.kind, median(this.yaws.map((y) => y.yaw)))
    return this.kind
  }

  get view(): ViewKind | null {
    return this.kind
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
   * This camera view lets the on-device judge verify the back angle (assess.ts `unverified`
   * does not list trunkUpright, or only because two readings disagree — a posture matter
   * that sitting back fixes, not the camera); null while not in view.
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
  return { t, view: f.view.kind, hips, back: viewAllowsBackCheck(assessPosture(f)) }
}

/**
 * Whether this camera VIEW lets the on-device judge verify the back angle. A back left
 * unverified only because two readings disagree (as when leaning in) is the posture's doing:
 * sitting back fixes it, not moving the camera.
 */
export function viewAllowsBackCheck(a: Pick<PostureAssessment, 'unverified' | 'byId'>): boolean {
  return !a.unverified.includes('trunkUpright') || a.byId.trunkUpright.viewInstruction === INSTRUCTIONS.sitBackLookAhead
}

/** Step 1 measures like the setup session (moved to posture/calibration.ts; re-exported for callers). */
export { LiveSetupGravity }

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

/**
 * Measures each frame the way the setup session will (LiveSetupGravity) and smooths it into
 * SetupProbeState. Pure: driven by (frame, tMs).
 */
export class SetupProbe {
  private samples: ProbeSample[] = []
  private inViewSince: number | null = null
  private readonly gravity = new LiveSetupGravity()

  reset(): void {
    this.samples = []
    this.inViewSince = null
    this.gravity.reset()
  }

  /** One processed frame (null = no person found). */
  push(frame: Frame, t: number): SetupProbeState {
    this.gravity.push(frame)
    const f = frame ? this.gravity.extract(frame) : null
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
