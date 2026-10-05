// Setup ("calibration") session (docs/specs/detection.md §7).
//
// The AI — not the user — decides when the posture is good: every GOOD frame is
// assessed (assess.ts), the user is coached with one concrete instruction, and the
// baseline is captured automatically once the posture has been good for HOLD_S.
// Driven purely by (frame, tMs); no timers, no wall clock (except `now()` for the
// baseline's capturedAt stamp).
//
//   searching ─GOOD─▶ coaching ─ok─▶ holding ─HOLD_S─▶ capturing ─CAPTURE_S─▶ final exam ─▶ done
//                         ▲             │ adjust>BREAK_S   │ adjust>BREAK_S          │ (review) ▼
//                         └─────────────┴──────────────────┴─────── exam fails ◀────┤    reviewing
//                         ▲                                                          │
//                         └──────────── rejectReview(instruction) ◀──────────────────┘
//   ok = the assessment is `verified` (without a reviewer) / `allGood` (with one).
//   BAD frames for > SEARCH_LOST_S anywhere before 'reviewing' → searching.
//   capture fails → failed('unstable' | 'lost'); restart() → searching. A capture that
//   only failed its stability check after a tolerated wobble goes back to coaching.
//
// Details (see the Implementation notes in docs/specs/detection.md):
// - the live judgement is the assessment of the per-feature median of the last
//   ASSESS_WINDOW_S of GOOD frames (the head-on-trunk angles: ASSESS_RELATIVE_WINDOW_S),
//   all measured with the current gravity estimate (frames measured with an earlier one are
//   measured again); while holding/capturing every tolerance is widened by
//   ASSESS_HOLD_SLACK so sensor noise cannot flicker a check that was just good.
// - final exam: the captured posture's robust average is judged once more without that
//   slack (buildBaseline's `assessment`); a capture in which it finds an essential check
//   (back, head) to adjust, or — without a reviewer — one it cannot verify, goes back to
//   coaching.
// - the first verdict waits for SETUP_WARMUP_FRAMES GOOD frames since the user came
//   into view (a frame count, not a window size, so it also works below 5 fps).
// - hips are used only while they look real: a pelvis line consistently twisted
//   against the shoulder line is hallucinated (HipConsistency) and ignored.
// - gravity is a level-camera estimate (a pitch, roll 0); while the hip line contradicts a
//   level camera (UpEstimator.levelConsistent) the shoulders' tilt against gravity is not
//   judged (AssessOptions.levelUnconfirmed).
// - the baseline uses the hold's GOOD frames plus the capture's frames that were
//   judged good (a forced capture keeps every frame); the capture needs ≥
//   SETUP_MIN_FRAMES of its own and may run up to CAPTURE_MAX_S to collect them.
// - `canForce` is earned after FORCE_AFTER_S of coaching/holding and kept across
//   restart(); so is the review rejection count.
//
// Verification (strict). Some essential checks cannot be judged from some cameras (the trunk
// lean without thigh gravity outside a near-profile view, or without a hip in view; the head
// with neither the trunk nor a gravity reference): the assessment lists them as `unverified`
// and is not `verified`. Nothing is ever saved on such a posture by the local judge alone:
// - without a reviewer the session keeps coaching (`needsVerification`, with the assessment's
//   `viewInstruction`: show the hips / sit tall, the back angle cannot be judged from the
//   front) and, once that posture has been held for UNVERIFIED_FORCE_AFTER_S, offers
//   "Save this posture anyway" (`canForce`; the saved baseline has verified = false);
// - with a reviewer the capture goes to the cloud review, which decides.
//
// External review hook: construct with `review: true` (review every capture) or
// `review: 'auto'` (only captures with unverified checks) and the session stops in
// 'reviewing' with `pendingBaseline` set. The integration layer asks a cloud model to
// confirm the posture and calls acceptReview() (→ done, verified), rejectReview(
// instruction) (→ coaching, instruction surfaced) or skipReview() (the review could not
// run → done with the local verdict when the local judge verified everything; otherwise
// back to coaching without a reviewer, with `canForce` on). After a rejection the session
// coaches for at least REVIEW_RETRY_S before the next hold; after REVIEW_REJECTS_FOR_FORCE
// rejections `canForce` turns on (also while capturing/reviewing; forcing a pending review
// saves it unverified), and after REVIEW_MAX_AUTO rejections it stops capturing on its own
// (`autoCapture: false`) until restart() or force(). A forced capture skips the review
// (the user chose to save anyway; the baseline has verified = false). While
// 'reviewing', frames still update `features`/`assessment` but not the phase.

import type { CalibrationBaseline, UpSource, Vec3 } from '@shared/posture'
import { ESSENTIAL_CHECKS, assessPosture, type CheckId, type PostureAssessment } from './assess'
import {
  ASSESS_HOLD_SLACK,
  ASSESS_RELATIVE_WINDOW_S,
  ASSESS_WINDOW_S,
  BREAK_S,
  CAPTURE_MAX_S,
  CAPTURE_S,
  DT_CAP_S,
  FORCE_AFTER_S,
  HOLD_S,
  NECK_DROP_MAX_YAW,
  REVIEW_MAX_AUTO,
  REVIEW_REJECTS_FOR_FORCE,
  REVIEW_RETRY_S,
  SEARCH_LOST_S,
  SETUP_MIN_FRAMES,
  SETUP_WARMUP_FRAMES,
  SIDE_VIEW_YAW,
  SIDE_VIEW_YAW_MAX,
  UNVERIFIED_FORCE_AFTER_S,
  UP_MAX_TILT,
  STABLE_ANCHOR_M,
  STABLE_NECK_DEG,
  STABLE_NOISE_K,
  VIEW_ANGLED_MAX_YAW,
  VIEW_FRONT_MAX_YAW
} from './constants'
import {
  HipConsistency,
  UpEstimator,
  cameraPitchDeg,
  cameraUp,
  extractFeatures,
  headOnTrunkAngle,
  neckOnTrunkAngle
} from './features'
import type { Frame, NeckLatRef, PostureBaseline, PostureFeatures, UpEstimate, ViewInfo } from './types'
import { add, angleDeg, median, scale, trimmedMean, unit } from './vec'

