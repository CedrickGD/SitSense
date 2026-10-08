// Every constant of the detection algorithm, from docs/specs/detection.md §11
// (plus the few documented in its "Implementation notes"). Thresholds are BASE
// values at sensitivity σ = 1.0 (effective = base / σ).

import type { IssueId } from '@shared/posture'

// MediaPipe Pose landmark indices ("left/right" = the person's anatomical sides)
export const LM = {
  nose: 0,
  leftEyeOuter: 3,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26
} as const

export const LANDMARK_COUNT = 33

// ---- frame geometry (§1–§3) ----
/** a landmark is "seen" at or above this visibility (and inside the expanded frame) */
export const V_SEEN = 0.5
/** frame expansion for "inside the frame" (fraction of width/height on every side) */
export const FRAME_MARGIN = 0.05
/** in-frame trust (geometry weight) ramps from 0 at the frame edge to 1 this far inside */
export const FRAME_TRUST_INSIDE = 0.03
/** both shoulders need at least this visibility for headRollRel */
export const V_ROLL_SHOULDERS = 0.3
/** plausible hip-line length (m) for using it as a horizontal reference */
export const HIP_LINE_MIN_M = 0.08
export const HIP_LINE_MAX_M = 0.5
/** knees need this visibility for the body ("thigh") gravity estimate */
export const V_KNEE_UP = 0.7
/** assumed webcam horizontal field of view (degrees); rescales metric depth and sets the viewing-ray correction */
export const HFOV_ASSUMED = 65
/** any gravity estimate further than this from the camera's up is rejected */
export const UP_MAX_TILT = 60
/**
 * Level-camera model (docs/specs/detection.md, Implementation notes, "Gravity"). Webcams are
 * mounted level: their roll (rotation about the optical axis, i.e. the tilt of the true
 * vertical at the image centre) is a few degrees, while their pitch can be anything
 * (monitor-top cameras look down, laptops up, shelf cameras steeply down). Gravity is
 * therefore estimated as a camera PITCH with roll 0: body cues never roll it. This is the
 * largest roll (degrees) a level-mounted webcam shows: thigh roll within it (plus noise) is
 * not read as thigh slope (features.ts thighHipUp), and a hip line needing more than twice
 * it leaves the horizontal unconfirmed (UpEstimator.levelConsistent). limitRoll's default.
 */
export const UP_MAX_ROLL = 3
/**
 * A camera pitch tilts a level hip line in the picture only as far as the body is turned
 * (by about yaw·sin pitch). β = the angle between the hip line and the camera's x axis
 * (≈ the body's yaw). Below UP_HIP_PERSPECTIVE_MIN the line faces the camera and shows no
 * usable perspective — its pitch reading would amplify depth noise and the camera's own
 * small roll ~1/sin β-fold — so it gives no pitch (level). From UP_HIP_PERSPECTIVE_FULL its
 * tilt is perspective and gives the pitch; in between, that share of it.
 */
export const UP_HIP_PERSPECTIVE_MIN = 8
export const UP_HIP_PERSPECTIVE_FULL = 16
/**
 * Per-frame sanity gate of the UpEstimator. Its mean is gated at UP_MAX_TILT instead:
 * gating every noisy frame at UP_MAX_TILT keeps only the frames that noise pulled under
 * the limit for a camera tilted close to it, which biases the mean.
 */
export const UP_FRAME_MAX_TILT = 80
/** a gravity source is trusted only when most of the frames that could produce it did */
export const UP_MIN_ACCEPT_RATIO = 0.7
/**
 * The pelvis and shoulder lines of a seated person face the same way: hips whose line is
 * twisted further than this (median over the setup window) about the trunk axis are
 * hallucinated (e.g. predicted under a desk with high visibility) and ignored.
 */
export const HIP_TWIST_MAX = 15
/** frames needed before the hip-consistency verdict is made */
export const HIP_TWIST_MIN_FRAMES = 5
/**
 * Hysteresis (±deg) of the live hip-consistency verdict around HIP_TWIST_MAX: the median of a
 * few noisy twists (an 18 cm hip line's depth noise) must not flip the hips — and with them
 * the gravity source and the trunk — in and out of use from one frame to the next.
 */
