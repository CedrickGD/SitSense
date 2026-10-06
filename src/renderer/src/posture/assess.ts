// AI posture assessment (docs/specs/detection.md §4 and §4a "Posture judge v3"). Pure.
//
// Judges one (preferably time-smoothed) PostureFeatures against ergonomic norms and returns
// per-check verdicts with one concrete instruction each.
//
// Two kinds of evidence:
// - absolute (gravity-referenced) sagittal angles — trunk lean, neck, gaze. They are only
//   trustworthy with thigh gravity or in a near-profile view; elsewhere the camera's unknown
//   pitch leaks into them one-for-one (∝ |cos yaw|).
// - body-relative (gravity-free) angles of the head on the trunk (features' neckOnTrunk ≈
//   neckFwd − trunkFwd, headOnTrunk ≈ headPitch − trunkFwd), measured in the body's own
//   sagittal plane: any camera tilt cancels exactly. They need the trunk (a hip) in view.
//   Someone lying back in the chair who keeps the eyes on the screen must tip the head far
//   forward on the trunk; someone leaning in tips it back.
//
// A check is 'good', 'adjust' (with one instruction) or 'unknown'. The essential checks —
// trunk lean and head over shoulders — that cannot be verified from the current view are
// listed in `unverified` (with `viewInstruction`, how to make them checkable); `verified` is
// false then. Relative evidence can show that a posture is bad; only absolute evidence (or the
// cloud review) can confirm that it is good.

import type { UpSource } from '@shared/posture'
import {
  ASSESS,
  K_LATERAL,
  K_SAGITTAL,
  LEAN_IN_GAZE_REL,
  LYING_HEAD_ON_TRUNK,
  LYING_HEAD_ON_TRUNK_CONFIRMED,
  LYING_NECK_REL_MIN,
  LYING_TRUNK_ABS,
  LYING_TRUNK_MAX,
  SIDE_VIEW_YAW,
  SIDE_VIEW_YAW_MAX,
  VERIFY_HEAD_ON_TRUNK_MIN,
  VERIFY_HEAD_ON_TRUNK_PER_DEG
} from './constants'
import type { PostureFeatures, Side } from './types'

export const CHECK_IDS = [
  'inView',
  'trunkUpright',
  'headOverShoulders',
  'sideLean',
  'shouldersLevel',
  'headLevel',
  'gaze'
] as const
/** Stable check ids, in priority order (the first 'adjust' becomes the primary instruction). */
export type CheckId = (typeof CHECK_IDS)[number]

/** Short human labels for a checklist UI. */
export const CHECK_LABELS: Record<CheckId, string> = {
  inView: 'In view',
  trunkUpright: 'Upright back',
  headOverShoulders: 'Head over shoulders',
  sideLean: 'Centered weight',
  shouldersLevel: 'Level shoulders',
  headLevel: 'Level head',
  gaze: 'Comfortable gaze'
}

/** The checks a good posture must pass: setup never confirms a posture without them. */
export const ESSENTIAL_CHECKS: readonly CheckId[] = ['trunkUpright', 'headOverShoulders']

export type CheckStatus = 'good' | 'adjust' | 'unknown'

/** Which way the person is off (their own left/right for lateral checks). */
export type CheckDirection = Side | 'forward' | 'back' | 'up' | 'down'

/**
 * What a verdict rests on: 'absolute' = a gravity-referenced angle; 'relative' = the head's
 * angle on the trunk (gravity-free); 'estimate' = an absolute angle measured against a gravity
 * the camera could not confirm (assumes a roughly level camera).
 */
export type CheckBasis = 'absolute' | 'relative' | 'estimate'

export interface PostureCheck {
  id: CheckId
  label: string
  status: CheckStatus
  /** one concrete instruction when status is 'adjust', else null */
  instruction: string | null
  /** the measured value the verdict was based on (deg), null when unknown */
  value: number | null
  direction?: CheckDirection
  /** why a check is 'unknown' (for tooltips / debugging) */
  reason?: string
  /** what the verdict rests on (absent while unknown) */
  basis?: CheckBasis
  /**
   * For an essential check that is 'unknown' (listed in `unverified`): one concrete instruction
   * that makes it checkable (show the hips, sit tall and place the camera to the side).
   */
  viewInstruction?: string
}