export type SetupPhase = 'searching' | 'coaching' | 'holding' | 'capturing' | 'reviewing' | 'done' | 'failed'
export type SetupFailReason = 'unstable' | 'lost'

export const FAIL_MESSAGES: Record<SetupFailReason, string> = {
  unstable: 'Hold still for a moment.',
  lost: "We lost sight of you — make sure your head and a shoulder stay in the picture."
}

/**
 * Shown when a baseline was saved without the local judge verifying every check it relied on.
 * (Since the strict judge this no longer happens without the user's choice: such a posture is
 * only saved by force(), which has its own copy, or after the cloud review accepted it.)
 */
export const UNVERIFIED_NOTICE: Partial<Record<CheckId, string>> = {
  trunkUpright:
    "Your back angle couldn't be checked from this camera position. Make sure you sit upright against the backrest — or turn on AI review to confirm it.",
  headOverShoulders:
    "Your head position couldn't be checked from this camera position. Make sure your ears sit over your shoulders — or turn on AI review to confirm it."
}

/** a capture that failed its stability check after a wobble is retried this often before failing */
const MAX_WOBBLE_RETRIES = 2

/** a window frame measured with a gravity estimate further than this from the current one is measured again (deg) */
const WINDOW_REMEASURE_DEG = 0.5

export interface SetupOptions {
  cameraDeviceId?: string | null
  /**
   * Stop in 'reviewing' after a capture so an external (cloud AI) check can veto:
   * true = every capture, 'auto' = only captures with checks the local judge could not
   * verify from this camera (default false = never).
   */
  review?: boolean | 'auto'
  /** epoch-ms clock for `capturedAt` (default Date.now) */
  now?: () => number
}

export interface SetupState {
  phase: SetupPhase
  /** latest GOOD frame's features (null while not in view) */
  features: PostureFeatures | null
  /** live judgement of the recent (time-smoothed) posture */
  assessment: PostureAssessment
  /**
   * The one instruction to show large right now: the live assessment's primary
   * instruction, else the last review rejection's instruction, else a phase message
   * (failed). null when nothing needs saying.
   */
  instruction: string | null
  /** 0..1 while holding (1 when capture starts) */
  holdProgress: number
  /** 0..1 while capturing */
  captureProgress: number
  /**
   * The user may save the current posture anyway: after FORCE_AFTER_S in coaching/holding,
   * after UNVERIFIED_FORCE_AFTER_S of `needsVerification`, after a review that could not run
   * on a posture the local judge could not verify, or after REVIEW_REJECTS_FOR_FORCE review
   * rejections (then also while capturing or reviewing).
   */
  canForce: boolean
  /**
   * Coaching without a reviewer on a posture that is good in everything this camera shows,
   * but whose essential checks it cannot verify (assessment.verified false): it is not saved
   * on its own. `instruction` says how to make it checkable; `canForce` follows shortly.
   */
  needsVerification: boolean
  /** the running/last capture was forced */
  forced: boolean
  failReason: SetupFailReason | null
  /** number of rejected reviews so far */
  reviewRejections: number
  /** the last review rejection's instruction (cleared by the next capture, acceptReview, restart) */
  reviewInstruction: string | null
  /** false once REVIEW_MAX_AUTO reviews were rejected: no more automatic captures until restart()/force() */
  autoCapture: boolean
  /**
   * Checks the local judge could not verify from this camera: for the captured posture
   * once 'reviewing'/'done', else for the live one. A baseline relying on them is not
   * verified unless the review accepted it.
   */
  unverifiedChecks: CheckId[]
  /** a message for the user about the saved baseline (e.g. what could not be verified), else null */
  notice: string | null
  /** set in 'reviewing' (awaiting the verdict) and in 'done' */
  baseline: CalibrationBaseline | null
  /** gravity estimate used for the live assessment */
  up: UpEstimate
  /** the hips look real and are used (false: hallucinated, ignored) */
  hipsTrusted: boolean
}

interface Captured {
  frame: NonNullable<Frame>
  t: number
}

export class SetupSession {
  private readonly opts: { review: boolean | 'auto'; now: () => number; cameraDeviceId: string | null }
  private readonly upEst = new UpEstimator()
  /** the same estimate without hips/knees, used once the hips are judged hallucinated */
  private readonly upEstNoHips = new UpEstimator()
  private readonly hipCheck = new HipConsistency()