export const HIP_TWIST_HYST = 3
/** thigh vs hip-line angle window for the body gravity estimate */
export const UP_THIGH_ANGLE_MIN = 45
export const UP_THIGH_ANGLE_MAX = 135
/**
 * Spread (1σ, degrees) of a thigh estimate about the hip line: real thighs slope ±10–15°,
 * and knees predicted under a desk are 6–10 cm off. Along that rotation the thighs are
 * weighed against the level camera's roll (σ = UP_MAX_ROLL, features.ts thighHipUp): they
 * set the pitch of a body facing the camera, while for a turned one their roll exposes their
 * slope.
 */
export const UP_THIGH_SIGMA = 8
/**
 * A thigh (body) estimate that puts the trunk this far from vertical is implausible: the
 * hip angle of a seated person stays above ~40° (hallucinated knees under a desk point
 * up toward the chest).
 */
export const UP_MAX_TRUNK_TILT = 50
/** UpEstimator: frames a source needs before it outranks a lower one */
export const UP_MIN_FRAMES = 5
/** lateral features need the body to face the camera at least this much */
export const LAT_MAX_YAW = 60
/** the engine measures lateral features this much beyond LAT_MAX_YAW and gates on its smoothed yaw */
export const LAT_YAW_SLACK = 8
/** hysteresis (±deg) of the engine's lateral gate around LAT_MAX_YAW on the smoothed yaw */
export const LAT_GATE_HYST = 3
/** shoulderTilt with camera-only gravity is reported only up to this yaw */
export const SHOULDER_CAMERA_MAX_YAW = 20
/** view kinds */
export const VIEW_FRONT_MAX_YAW = 25
export const VIEW_ANGLED_MAX_YAW = 60
/** neckDrop is a front-view metric */
export const NECK_DROP_MAX_YAW = 35
/** a (partly predicted) shoulder line shorter than this cannot orient the body */
export const SHOULDER_LINE_MIN_M = 0.15
/** ppm needs at least this many measurable segments */
export const PPM_MIN_SEGMENTS = 2

// ---- presence plausibility (§2, "a seated user at the screen", see Implementation notes) ----
/**
 * Farthest perspective-fit depth (m, at the assumed HFOV) of a seated user's shoulders without
 * a baseline (setup, an uncalibrated engine). Desk users sit 0.3–1.5 m away; the FOV assumption
 * scales depth ×0.8–1.45 (55–85° lenses), so a user 1.5 m away lying back reads ≤ ~2.5 m. A
 * small figure (a print, a poster) is reconstructed at human size and lands several metres
 * away, and so does a person behind the user: 4 m away reads ≥ 3.1 m through any lens of 52°
 * or more. The FOV is unknown, so the bound trades the two ends: a lens of 110–120° reads a
 * user ~1.1–1.5 m away at this depth (Implementation notes, "Limits"); with a baseline the bound
 * is relative (below).
 */
export const PRESENCE_MAX_DEPTH_M = 3.0
/**
 * With a baseline of this camera (depth D_b, read through the same lens) the bound is
 * D_b · RATIO, at least D_b + ADD, at most CAP (presenceMaxDepth): moving back 1 m from a close
 * seat, or to 2.5× the setup distance, stays the user (the recalibration hint starts at 2×);
 * a figure or a person farther than that does not, whatever the lens.
 */
export const PRESENCE_BASELINE_DEPTH_RATIO = 2.5
export const PRESENCE_BASELINE_DEPTH_ADD_M = 1.0
export const PRESENCE_BASELINE_DEPTH_CAP_M = 4.5
/**
 * The shoulder→ear (neck) vector — and the hip→shoulder (trunk) vector when a hip is seen — of
 * a seated user is within this of gravity's up: lying back 50° in the chair with the head
 * going along, or a deep hunch with the head forward, stays ~15–20° inside it (also with
 * hallucinated hips, ±12° on the trunk); a body lying flat (90°) or upside down does not.
 */
export const PRESENCE_NECK_MAX = 72
/** the trunk (hip→shoulder, a hip seen) is held to PRESENCE_NECK_MAX too once it is at least this long (m) */
export const PRESENCE_TRUNK_MIN_M = 0.2
/**
 * The shoulder line of a seated user is within this of horizontal (lean, shrug, depth noise
 * of a predicted far shoulder): used only to rule out a camera pitch, never on its own.
 */