export interface PostureAssessment {
  /** all checks in priority order */
  checks: PostureCheck[]
  byId: Record<CheckId, PostureCheck>
  /** highest-priority check that needs adjusting, null when none */
  primary: PostureCheck | null
  /** in view and no check is 'adjust' ('unknown' checks do not count) */
  allGood: boolean
  /**
   * allGood AND every essential check (ESSENTIAL_CHECKS) was verified from this view: the local
   * judge confirms the posture on its own. Without a reviewer, setup only saves a verified posture.
   */
  verified: boolean
  /**
   * 'strong' = absolute (gravity-referenced) sagittal angles are judged from any view
   * (thigh-based gravity, within the tolerance its ±10–15° thigh-slope error needs).
   * 'weak' = the camera's tilt is unknown: trunk inclination is judged only in a
   * near-profile view, and head checks are made relative to the trunk when it is visible.
   */
  gravity: 'strong' | 'weak'
  /** head checks were judged relative to the trunk (weak gravity outside a near-profile view, trunk visible) */
  headRelativeToTrunk: boolean
  /**
   * Essential checks the local judge could not make for this posture from this camera: the
   * trunk lean (no hip in view, or neither thigh gravity nor a near-profile view) and the head
   * (neither the trunk nor a gravity reference). They are 'unknown'; a posture that relies on
   * them is not `verified` — the cloud review (or the user, knowingly) has to confirm it.
   */
  unverified: CheckId[]
  /** the first unverified check's viewInstruction (null when everything essential was checked) */
  viewInstruction: string | null
  /**
   * The head's angles on the trunk (deg; gravity-free; null without a hip in view):
   * neck = neckFwd − trunkFwd (ears ahead of the trunk line), gaze = headPitch − trunkFwd.
   */
  headOnTrunk: { neck: number | null; gaze: number | null }
}

export const INSTRUCTIONS = {
  inView: 'Move so your head and at least one shoulder are in the picture.',
  trunkForward: 'Sit back — let your back rest against the chair.',
  trunkBack: "Sit up a little — you're leaning far back.",
  lying: "Slide your hips back and sit up tall — you're lying in the chair.",
  headForward: 'Bring your head back until your ears sit over your shoulders.',
  sideLean: (side: Side): string => `You're leaning to your ${side} — center your weight on both hips.`,
  shoulderRaised: (side: Side): string => `Your ${side} shoulder is raised — let it drop and relax.`,
  headTilt: (side: Side): string => `Straighten your head — it's tilted toward your ${side}.`,
  gazeDown: 'Lift your gaze a little — if your screen sits low, raise it.',
  gazeUp: 'Lower your chin slightly.',
  /** the hips are outside the picture, and with them in view this camera could check the back */
  showHips: 'Tilt the camera down a little so your hips are in the picture — SitSense needs them to check your back.',
  /**
   * the hips are outside the picture, but even with them this view could not check the back (no
   * thigh gravity, not a near profile): they only make the head position checkable
   */
  showHipsForHead:
    'Tilt the camera down a little so your hips are in the picture — SitSense needs them to check your head position.',
  /** the hips are in the picture but hidden (a desk) or not usable */
  hipsHidden: "Sit tall against your backrest — your hips are hidden, so SitSense can't check your back from this camera.",
  /** the trunk reads upright, but the head on the trunk says it leans in (or the eyes look up) */
  sitBackLookAhead: 'Sit back against your backrest and look at the middle of your screen.',
  /** the trunk's lean cannot be judged from this direction: a frontal view */
  backFromFront: "Sit tall against your backrest — SitSense can't judge your back angle from straight in front.",
  /** …an angled (or not-quite-profile) view: neither frontal nor near enough to the side */
  backFromAngle: "Sit tall against your backrest — SitSense can't judge your back angle from this camera angle.",
  /**
   * the hip line contradicts a level camera (rolled, or hips that are not real): the camera's
   * roll leaks into the back and neck angles, so neither is confirmed
   */
  levelCamera:
    "Sit tall against your backrest and straighten the camera — it looks tilted, so SitSense can't confirm your back angle."
} as const

const R_WEAK_TRUNK = 'camera tilt unknown from this view — trunk lean cannot be judged absolutely'
const R_NO_HIPS = 'hips not in view'
const R_HIPS_HIDDEN = 'hips hidden or not usable'
const R_DISAGREE = 'the head tips back on the trunk as when leaning in — the back angle cannot be confirmed'
const R_HEAD_NO_REF = 'camera tilt unknown and the trunk not in view — the neck angle cannot be checked'
const R_ROLL = 'camera roll unknown without the hips in view'
const R_LEVEL = 'the hips do not confirm a level camera — the absolute horizontal cannot be judged'
const R_LEVEL_SAGITTAL = 'the hips do not confirm a level camera — its roll may leak into this angle'
const R_MARGIN = 'within the allowance for an imprecise gravity reference, but past the ergonomic limit — not confirmed'
const R_LYING_DISAGREE = 'the head tips far forward on the trunk as when lying back — the back angle cannot be confirmed'