  private phase: SetupPhase = 'searching'
  private lastT: number | null = null
  private badMs = 0
  private adjustMs = 0
  private holdMs = 0
  private captureMs = 0
  private coachingMs = 0
  /** time the posture has continuously been good but not verifiable (no reviewer) */
  private unverifiedMs = 0
  /** how long that has been interrupted (an interruption up to BREAK_S does not reset it) */
  private unverifiedBreakMs = 0
  /** the review could not run on an unverifiable capture: no reviewer until restart() */
  private localOnly = false
  private forceEarned = false
  private forced = false
  private failReason: SetupFailReason | null = null
  private rejections = 0
  /** rejections since the last restart() (for the automatic-capture cap) */
  private autoRejections = 0
  /** coaching time still required before the next hold, after a rejection */
  private retryBlockMs = 0
  private reviewInstruction: string | null = null
  /** what the final exam of the last capture found to adjust (shown until the next capture) */
  private examInstruction: string | null = null
  private captured: Captured[] = []
  /** GOOD frames of the current hold (verified-good posture), reused by the baseline */
  private holdFrames: Captured[] = []
  private holdCount = 0
  /** an 'adjust' verdict was tolerated (< BREAK_S) or a frame was left out during the running capture */
  private wobbled = false
  /** captures in a row that went back to coaching after a wobble (then 'unstable' is final) */
  private wobbleRetries = 0
  /** GOOD frames since the user came into view (warm-up) */
  private goodRun = 0
  /** the last ASSESS_RELATIVE_WINDOW_S of GOOD frames, with the gravity each was measured with */
  private window: Array<{ t: number; f: PostureFeatures; frame: NonNullable<Frame>; up: Vec3; src: UpSource; hips: boolean }> = []
  private latest: PostureFeatures | null = null
  private assessment: PostureAssessment = assessPosture(null)
  private result: CalibrationBaseline | null = null
  private resultUnverified: CheckId[] = []

  constructor(opts: SetupOptions = {}) {
    this.opts = {
      review: opts.review ?? false,
      now: opts.now ?? (() => Date.now()),
      cameraDeviceId: opts.cameraDeviceId ?? null
    }
  }

  get state(): SetupState {
    const captured = this.phase === 'reviewing' || this.phase === 'done'
    const unverifiedChecks = captured ? this.resultUnverified : this.assessment.unverified
    return {
      phase: this.phase,
      features: this.latest,
      assessment: this.assessment,
      instruction: this.instruction(),
      holdProgress:
        this.phase === 'holding'
          ? Math.min(1, this.holdMs / (HOLD_S * 1000))
          : this.phase === 'capturing' || captured
            ? 1
            : 0,
      captureProgress:
        this.phase === 'capturing' ? Math.min(1, this.captureMs / (CAPTURE_S * 1000)) : captured ? 1 : 0,
      canForce: this.canForce,
      needsVerification: this.needsVerification,
      forced: this.forced,
      failReason: this.failReason,
      reviewRejections: this.rejections,
      reviewInstruction: this.reviewInstruction,
      autoCapture: this.autoRejections < REVIEW_MAX_AUTO,
      unverifiedChecks,
      notice: this.notice(),
      baseline: captured ? this.result : null,
      up: this.liveUp(),
      hipsTrusted: this.hipCheck.trusted
    }
  }

  /** The finished baseline (null until 'done'). */
  get baseline(): CalibrationBaseline | null {
    return this.phase === 'done' ? this.result : null
  }

  /** The captured baseline awaiting review (only in 'reviewing'). */
  get pendingBaseline(): CalibrationBaseline | null {
    return this.phase === 'reviewing' ? this.result : null
  }

  /** A reviewer will confirm captures (review on, and it has not failed to run on an unverifiable one). */
  private get reviewer(): boolean {
    return this.opts.review !== false && !this.localOnly
  }

  /**
   * Good enough to hold and capture: everything the camera shows is good, and — unless a
   * reviewer will confirm the capture — every essential check was verified locally.
   */
  private postureOk(a: PostureAssessment): boolean {
    return this.reviewer ? a.allGood : a.verified
  }

  /** Coaching on a locally good posture that this camera cannot verify (and no reviewer). */
  private get needsVerification(): boolean {
    return (
      this.phase === 'coaching' &&
      !this.reviewer &&
      this.assessment.allGood &&
      !this.assessment.verified
    )
  }

  get canForce(): boolean {
    if ((this.forceEarned || this.rejections >= REVIEW_REJECTS_FOR_FORCE) && (this.phase === 'coaching' || this.phase === 'holding')) {
      return true
    }
    // once the reviewer rejected repeatedly, saving anyway stays reachable while the
    // session captures or waits for yet another review
    return (
      this.rejections >= REVIEW_REJECTS_FOR_FORCE &&
      ((this.phase === 'capturing' && !this.forced) || this.phase === 'reviewing')
    )
  }