export const PRESENCE_SHOULDER_TILT_MAX = 45
/**
 * Roll budget: the shoulder-line tilt allowed falls from PRESENCE_SHOULDER_TILT_MAX at a recline
 * of PRESENCE_ROLL_FULL_UNTIL to PRESENCE_ROLL_AT_NECK_MAX at PRESENCE_NECK_MAX. The recline is
 * the body axis (trunk, else neck) in the body's sagittal plane, so a sideways lean is not
 * counted twice. A user leaning 40° sideways is upright in that plane; one lying back 65° keeps
 * the shoulders level. A figure lying flat on the desk 30–40° off "across", seen through the
 * pitch that would make it upright enough, is reclined ≥ 50° AND rolled ≥ 30° at once
 * (Implementation notes).
 */
export const PRESENCE_ROLL_FULL_UNTIL = 25
export const PRESENCE_ROLL_AT_NECK_MAX = 8
/**
 * Tracking continuity (engine): while present, a frame that fails only the measured-gravity
 * uprightness (a stale gravity after the webcam was re-aimed) still counts as the user when the
 * last GOOD frame is at most this old (s) and the shoulders moved at most this far (m) since.
 */
export const PRESENCE_TRACK_GAP_S = 0.5
export const PRESENCE_TRACK_JUMP_M = 0.3
export const PRESENCE_TRACK_TURN_MAX = 40
/**
 * The level-camera pitches (deg, + = looking down) a webcam may have when gravity is not
 * measured: a little beyond the supported −30…65° on both sides.
 */
export const PRESENCE_PITCH_MIN = -45
export const PRESENCE_PITCH_MAX = 75

// ---- AI assessment (§4) ----
/**
 * Without thigh gravity, camera pitch leaks into sagittal angles as ≈ pitch·cos(yaw);
 * only near-profile views keep it small enough to judge trunk lean absolutely.
 */
export const SIDE_VIEW_YAW = 75
/** …and only up to this yaw: from behind the profile the pitch leak grows as |cos yaw| again */
export const SIDE_VIEW_YAW_MAX = 105
/**
 * Hysteresis (deg) of the near-profile verdict in setup: a view is near-profile from
 * SIDE_VIEW_YAW on, and once holding/capturing stays so down to SIDE_VIEW_YAW − this (the final
 * exam of that capture too). A camera whose noisy optical yaw hovers at the limit would otherwise
 * flip the back check between verified and not, and loop hold → capture → discard.
 */
export const SIDE_VIEW_YAW_HYST = 5
/**
 * Sagittal tolerance multipliers: thigh gravity 1.3 (it assumes level thighs; seated
 * thighs slope ±10–15°, which shifts every absolute sagittal angle one-for-one); a
 * near-profile view without it 1.3 (camera roll maps onto sagittal angles there); head
 * judged relative to the trunk 1.3; hips 1.3; camera 1.6.
 */
export const K_SAGITTAL = { body: 1.3, side: 1.3, relative: 1.3, hips: 1.3, camera: 1.6 } as const
export const K_LATERAL = { body: 1.0, hips: 1.0, camera: 1.4 } as const
export const ASSESS = {
  /**
   * Fixed recline limit (deg; not widened by k). Neutral sitting is a hip angle of ~90–110°
   * (trunk 0–20° back from vertical); with thigh gravity the reading IS the hip angle − 90°,
   * so −25° allows a 15° recline on a seat whose thighs slope 10° down. (Was −35°, which
   * let a user lying 30° in the chair pass.)
   */
  trunkFwdMin: -25,
  trunkFwdMax: 12,
  neckFwdMax: 20,
  trunkLatMax: 6,
  shoulderTiltMax: 5,
  headRollMax: 7,
  headPitchMin: -15,
  headPitchMax: 30
} as const
/**
 * Gravity-free "lying in the chair" signature (assess.ts): someone who lies back in the chair
 * and keeps the eyes on the screen must tip the head far forward on the trunk. The head's pitch
 * on the trunk (headOnTrunk ≈ headPitch − trunkFwd; 14° of it is the ear→nose line's own droop)
 * reads 19–33° for the accepted postures (upright to 15° reclined, eyes on the screen) and
 * 45–59° lying 30–50° back. Where the trunk's lean is known (thigh gravity, near profile) and
 * confirms a recline past LYING_TRUNK_MAX, it is flagged above LYING_HEAD_ON_TRUNK_CONFIRMED.
 * Where it is not, only above LYING_HEAD_ON_TRUNK: such a view never verifies the back angle
 * anyway (a missed signature leaves the "sit tall, can't judge your back from here" coaching),
 * so the threshold is set for no false "you're lying" on a reclined good posture under the
 * simulator's heavy noise, rather than for catching the mildest lying cases. In both cases the
 * neck must also be flexed forward on the trunk (neckOnTrunk) by more than LYING_NECK_REL_MIN,
 * which tells it apart from a plain look down (that tips the head, not the neck).
 */