function check(
  id: CheckId,
  status: CheckStatus,
  value: number | null,
  instruction: string | null = null,
  direction?: CheckDirection,
  reason?: string,
  basis?: CheckBasis
): PostureCheck {
  return {
    id,
    label: CHECK_LABELS[id],
    status,
    instruction: status === 'adjust' ? instruction : null,
    value,
    ...(direction ? { direction } : {}),
    ...(status === 'unknown' && reason ? { reason } : {}),
    ...(status !== 'unknown' && basis ? { basis } : {})
  }
}

const unknown = (id: CheckId, reason: string, viewInstruction?: string): PostureCheck => ({
  ...check(id, 'unknown', null, null, undefined, reason),
  ...(viewInstruction ? { viewInstruction } : {})
})

/**
 * Judge a posture. `upSource` defaults to the features' own source.
 *
 * Tolerances (§4 and the Implementation notes): the upper sagittal limits × k (1.3 with
 * thigh gravity — thighs are only roughly level —, in a near-profile view, for head
 * checks relative to the trunk, or with hips gravity; 1.6 with camera gravity); lateral
 * limits × k (1.0, or 1.4 with camera gravity). The lower limits (reclined −25°, chin
 * up −15°) are fixed: k models how far an unknown tilt can push a reading forward, not
 * a licence to recline further. `slack` (hold hysteresis) widens every limit.
 *
 * The widened sagittal limits only decide what is COACHED: an absolute trunk or neck reading
 * between the ergonomic limit and its widened one is 'unknown' (not confirmed) — k models the
 * reference's error, which can hide a slump as easily as it can fake one. Only a reading within
 * the plain limit (× slack) confirms a posture, and only while the hip line agrees with a level
 * camera (`levelUnconfirmed` leaves both absolute sagittal checks unconfirmed).
 */
export interface AssessOptions {
  /**
   * Widen every tolerance by this factor (default 1). The setup session uses
   * ASSESS_HOLD_SLACK while holding/capturing so noise cannot flicker a check
   * that was just judged good (Schmitt-trigger hysteresis).
   */
  slack?: number
  /**
   * The hip line contradicts a level camera (UpEstimator.levelConsistent false: a camera
   * rolled past the level-mount prior, or hallucinated hips). The gravity estimate keeps the
   * camera level, so the shoulders' tilt against gravity (shouldersLevel) is 'unknown'
   * rather than coached on a possibly rolled horizontal. Default false.
   */
  levelUnconfirmed?: boolean
  /**
   * The optical yaw (deg) from which a view counts as near-profile (default SIDE_VIEW_YAW). The
   * setup session lowers it by SIDE_VIEW_YAW_HYST while holding/capturing — and for the final
   * exam of an unforced capture — so a yaw hovering at the limit cannot flip the verdict.
   */
  sideYawMin?: number
}

/** Whether an optical yaw (deg) is a near-profile view (see AssessOptions.sideYawMin). */
export const isSideYaw = (yaw: number, sideYawMin: number = SIDE_VIEW_YAW): boolean =>
  yaw >= sideYawMin && yaw <= SIDE_VIEW_YAW_MAX