  /** Feed one frame. Returns the new state. */
  push(frame: Frame, tMs: number): SetupState {
    const dtMs = this.lastT === null ? 0 : Math.min(Math.max(0, tMs - this.lastT), DT_CAP_S * 1000)
    this.lastT = tMs

    // live features + assessment (also during reviewing/done so the UI stays live)
    this.hipCheck.push(frame)
    this.upEst.push(frame)
    this.upEstNoHips.push(frame, { hips: false })
    const up = this.liveUp()
    const hips = this.hipCheck.trusted
    const f = extractFeatures(frame, { up: up.up, upSource: up.source, hips })
    this.latest = f
    while (this.window.length > 0 && tMs - this.window[0].t > ASSESS_RELATIVE_WINDOW_S * 1000) this.window.shift()
    // the window is judged with ONE gravity: frames measured with an earlier estimate (while
    // it settles over the first frames, or when the hips' verdict flips) are measured again,
    // or a median of mixed gravities would judge a lean that is not there
    for (const w of this.window) {
      if (w.src === up.source && w.hips === hips && angleDeg(w.up, up.up) <= WINDOW_REMEASURE_DEG) continue
      const g = extractFeatures(w.frame, { up: up.up, upSource: up.source, hips })
      if (g) Object.assign(w, { f: g, up: up.up, src: up.source, hips })
    }
    if (f && frame) {
      this.window.push({ t: tMs, f, frame, up: up.up, src: up.source, hips })
      this.badMs = 0
      this.goodRun++
    } else {
      this.badMs += dtMs
    }
    // the live judgement uses the median of the recent GOOD frames (the head-on-trunk angles:
    // of a longer window); a BAD frame only counts once the user has been out of view for a moment
    const recent = this.window.filter((w) => tMs - w.t <= ASSESS_WINDOW_S * 1000)
    if (f === null && (recent.length === 0 || this.badMs > SEARCH_LOST_S * 1000)) {
      this.window = []
      this.goodRun = 0
      this.assessment = assessPosture(null)
    } else if (recent.length > 0) {
      const holdingOn = this.phase === 'holding' || this.phase === 'capturing'
      const m = { ...medianFeatures(recent.map((w) => w.f)) }
      const long = medianFeatures(this.window.map((w) => w.f))
      if (m.neckOnTrunk !== undefined) m.neckOnTrunk = long.neckOnTrunk ?? null
      if (m.headOnTrunk !== undefined) m.headOnTrunk = long.headOnTrunk ?? null
      this.assessment = assessPosture(m, undefined, {
        slack: holdingOn ? ASSESS_HOLD_SLACK : 1,
        levelUnconfirmed: !this.liveEstimator().levelConsistent
      })
    }

    if (this.phase === 'done' || this.phase === 'failed' || this.phase === 'reviewing') return this.state

    // lost the user → searching
    if (f === null) {
      if (this.phase !== 'searching' && this.badMs > SEARCH_LOST_S * 1000) this.toSearching()
      else if (this.phase === 'capturing') this.captureMs += dtMs // time runs; the frame is not collected
      if (this.phase === 'capturing') this.checkCaptureDone()
      return this.state
    }

    const good = this.postureOk(this.assessment)
    const mayHold = this.retryBlockMs <= 0 && this.autoRejections < REVIEW_MAX_AUTO
    switch (this.phase) {
      case 'searching':
        // judge only once a few frames have settled the gravity estimate and the window
        if (this.goodRun < SETUP_WARMUP_FRAMES) break
        this.phase = 'coaching'
        this.adjustMs = 0
        this.unverifiedMs = 0
        if (good && mayHold) this.toHolding()
        break

      case 'coaching':
        this.coachingMs += dtMs
        this.retryBlockMs = Math.max(0, this.retryBlockMs - dtMs)
        if (this.coachingMs >= FORCE_AFTER_S * 1000) this.forceEarned = true
        // good in everything this camera shows, but not verifiable here (and nobody to ask):
        // never saved on its own; the user may save it anyway once it has been held a moment
        // (a flicker shorter than BREAK_S — a lateral check on noise — does not restart the clock)
        if (this.needsVerification) {
          this.unverifiedMs += dtMs
          this.unverifiedBreakMs = 0
          if (this.unverifiedMs >= UNVERIFIED_FORCE_AFTER_S * 1000) this.forceEarned = true
        } else {
          this.unverifiedBreakMs += dtMs
          if (this.unverifiedBreakMs > BREAK_S * 1000) this.unverifiedMs = 0
        }
        if (good && mayHold) this.toHolding()
        break

      case 'holding':
        this.coachingMs += dtMs
        if (this.coachingMs >= FORCE_AFTER_S * 1000) this.forceEarned = true
        if (good) {
          this.adjustMs = 0
          this.holdMs += dtMs
          this.holdFrames.push({ frame: frame as NonNullable<Frame>, t: tMs })
          if (this.holdMs >= HOLD_S * 1000) this.startCapture(false)
        } else {
          this.adjustMs += dtMs
          if (this.adjustMs > BREAK_S * 1000) this.toCoaching()
        }
        break

      case 'capturing':
        this.captureMs += dtMs
        if (!good && !this.forced) {
          this.wobbled = true
          this.adjustMs += dtMs
          if (this.adjustMs > BREAK_S * 1000) {
            this.toCoaching()
            break
          }
        } else {
          this.adjustMs = 0
        }
        // only frames judged good join the baseline (a forced capture keeps them all); the
        // windowed verdict lags a sudden movement, so buildBaseline also drops the few
        // frames that are far off the capture's own robust centre
        if (good || this.forced) this.captured.push({ frame: frame as NonNullable<Frame>, t: tMs })
        this.checkCaptureDone()
        break
    }
    return this.state
  }

  /**
   * Save the current posture anyway (verified = false). Allowed when `canForce`: from
   * coaching/holding it runs a forced capture; from an unforced capture it turns that
   * capture into a forced one; from 'reviewing' it saves the pending baseline unverified.
   * Returns false when not allowed right now.
   */
  force(): boolean {
    if (!this.canForce) return false
    if (this.phase === 'reviewing') {
      if (this.result) this.result = { ...this.result, verified: false }
      this.forced = true
      this.phase = 'done'
      return true
    }
    if (this.phase === 'capturing') {
      this.forced = true
      this.adjustMs = 0
      return true
    }
    this.startCapture(true)
    return true
  }

  /** Back to 'searching' with a fresh capture (after 'failed', or to start over). */
  restart(): void {
    this.phase = 'searching'
    this.captured = []
    this.holdFrames = []
    this.holdCount = 0
    this.result = null
    this.resultUnverified = []
    this.failReason = null
    this.forced = false
    this.adjustMs = 0
    this.holdMs = 0
    this.captureMs = 0
    this.wobbled = false
    this.wobbleRetries = 0
    this.goodRun = 0
    this.retryBlockMs = 0
    this.autoRejections = 0
    this.reviewInstruction = null
    this.unverifiedMs = 0
    this.unverifiedBreakMs = 0
    this.localOnly = false
    this.examInstruction = null
  }