export const LYING_HEAD_ON_TRUNK = 48
export const LYING_HEAD_ON_TRUNK_CONFIRMED = 36
export const LYING_NECK_REL_MIN = 12
/**
 * Where the trunk's absolute lean is known (thigh gravity, near-profile view), the lying
 * signature needs the trunk reclined past the comfortable range (deg, −): a user who sits
 * upright or leans back 15° and looks down at the keyboard shows similar head-on-trunk angles
 * and is coached on the gaze instead.
 */
export const LYING_TRUNK_MAX = -18
/** a recline past this (deg) is lying in the chair, not leaning back: the instruction says so */
export const LYING_TRUNK_ABS = -32
/**
 * Gravity-free "leaning in" hint: with the eyes on the screen, a trunk that leans toward it
 * makes the head tip BACK on the trunk. The head's pitch on the trunk (≈ headPitch − trunkFwd)
 * below this (deg) is coached as leaning forward where the trunk's own lean cannot be
 * measured. An upright user reads about 14° + the head's Frankfort pitch, so −8° still allows
 * looking up 22° (a high screen) — and leaves room for the per-frame noise of a short vector.
 * Only a hint: it never verifies anything.
 */
export const LEAN_IN_GAZE_REL = -8
/**
 * Corroboration for a locally verified back angle: even where the trunk's absolute lean reads
 * fine, the head must not be tipped back on the trunk (headOnTrunk below this, deg) — which is
 * how a trunk leaning in toward the screen looks when the absolute reading missed the lean
 * (hips predicted under a desk shift it by up to ±12°). Then the back angle is left
 * unverified. An upright user looking straight ahead reads ≈ 14° (the ear→nose droop; 6–17°
 * across faces), so only a look up past that range trips it.
 */
export const VERIFY_HEAD_ON_TRUNK_MIN = 0
/**
 * …raised by this much per degree the absolute trunk reading leans forward (deg/deg). With the
 * eyes on the screen, headOnTrunk ≈ 14° + the gaze's own pitch − the true trunk lean; a reading
 * near the forward limit is only confirmed when the head on the trunk agrees with it. A slump
 * (trunk ~20° forward) on a seat whose knees point down (thigh gravity ~10° off) reads a trunk
 * of ~10° with the head on the trunk at 0–8°; an upright user (0–5° in) looking at the screen
 * shows 14–25°. The price: a trunk truly leaning ~10° in with a level gaze is not confirmed
 * locally either (never coached for it). Only the forward side: a reclined reading keeps the
 * plain limit.
 */
export const VERIFY_HEAD_ON_TRUNK_PER_DEG = 1

// ---- setup session (§7) ----
export const HOLD_S = 1.5
export const CAPTURE_S = 3
/** capture keeps going (up to this) until SETUP_MIN_FRAMES GOOD frames are in */
export const CAPTURE_MAX_S = 6
export const BREAK_S = 0.7
export const SEARCH_LOST_S = 1.0
export const FORCE_AFTER_S = 20
export const SETUP_MIN_FRAMES = 15
/**
 * GOOD frames needed (counted since the user came into view, not within the 1 s
 * assessment window, so it also works below 5 fps) before the first verdict.
 */
export const SETUP_WARMUP_FRAMES = 5
/** stability: motion spread (noise-corrected MAD × 1.4826) limits */
export const STABLE_NECK_DEG = 4
export const STABLE_ANCHOR_M = 0.02
/** noise allowance factor of the stability test (see calibration.ts) */
export const STABLE_NOISE_K = 5
/** live assessment uses the median of the GOOD frames from this window */
export const ASSESS_WINDOW_S = 1.0
/**
 * …except the head-on-trunk angles (neckOnTrunk, headOnTrunk): the median of this longer window.
 * They rest on short vectors near the head (the ear→nose line is 10 cm) and are the noisiest
 * features per frame, while the decisions on them (lying, leaning in) concern a posture held
 * for a while — a longer median keeps the noise from flickering them.
 */