export function assessPosture(
  f: PostureFeatures | null,
  upSource?: UpSource,
  opts: AssessOptions = {}
): PostureAssessment {
  if (f === null) {
    const checks = CHECK_IDS.map((id) =>
      id === 'inView'
        ? check('inView', 'adjust', null, INSTRUCTIONS.inView)
        : unknown(id, 'not in view')
    )
    return finish(checks, 'weak')
  }
  const src: UpSource = upSource ?? f.upSource
  // thigh-based gravity: absolute sagittal angles are trustworthy from any view
  const strong = src === 'body'
  // near-profile: camera pitch barely leaks into sagittal angles (roll still does). Only
  // close to 90°: from behind the profile the leak grows as |cos yaw| again. Judged on the
  // optical-axis yaw, which a lean of the user does not shift
  const yaw = f.view.opticalYawDeg
  const side = isSideYaw(yaw, opts.sideYawMin)
  // gravity-referenced sagittal angles can be trusted (thigh gravity or a near-profile view)
  const absolute = strong || side
  const slack = opts.slack ?? 1
  const kLat = K_LATERAL[src] * slack
  const kAbs = slack * (strong ? K_SAGITTAL.body : K_SAGITTAL.side)
  const kRel = slack * K_SAGITTAL.relative

  // the head's angles on the trunk: gravity-free, measured in the body's own sagittal plane
  // (features.ts). Hand-built features without them fall back to the differences of the
  // gravity-referenced angles (where a sagittal camera tilt cancels as well)
  const trunk = f.trunkFwd
  const neckRel = f.neckOnTrunk !== undefined ? f.neckOnTrunk : trunk !== null ? f.neckFwd - trunk : null
  const gazeRel =
    f.headOnTrunk !== undefined ? f.headOnTrunk : trunk !== null && f.headPitch !== null ? f.headPitch - trunk : null
  // without an absolute reference, the head checks are judged on the trunk when it is visible
  const relative = !absolute && trunk !== null
  const kHead = slack * (strong ? K_SAGITTAL.body : relative ? K_SAGITTAL.relative : side ? K_SAGITTAL.side : K_SAGITTAL[src === 'hips' ? 'hips' : 'camera'])

  const checks: PostureCheck[] = [check('inView', 'good', null)]
  const unverified: CheckId[] = []
  // without a usable hip: in the picture but hidden (a desk) or judged hallucinated, or outside it
  const hipsHidden = (f.vis.hipsInFrame ?? 0) > 0
  // with the hips in view, could this camera check the back? Only with thigh gravity (knees in
  // view, or already in use) or a near-profile view; elsewhere showing them only makes the head
  // checkable (on the trunk), and "needs them to check your back" would send the user to move
  // the camera for nothing
  const hipsWouldVerifyBack = strong || side || f.vis.knees > 0
  // the back's lean cannot be judged from this direction: say which (the view, not the posture)
  const noBackInstruction = f.view.kind === 'front' ? INSTRUCTIONS.backFromFront : INSTRUCTIONS.backFromAngle
  const trunkNoHipsInstruction = hipsHidden
    ? INSTRUCTIONS.hipsHidden
    : hipsWouldVerifyBack
      ? INSTRUCTIONS.showHips
      : noBackInstruction
  const headNoHipsInstruction = hipsHidden
    ? INSTRUCTIONS.hipsHidden
    : hipsWouldVerifyBack
      ? INSTRUCTIONS.showHips
      : INSTRUCTIONS.showHipsForHead

  // ---- trunkUpright
  // lying in the chair (gravity-free): the eyes stay on the screen, so the head tips far
  // forward on a reclined trunk and the neck cranes forward on it. Where the trunk's absolute
  // lean is known it must also be reclined (else it is a look down at the keyboard: gaze)
  const trunkKnown = absolute && trunk !== null
  const lyingSignature =
    gazeRel !== null &&
    neckRel !== null &&
    neckRel > LYING_NECK_REL_MIN * slack &&
    (trunkKnown
      ? (trunk as number) < LYING_TRUNK_MAX * slack && gazeRel > LYING_HEAD_ON_TRUNK_CONFIRMED * slack
      : gazeRel > LYING_HEAD_ON_TRUNK * slack)
  if (trunkKnown) {
    if (trunk > ASSESS.trunkFwdMax * kAbs) {
      checks.push(check('trunkUpright', 'adjust', trunk, INSTRUCTIONS.trunkForward, 'forward', undefined, 'absolute'))
    } else if (trunk < ASSESS.trunkFwdMin * slack) {
      const lying = lyingSignature || trunk < LYING_TRUNK_ABS * slack
      checks.push(check('trunkUpright', 'adjust', trunk, lying ? INSTRUCTIONS.lying : INSTRUCTIONS.trunkBack, 'back', undefined, 'absolute'))
    } else if (lyingSignature) {
      checks.push(check('trunkUpright', 'adjust', gazeRel, INSTRUCTIONS.lying, 'back', undefined, 'relative'))
    } else if (gazeRel !== null && gazeRel < VERIFY_HEAD_ON_TRUNK_MIN + VERIFY_HEAD_ON_TRUNK_PER_DEG * Math.max(0, trunk) - 10 * (slack - 1)) {
      // the absolute reading looks fine, but the head tips back on the trunk as when leaning
      // in toward the screen: the two disagree, so the back angle is not confirmed. The closer
      // the reading is to the forward limit, the more corroboration it needs (a slump on a seat
      // whose knees point down reads up to ~10° too upright, with the head tipped back on it)
      checks.push(unknown('trunkUpright', R_DISAGREE, INSTRUCTIONS.sitBackLookAhead))
      unverified.push('trunkUpright')
    } else if (opts.levelUnconfirmed) {
      // the hip line contradicts a level camera: its roll leaks into the sagittal angles of a
      // turned body (the gravity estimate keeps the camera level), so the reading is not confirmed
      checks.push(unknown('trunkUpright', R_LEVEL_SAGITTAL, INSTRUCTIONS.levelCamera))
      unverified.push('trunkUpright')
    } else if (gazeRel !== null && neckRel !== null && gazeRel > LYING_HEAD_ON_TRUNK * slack && neckRel > LYING_NECK_REL_MIN * slack) {
      // the mirror of the lean-in disagreement: the absolute reading looks fine, but the head
      // tips as far forward on the trunk as when lying back — not confirmed
      checks.push(unknown('trunkUpright', R_LYING_DISAGREE, INSTRUCTIONS.sitBackLookAhead))
      unverified.push('trunkUpright')
    } else if (trunk > ASSESS.trunkFwdMax * slack) {
      // past the ergonomic limit, within the allowance for the gravity reference's error (a
      // thigh slope, a small camera roll in a profile view): not coached, not confirmed either.
      // The allowance keeps a good posture on a sloped seat from being coached wrongly; it never
      // confirms one
      checks.push(unknown('trunkUpright', R_MARGIN, INSTRUCTIONS.sitBackLookAhead))
      unverified.push('trunkUpright')
    } else {
      checks.push(check('trunkUpright', 'good', trunk, null, undefined, undefined, 'absolute'))
    }
  } else if (lyingSignature) {
    // the trunk's lean is not measurable here, but the head on the trunk shows the recline
    checks.push(check('trunkUpright', 'adjust', gazeRel, INSTRUCTIONS.lying, 'back', undefined, 'relative'))
  } else if (gazeRel !== null && gazeRel < LEAN_IN_GAZE_REL * slack) {
    // the head tips back on the trunk to see the screen: the trunk leans toward it
    checks.push(check('trunkUpright', 'adjust', gazeRel, INSTRUCTIONS.trunkForward, 'forward', undefined, 'relative'))
  } else if (trunk === null) {
    checks.push(unknown('trunkUpright', hipsHidden ? R_HIPS_HIDDEN : R_NO_HIPS, trunkNoHipsInstruction))
    unverified.push('trunkUpright')
  } else {
    checks.push(unknown('trunkUpright', R_WEAK_TRUNK, noBackInstruction))
    unverified.push('trunkUpright')
  }

  // ---- headOverShoulders
  // absolute where gravity can be trusted, else on the trunk when it is visible. (Not on the
  // trunk as well where the absolute angle is known: sitting back 15° with the head stacked
  // over the shoulders flexes the neck 15–30° on the trunk, which is fine; the neck craned on a
  // trunk reclined past that is the lying signature above.)
  {
    const absFail = absolute && f.neckFwd > ASSESS.neckFwdMax * kAbs
    const relFail = !absolute && neckRel !== null && neckRel > ASSESS.neckFwdMax * kRel
    if (absFail || relFail) {
      const v = absFail ? f.neckFwd : (neckRel as number)
      checks.push(check('headOverShoulders', 'adjust', v, INSTRUCTIONS.headForward, 'forward', undefined, absFail ? 'absolute' : 'relative'))
    } else if (absolute && opts.levelUnconfirmed) {
      // (a camera roll leaks into the neck angle as into the trunk's)
      checks.push(unknown('headOverShoulders', R_LEVEL_SAGITTAL, INSTRUCTIONS.levelCamera))
      unverified.push('headOverShoulders')
    } else if (absolute && f.neckFwd > ASSESS.neckFwdMax * slack) {
      // past the ergonomic limit, within the gravity reference's allowance: not confirmed
      checks.push(unknown('headOverShoulders', R_MARGIN, INSTRUCTIONS.headForward))
      unverified.push('headOverShoulders')
    } else if (absolute) {
      checks.push(check('headOverShoulders', 'good', f.neckFwd, null, undefined, undefined, 'absolute'))
    } else if (neckRel !== null) {
      checks.push(check('headOverShoulders', 'good', neckRel, null, undefined, undefined, 'relative'))
    } else if (f.neckFwd > ASSESS.neckFwdMax * slack * K_SAGITTAL[src === 'hips' ? 'hips' : 'camera']) {
      // no gravity reference and no trunk: only a neck far past any plausible camera tilt is
      // called out (it assumes a roughly level camera); anything less cannot be verified
      checks.push(check('headOverShoulders', 'adjust', f.neckFwd, INSTRUCTIONS.headForward, 'forward', undefined, 'estimate'))
    } else {
      checks.push(unknown('headOverShoulders', R_HEAD_NO_REF, headNoHipsInstruction))
      unverified.push('headOverShoulders')
    }
  }

  // ---- sideLean
  if (f.trunkLat === null) checks.push(unknown('sideLean', 'both hips must face the camera'))
  else {
    const v = f.trunkLat
    const side: Side = v > 0 ? 'left' : 'right'
    if (Math.abs(v) > ASSESS.trunkLatMax * kLat) checks.push(check('sideLean', 'adjust', v, INSTRUCTIONS.sideLean(side), side))
    else checks.push(check('sideLean', 'good', v))
  }

  // ---- shouldersLevel
  if (f.shoulderTilt === null) checks.push(unknown('shouldersLevel', 'both shoulders must face the camera'))
  else if (src === 'camera') checks.push(unknown('shouldersLevel', R_ROLL))
  else if (opts.levelUnconfirmed) checks.push(unknown('shouldersLevel', R_LEVEL))
  else {
    const v = f.shoulderTilt
    const higher: Side = v > 0 ? 'left' : 'right'
    if (Math.abs(v) > ASSESS.shoulderTiltMax * kLat)
      checks.push(check('shouldersLevel', 'adjust', v, INSTRUCTIONS.shoulderRaised(higher), higher))
    else checks.push(check('shouldersLevel', 'good', v))
  }

  // ---- headLevel (+ = left ear higher = head tilted toward the right)
  if (f.headRollRel === null) checks.push(unknown('headLevel', 'both ears (or eyes) and shoulders must be visible'))
  else {
    const v = f.headRollRel
    const toward: Side = v > 0 ? 'right' : 'left'
    if (Math.abs(v) > ASSESS.headRollMax * kLat) checks.push(check('headLevel', 'adjust', v, INSTRUCTIONS.headTilt(toward), toward))
    else checks.push(check('headLevel', 'good', v))
  }

  // ---- gaze (not essential: absolute where gravity can be trusted, else on the trunk when
  // visible, else an estimate that assumes a roughly level camera)
  {
    const gazeOnTrunk = relative && gazeRel !== null
    if (f.headPitch === null) checks.push(unknown('gaze', 'nose not in view'))
    else {
      const v = gazeOnTrunk ? (gazeRel as number) : f.headPitch
      const basis: CheckBasis = gazeOnTrunk ? 'relative' : absolute ? 'absolute' : 'estimate'
      // (an estimate against an unconfirmed gravity gets that gravity's tolerance, also when
      // the trunk is in view but the head-on-trunk angle is not measurable this time)
      const kGaze = basis === 'estimate' ? slack * K_SAGITTAL[src === 'hips' ? 'hips' : 'camera'] : kHead
      if (v > ASSESS.headPitchMax * kGaze) checks.push(check('gaze', 'adjust', v, INSTRUCTIONS.gazeDown, 'down', undefined, basis))
      else if (v < ASSESS.headPitchMin * slack) checks.push(check('gaze', 'adjust', v, INSTRUCTIONS.gazeUp, 'up', undefined, basis))
      else checks.push(check('gaze', 'good', v, null, undefined, undefined, basis))
    }
  }

  return finish(checks, strong ? 'strong' : 'weak', relative, unverified, { neck: neckRel, gaze: gazeRel })
}

function finish(
  checks: PostureCheck[],
  gravity: 'strong' | 'weak',
  headRelativeToTrunk = false,
  unverified: CheckId[] = [],
  headOnTrunk: { neck: number | null; gaze: number | null } = { neck: null, gaze: null }
): PostureAssessment {
  const byId = Object.fromEntries(checks.map((c) => [c.id, c])) as Record<CheckId, PostureCheck>
  const primary = checks.find((c) => c.status === 'adjust') ?? null
  const allGood = byId.inView.status === 'good' && primary === null
  const viewInstruction = unverified.map((id) => byId[id].viewInstruction).find((s): s is string => !!s) ?? null
  return {
    checks,
    byId,
    primary,
    allGood,
    verified: allGood && unverified.length === 0,
    gravity,
    headRelativeToTrunk,
    unverified,
    viewInstruction,
    headOnTrunk
  }
}