  /** The external review confirmed the posture: the pending baseline becomes final (verified). */
  acceptReview(): void {
    if (this.phase !== 'reviewing') return
    this.phase = 'done'
    this.resultUnverified = []
    this.reviewInstruction = null
  }

  /** The external review rejected the posture: back to coaching with its instruction. */
  rejectReview(instruction: string): void {
    if (this.phase !== 'reviewing') return
    this.rejections++
    this.autoRejections++
    this.reviewInstruction = instruction.trim() || null
    this.result = null
    this.resultUnverified = []
    this.toCoaching()
    // give the user time to act on the instruction before the next capture and review
    this.retryBlockMs = REVIEW_RETRY_S * 1000
  }

  /**
   * The review could not run (offline, no AI connection, error, or the user skipped it): the
   * local judge decides. When it verified every essential check, the pending baseline is
   * saved (done, verified). Otherwise nothing is saved: the session goes back to coaching
   * without a reviewer (until restart()), says how to make the posture checkable, and offers
   * "Save this posture anyway" (canForce) right away.
   */
  skipReview(): void {
    if (this.phase !== 'reviewing' || !this.result) return
    if (this.resultUnverified.length === 0) {
      this.result = { ...this.result, verified: true }
      this.phase = 'done'
      return
    }
    this.localOnly = true
    this.forceEarned = true
    this.result = null
    this.resultUnverified = []
    this.toCoaching()
  }

  // -------------------------------------------------------------------------

  private liveEstimator(): UpEstimator {
    return this.hipCheck.trusted ? this.upEst : this.upEstNoHips
  }

  private liveUp(): UpEstimate {
    return this.liveEstimator().estimate
  }

  private instruction(): string | null {
    switch (this.phase) {
      case 'failed':
        return this.failReason ? FAIL_MESSAGES[this.failReason] : null
      case 'searching':
        return this.assessment.byId.inView.instruction
      case 'reviewing':
      case 'done':
        return null
      default:
        // what the user is doing right now comes first; then what keeps a good posture from
        // being verified on this camera (no reviewer); the reviewer's advice otherwise
        return (
          this.assessment.primary?.instruction ??
          (this.needsVerification ? this.assessment.viewInstruction : null) ??
          this.examInstruction ??
          this.reviewInstruction ??
          null
        )
    }
  }

  private notice(): string | null {
    if (this.phase !== 'done' || !this.result || this.result.verified || this.forced) return null
    for (const id of this.resultUnverified) {
      const msg = UNVERIFIED_NOTICE[id]
      if (msg) return msg
    }
    return null
  }

  private toHolding(): void {
    this.phase = 'holding'
    this.holdFrames = []
    this.holdMs = 0
    this.adjustMs = 0
  }

  private startCapture(forced: boolean): void {
    this.phase = 'capturing'
    this.forced = forced
    // the hold already verified this posture as good: its frames join the baseline
    this.captured = forced ? [] : this.holdFrames
    this.holdCount = this.captured.length
    this.holdFrames = []
    this.captureMs = 0
    this.adjustMs = 0
    this.wobbled = false
    this.holdMs = HOLD_S * 1000
    this.reviewInstruction = null
    this.examInstruction = null
  }

  private toCoaching(): void {
    this.phase = 'coaching'
    this.captured = []
    this.holdFrames = []
    this.holdCount = 0
    this.captureMs = 0
    this.holdMs = 0
    this.adjustMs = 0
    this.wobbled = false
    this.forced = false
  }

  private toSearching(): void {
    this.toCoaching()
    this.phase = 'searching'
  }

  private checkCaptureDone(): void {
    const enough = this.captured.length - this.holdCount >= SETUP_MIN_FRAMES
    if (this.captureMs >= CAPTURE_S * 1000 && enough) this.finishCapture()
    else if (this.captureMs >= CAPTURE_MAX_S * 1000) this.fail('lost')
  }

  private finishCapture(): void {
    const res = buildBaseline(this.captured.map((c) => c.frame), {
      verified: !this.forced,
      capturedAt: this.opts.now(),
      cameraDeviceId: this.opts.cameraDeviceId
    })
    if (!res.ok) {
      // a stability failure right after a tolerated wobble is that wobble, not a user
      // who cannot hold still: coach again instead of failing
      if (res.reason === 'unstable' && this.wobbled && !this.forced && this.wobbleRetries < MAX_WOBBLE_RETRIES) {
        this.wobbleRetries++
        this.toCoaching()
      } else this.fail(res.reason)
      return
    }
    // final exam: the captured posture's robust average judged without the hold slack. An
    // essential check (back, head) that needs adjusting means the live window let noise or the
    // hold's widened tolerances through: coach again. (The lateral checks and the gaze keep
    // the hold's verdict: a borderline lateral reading — a rolled camera reads as one — must
    // not loop captures.)
    const exam = res.assessment
    const essentialAdjust = exam.checks.find((c) => c.status === 'adjust' && ESSENTIAL_CHECKS.includes(c.id))
    if (!this.forced && essentialAdjust) {
      this.examInstruction = essentialAdjust.instruction
      this.toCoaching()
      return
    }
    const verifiedHere = res.unverified.length === 0
    const review = this.reviewer && (this.opts.review === true || (this.opts.review === 'auto' && !verifiedHere))
    this.resultUnverified = this.forced ? [] : res.unverified
    if (review && !this.forced) {
      // pending: becomes final (verified) on acceptReview()
      this.result = res.baseline
      this.phase = 'reviewing'
      return
    }
    if (!this.forced && !verifiedHere) {
      // an essential check is not verifiable from this camera and there is nobody to ask:
      // never saved on its own — coach (the live assessment says how to make it checkable)
      this.resultUnverified = []
      this.toCoaching()
      return
    }
    // the local judge verified the posture (or the user forced it: verified = false)
    this.result = { ...res.baseline, verified: res.baseline.verified && verifiedHere }
    this.phase = 'done'
    this.wobbleRetries = 0
    this.reviewInstruction = null
  }