export const ASSESS_RELATIVE_WINDOW_S = 2.0
/** while holding/capturing, check tolerances widen by this factor (anti-flicker hysteresis) */
export const ASSESS_HOLD_SLACK = 1.2
/** after this many review rejections the session offers force() */
export const REVIEW_REJECTS_FOR_FORCE = 2
/** after a review rejection, coaching lasts at least this long before the next hold starts */
export const REVIEW_RETRY_S = 5
/** after this many rejections the session stops capturing (and re-reviewing) on its own */
export const REVIEW_MAX_AUTO = 3
/**
 * Without a reviewer, a posture that is good in everything the camera can show but leaves an
 * essential check unverifiable (assessment.verified false) is never saved on its own. After it
 * has been held this long (s) the session offers "Save this posture anyway" (canForce).
 */
export const UNVERIFIED_FORCE_AFTER_S = 3

// ---- smoothing (§6) ----
export const TAU_METRIC_S = 0.6
export const TAU_SCALE_S = 1.0
export const DT_CAP_S = 0.5
export const MEDIAN_WINDOW = 3
export const OUTLIER_SCALE_JUMP = 0.35
export const OUTLIER_MAX_CONSEC = 3

// ---- issues (§5) ----
/**
 * Gravity-referenced metrics that an unknown camera tilt can leak into (shoulderTilt,
 * gravity-referenced neckLat, and the sagittal ones without thigh gravity) are held while
 * the body is swiveled further than this from the baseline.
 */
export const SWIVEL_HOLD = 15
/**
 * Head metrics are held while the head is turned further than this when only one ear is
 * in the frame; head pitch also without thigh gravity (an unknown camera tilt leaks into
 * it as the head turns).
 */
export const HEAD_TURN_HOLD = 20
/** a held (unavailable) sub-metric stops driving its issue after this long */
export const SUB_STALE_S = 1.0
/** smoothing of the swivel / view-yaw gates (s) */
export const TAU_GATE_S = 0.6

// hysteresis: recovery threshold = HYST × trigger threshold
export const HYST = 0.75

/**
 * Recline-slump ("lying in the chair", engine sub-metric `recline`): min(recline since the
 * baseline, this × the neck's extra forward flexion on the trunk). Lying back while craning the
 * neck forward to keep the eyes on the screen counts; leaning back with the head going along
 * (resting, stretching) or a forward head without a recline does not.
 */
export const RECLINE_CRANE_GAIN = 1.5

/** per-sub-metric stage thresholds [slight, clear, severe] (deg / cm / fraction) */
export const STAGES = {
  sink: {
    trunkFwd: [10, 18, 28],
    drop: [5, 10, 16],
    torso: [0.07, 0.12, 0.18],
    recline: [20, 28, 36]
  },
  headForward: {
    neck: [10, 18, 28],
    neckDrop: [0.15, 0.28, 0.42],
    pitch: [15, 25, 35]
  },
  lean: {
    trunkLat: [6, 11, 18],
    neckLat: [8, 14, 22],
    shoulderTilt: [5, 9, 15],
    headRoll: [8, 14, 22]
  },
  tooClose: {
    forward: [7, 13, 19]
  }
} as const satisfies Record<IssueId, Record<string, readonly [number, number, number]>>

// ---- episode timing (§8) ----
/** dwell = per-issue multiplier on the user's base dwell setting */
export const DWELL_FACTOR: Record<IssueId, number> = {
  sink: 1.0,
  headForward: 1.0,
  lean: 1.25,
  tooClose: 0.7
}
export const PITCH_ONLY_DWELL_MULT = 1.5
export const BAND_HOLD_MAX_S = 5
export const DATA_LOSS_RESET_S = 10
export const ESC_DWELL_S = 4
export const ESC_MIN_GAP_S = 30
export const REC_DWELL_S = 5

// ---- presence ----
export const AWAY_ENTER_S = 2.0
export const AWAY_EXIT_S = 1.5
/**
 * While away, a BAD frame takes back this fraction of its time from the GOOD time gathered
 * toward AWAY_EXIT_S instead of starting over. In poor light (a dim room, the head down over a
 * phone) the model drops every second or third frame of a user who sits right there; with a
 * restart on every gap they were never confirmed. With 0.5 a user seen in 60% of the frames is
 * confirmed after ~3.8 s; below a third of the frames the GOOD time drifts back down (a figure
 * that slips through now and then is never confirmed).
 */
export const AWAY_EXIT_DECAY = 0.5
export const AWAY_FULL_RESET_S = 30

// ---- recalibration hint ----
export const RECAL_D_MIN = 0.5
export const RECAL_D_MAX = 1.8
export const RECAL_SUGGEST_S = 10