  private fail(reason: SetupFailReason): void {
    this.phase = 'failed'
    this.failReason = reason
    this.captured = []
    this.result = null
  }
}

// ---------------------------------------------------------------------------
// baseline building

export type BuildResult =
  | {
      ok: true
      baseline: CalibrationBaseline
      /** checks the local judge could not verify for this posture from this camera */
      unverified: CheckId[]
      /**
       * The captured posture judged once more ("final exam"): its robust average over every
       * captured frame, with the baseline's own gravity and no hold slack. Far less noisy than
       * the live 1 s window, so a posture that only slipped through it on noise (or on the
       * hold's widened tolerances) is caught here.
       */
      assessment: PostureAssessment
    }
  | { ok: false; reason: SetupFailReason }

export interface BuildOptions {
  verified: boolean
  capturedAt: number
  cameraDeviceId: string | null
}

/**
 * §7: average gravity over the captured frames (refined by the captured trunk where its pitch
 * was not observed, refineUpWithTrunk), re-extract every frame with that
 * fixed `up`, and store a robust average (20%-trimmed mean) of every feature. A
 * nullable feature is stored as null when it was available in fewer than half of the
 * frames. Hips that look hallucinated over the capture are ignored throughout (and
 * so, at runtime, too: the engine follows the baseline's use of the hips).
 */
export function buildBaseline(frames: readonly Frame[], opts: BuildOptions): BuildResult {
  // one verdict over the whole capture (no hysteresis): the median twist of all its frames
  const hipCheck = new HipConsistency(Math.max(1, frames.length), false)
  for (const fr of frames) hipCheck.push(fr)
  const hips = hipCheck.trusted
  const est = new UpEstimator()
  for (const fr of frames) est.push(fr, { hips })
  const measured = est.estimate
  const extractAll = (up: Vec3): PostureFeatures[] => {
    const out: PostureFeatures[] = []
    for (const fr of frames) {
      const f = extractFeatures(fr, { up, upSource: measured.source, hips })
      if (f) out.push(f)
    }
    return out
  }
  let feats = extractAll(measured.up)
  if (feats.length < SETUP_MIN_FRAMES) return { ok: false, reason: 'lost' }
  const up = { ...measured, up: refineUpWithTrunk(measured, est.pitchWeight, feats) }
  if (up.up !== measured.up) feats = extractAll(up.up)
  if (feats.length < SETUP_MIN_FRAMES) return { ok: false, reason: 'lost' }
  // a brief movement (a wobble the live judgement tolerated) leaves a few frames far off
  // the rest: leave them out of the stability check and the baseline. A user who keeps
  // moving spreads every frame, which this does not hide.
  const inliers = dropOutliers(feats)
  if (inliers.length >= Math.max(SETUP_MIN_FRAMES, feats.length * (1 - OUTLIER_MAX_FRACTION))) feats = inliers
  const withScale = feats.filter((f) => f.ppm !== null && f.anchor !== null)
  if (withScale.length < feats.length / 2) return { ok: false, reason: 'lost' }

  if (!isStable(feats, withScale)) return { ok: false, reason: 'unstable' }

  const m = medianFeatures(feats, trimmedMean)
  const forward = unit(sumVec(feats.map((f) => f.forward))) ?? feats[feats.length - 1].forward
  const anchor: Vec3 = [
    trimmedMean(withScale.map((f) => (f.anchor as Vec3)[0])),
    trimmedMean(withScale.map((f) => (f.anchor as Vec3)[1])),
    trimmedMean(withScale.map((f) => (f.anchor as Vec3)[2]))
  ]
  const view: ViewInfo = m.view
  const baseline: PostureBaseline = {
    version: 2,
    capturedAt: opts.capturedAt,
    cameraDeviceId: opts.cameraDeviceId,
    up: up.up,
    upSource: up.source as UpSource,
    forward,
    view: { kind: view.kind, yawDeg: view.yawDeg, elevationDeg: view.elevationDeg },
    verified: opts.verified,
    neckFwd: m.neckFwd,
    neckLat: m.neckLat,
    ...(m.neckLat !== null && m.neckLatRef !== null ? { neckLatRef: m.neckLatRef } : {}),
    headPitch: m.headPitch,
    headRollRel: m.headRollRel,
    shoulderTilt: m.shoulderTilt,
    trunkFwd: m.trunkFwd,
    neckOnTrunk: m.neckOnTrunk ?? null,
    headOnTrunk: m.headOnTrunk ?? null,
    trunkLat: m.trunkLat,
    torsoLen: m.torsoLen,
    neckH: view.yawDeg < NECK_DROP_MAX_YAW ? m.neckH : null,
    ppm: trimmedMean(withScale.map((f) => f.ppm as number)),
    anchor
  }
  const assessment = assessPosture(m, up.source, { levelUnconfirmed: !est.levelConsistent })
  return { ok: true, baseline, unverified: assessment.unverified, assessment }
}

/**
 * Without thigh gravity the camera's pitch may be unobservable and then leaks into the
 * engine's position metrics (drop / toward-the-screen). The capture happens only after the
 * posture was judged good, so the captured trunk is the best available sagittal gravity cue:
 * the camera pitch that best aligns `up` with the median trunk (the pitch of `up` rotated
 * about the body's left axis by the median trunkFwd) supplies the part of the pitch the
 * estimate did not observe (1 − pitchWeight: all of it for camera-only gravity or a hip line
 * facing the camera, none for a turned hip line whose perspective gave it). Not in a
 * near-profile view (there the pitch barely matters and the trunk lean was judged). Only the
 * pitch changes and the camera stays level (roll 0): a rotation about a turned body's left
 * axis would also roll the camera — a trunk leaning 10° at capture rolled a 45°-turned body's
 * up by 7°, drawn as a tilted true vertical at runtime. See Implementation notes in
 * docs/specs/detection.md.
 */
function refineUpWithTrunk(measured: UpEstimate, pitchWeight: number, feats: PostureFeatures[]): Vec3 {
  if (measured.source === 'body' || !(pitchWeight < 1)) return measured.up
  const yaw = median(feats.map((f) => f.view.opticalYawDeg))
  if (yaw >= SIDE_VIEW_YAW && yaw <= SIDE_VIEW_YAW_MAX) return measured.up
  const trunk = feats.filter((f) => f.trunkFwd !== null)
  if (trunk.length * 2 < feats.length) return measured.up
  const t = median(trunk.map((f) => f.trunkFwd as number))
  if (!(Math.abs(t) <= UP_MAX_TILT)) return measured.up
  const F = unit(sumVec(trunk.map((f) => f.forward)))
  if (!F) return measured.up
  const r = t * (Math.PI / 180)
  const towardTrunk = unit(add(scale(measured.up, Math.cos(r)), scale(F, Math.sin(r))))
  if (!towardTrunk) return measured.up
  const w = measured.source === 'camera' ? 0 : Math.max(0, pitchWeight)
  return cameraUp(w * cameraPitchDeg(measured.up) + (1 - w) * cameraPitchDeg(towardTrunk))
}

const sumVec = (vs: Vec3[]): Vec3 => vs.reduce<Vec3>((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0])

type NumKey =
  | 'headPitch'
  | 'headRollRel'
  | 'shoulderTilt'
  | 'trunkFwd'
  | 'neckOnTrunk'
  | 'headOnTrunk'
  | 'trunkLat'
  | 'torsoLen'
  | 'ppm'
  | 'neckH'
const NULLABLE_KEYS: NumKey[] = [
  'headPitch',
  'headRollRel',
  'shoulderTilt',
  'trunkFwd',
  'neckOnTrunk',
  'headOnTrunk',
  'trunkLat',
  'torsoLen',
  'ppm',
  'neckH'
]
/** optional feature fields: left out (undefined) when no frame has them */
const OPTIONAL_KEYS: ReadonlySet<NumKey> = new Set<NumKey>(['neckOnTrunk', 'headOnTrunk'])

/**
 * Element-wise robust summary of several frames' features: medians of every
 * number (null when available in fewer than half the frames); vectors and the
 * visibility summary come from the latest frame, the view from the median yaw.
 * neckLat averages only the frames measured against the majority reference.
 */
export function medianFeatures(
  list: readonly PostureFeatures[],
  center: (values: readonly number[]) => number = median
): PostureFeatures {
  const last = list[list.length - 1]
  if (list.length === 1) return last
  const med = (k: NumKey): number | null => {
    const vals = list.map((f) => f[k]).filter((v): v is number => typeof v === 'number')
    return vals.length * 2 >= list.length && vals.length > 0 ? center(vals) : null
  }
  const yaw = median(list.map((f) => f.view.yawDeg))
  const out: PostureFeatures = {
    ...last,
    neckFwd: center(list.map((f) => f.neckFwd)),
    view: {
      yawDeg: yaw,
      elevationDeg: median(list.map((f) => f.view.elevationDeg)),
      opticalYawDeg: median(list.map((f) => f.view.opticalYawDeg)),
      kind: yaw < VIEW_FRONT_MAX_YAW ? 'front' : yaw < VIEW_ANGLED_MAX_YAW ? 'angled' : 'side'
    }
  }
  for (const k of NULLABLE_KEYS) {
    if (OPTIONAL_KEYS.has(k) && list.every((f) => f[k] === undefined)) continue
    ;(out as unknown as Record<NumKey, number | null>)[k] = med(k)
  }
  // the head-on-trunk angles: the angle of the component-wise centre of their vectors (the
  // angle of a short, noisy vector is skewed and heavy-tailed; its components are not)
  const vecCenter = (key: 'neckOnTrunkVec' | 'headOnTrunkVec'): readonly [number, number] | null => {
    const vs = list.map((f) => f[key]).filter((v): v is readonly [number, number] => Array.isArray(v))
    if (vs.length === 0 || vs.length * 2 < list.length) return null
    return [center(vs.map((v) => v[0])), center(vs.map((v) => v[1]))]
  }
  if (list.some((f) => f.neckOnTrunkVec !== undefined)) {
    const v = vecCenter('neckOnTrunkVec')
    out.neckOnTrunkVec = v
    if (v) out.neckOnTrunk = neckOnTrunkAngle(v)
  }
  if (list.some((f) => f.headOnTrunkVec !== undefined)) {
    const v = vecCenter('headOnTrunkVec')
    out.headOnTrunkVec = v
    if (v) out.headOnTrunk = headOnTrunkAngle(v)
  }
  // neckLat: never average a trunk-relative angle with a gravity-referenced one
  const byRef = (r: NeckLatRef): number[] =>
    list.filter((f) => f.neckLat !== null && f.neckLatRef === r).map((f) => f.neckLat as number)
  const trunk = byRef('trunk')
  const gravity = byRef('gravity')
  const ref: NeckLatRef = trunk.length >= gravity.length ? 'trunk' : 'gravity'
  const vals = ref === 'trunk' ? trunk : gravity
  const ok = vals.length > 0 && vals.length * 2 >= list.length
  out.neckLat = ok ? center(vals) : null
  out.neckLatRef = ok ? ref : null
  return out
}

/** at most this fraction of a capture may be left out as a brief movement */
const OUTLIER_MAX_FRACTION = 0.25
/** a frame is a brief-movement outlier beyond this many robust σ (plus a small floor) */
const OUTLIER_SIGMAS = 4

/**
 * Frames whose neck angle or (image-plane) anchor is far from the capture's median:
 * |x − median| > OUTLIER_SIGMAS · 1.4826 · MAD + floor (2° / 1 cm). Sensor noise
 * practically never gets that far; a sudden excursion does.
 */
function dropOutliers(feats: PostureFeatures[]): PostureFeatures[] {
  const far = (xs: number[], floor: number): boolean[] => {
    const m = median(xs)
    const sd = 1.4826 * median(xs.map((x) => Math.abs(x - m)))
    return xs.map((x) => Math.abs(x - m) > OUTLIER_SIGMAS * sd + floor)
  }
  const neck = far(feats.map((f) => f.neckFwd), 2)
  // anchor in the image plane at the median scale (as in isStable)
  const idx = feats.map((f, i) => (f.ppm !== null && f.anchor !== null ? i : -1)).filter((i) => i >= 0)
  const ppm = median(idx.map((i) => feats[i].ppm as number))
  const at = (k: 0 | 1): number[] => idx.map((i) => (feats[i].anchor as Vec3)[k] * ((feats[i].ppm as number) / ppm))
  const ax = far(at(0), 0.01)
  const ay = far(at(1), 0.01)
  const out = new Set<number>()
  idx.forEach((i, j) => {
    if (ax[j] || ay[j]) out.add(i)
  })
  return feats.filter((_, i) => !neck[i] && !out.has(i))
}

/**
 * §7 stability, noise-corrected: the motion variance of a series is its variance
 * minus the frame-to-frame (sensor) noise variance, var(Δx)/2. The capture is
 * unstable when that motion clearly exceeds the limit — the allowance grows with
 * the measured noise so sensor jitter alone never fails a capture of a still user.
 */
function isStable(feats: PostureFeatures[], withScale: PostureFeatures[]): boolean {
  if (motionVar(feats.map((f) => f.neckFwd)) > allowance(STABLE_NECK_DEG, feats.map((f) => f.neckFwd))) return false
  // anchor stability in the image plane, metres at the body (depth is scale noise)
  const ppm = median(withScale.map((f) => f.ppm as number))
  const xs: number[] = []
  const ys: number[] = []
  for (const f of withScale) {
    // X = u·Z/f = u/ppm_frame; rescale to the median ppm so scale jitter does not count as motion
    const k = (f.ppm as number) / ppm
    xs.push((f.anchor as Vec3)[0] * k)
    ys.push((f.anchor as Vec3)[1] * k)
  }
  const mv = motionVar(xs) + motionVar(ys)
  const lim = STABLE_ANCHOR_M * STABLE_ANCHOR_M + (STABLE_NOISE_K * (noiseVar(xs) + noiseVar(ys))) / Math.sqrt(xs.length)
  return mv <= lim
}

/**
 * Robust variance: the variance of the central 80% of the values, divided by the
 * variance of a 10%/10%-truncated standard normal (0.4377) so it estimates σ² for
 * Gaussian data. A brief tolerated wobble (< 10% of the frames) cannot dominate it,
 * unlike a plain variance, while it stays far more efficient than a MAD.
 */
function variance(xs: readonly number[]): number {
  if (xs.length < 3) return 0
  const s = [...xs].sort((a, b) => a - b)
  const k = Math.floor(s.length * 0.1)
  const mid = s.slice(k, s.length - k)
  const m = mid.reduce((a, b) => a + b, 0) / mid.length
  return mid.reduce((a, b) => a + (b - m) * (b - m), 0) / (mid.length - 1) / TRIMMED_NORMAL_VAR
}
const TRIMMED_NORMAL_VAR = 0.4377

/** Frame-to-frame (sensor) noise variance: var(Δx)/2, robustly. */
function noiseVar(xs: readonly number[]): number {
  if (xs.length < 4) return 0
  return variance(xs.slice(1).map((v, i) => v - xs[i])) / 2
}

const motionVar = (xs: readonly number[]): number => Math.max(0, variance(xs) - noiseVar(xs))

/**
 * limit² plus a sampling allowance: with pure sensor noise, var − noiseVar has a
 * standard error of ≈ 1.4·noiseVar/√n, so STABLE_NOISE_K/√n·noiseVar ≈ 3.5 SE.
 */
const allowance = (limit: number, xs: readonly number[]): number =>
  limit * limit + (STABLE_NOISE_K * noiseVar(xs)) / Math.sqrt(Math.max(1, xs.length))
