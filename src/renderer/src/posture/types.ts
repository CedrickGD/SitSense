// Input/internal types of the pure detection core (docs/specs/detection.md v2).
// No MediaPipe imports here — the core is engine-agnostic and unit-testable
// with the 3D posture simulator in __tests__/sim.ts.

import type { CalibrationBaseline, UpSource, Vec3, ViewKind } from '@shared/posture'

export type { UpSource, Vec3, ViewKind }

/**
 * The baseline as buildBaseline writes it: the shared CalibrationBaseline plus optional,
 * additive fields (older baselines lack them; readers fall back). They are always written
 * (null when unmeasurable), so a deep-merged settings patch never keeps an older baseline's
 * value. (Candidates for CalibrationBaseline in src/shared/posture.ts.)
 */
export interface PostureBaseline extends CalibrationBaseline {
  /** gravity-free neck flexion on the trunk at capture (PostureFeatures.neckOnTrunk); null without a hip */
  neckOnTrunk?: number | null
  /** gravity-free head pitch on the trunk at capture (PostureFeatures.headOnTrunk); null without a hip or the nose */
  headOnTrunk?: number | null
}

/** One MediaPipe landmark. Image: normalized (x by width, y by height, y down). World: metres. */
export interface Landmark {
  x: number
  y: number
  z?: number
  visibility?: number
}

/**
 * One video frame's pose result (§1).
 * - `image`: 33 normalized landmarks.
 * - `world`: 33 world landmarks in metres, origin at the hip midpoint, axes aligned
 *   with the camera (+x image-right, +y image-down, +z away from the camera); null
 *   when the model returned none.
 * - `aspect`: video width / height.
 */
export interface PoseFrame {
  image: readonly Landmark[]
  world: readonly Landmark[] | null
  aspect: number
}

/** null = no pose detected this frame. */
export type Frame = PoseFrame | null

/**
 * Why a frame is BAD (§2; null = GOOD):
 * - 'no-pose': no pose, no world landmarks, or malformed input;
 * - 'not-in-view': a pose, but not enough of it in the picture (head + one shoulder, an ear
 *   and a shoulder inside the frame, a measurable scale);
 * - 'too-far': the pose sits farther away than a user at the screen (a person behind the
 *   user, a small picture reconstructed at human size);
 * - 'not-upright': no level webcam could see this pose as someone sitting (head beside or
 *   below the shoulders: a figure lying flat on the desk, a picture upside down).
 * The last two are "not you": the UI should not say it sees the user.
 */
export type FrameReject = 'no-pose' | 'not-in-view' | 'too-far' | 'not-upright'

/** What neckLat is measured against (see PostureFeatures.neckLatRef). */
export type NeckLatRef = 'trunk' | 'gravity'

/**
 * Where the body's lateral axis (and so forward) came from this frame: the hip line,
 * the shoulder line (possibly with one shoulder's predicted position), the baseline's
 * forward (head + one shoulder at runtime), or — last resort — the ear line.
 */
export type LateralAxisSource = 'hips' | 'shoulders' | 'baseline' | 'head'

/** The person's own (anatomical) side. */
export type Side = 'left' | 'right'

/** A gravity estimate in camera coordinates (§3.2). */
export interface UpEstimate {
  /** unit vector pointing up (against gravity), camera coordinates */
  up: Vec3
  source: UpSource
}

export interface ViewInfo {
  /** 0 = body faces the camera, 90 = profile, 180 = back to the camera */
  yawDeg: number
  /** + = camera above the shoulders */
  elevationDeg: number
  kind: ViewKind
  /**
   * Like yawDeg, but toward the camera along its optical axis (projected on the
   * horizontal) instead of along the ray to the shoulders: 0 = the camera looks at the
   * person's front, 90 = at their side. Posture-independent (the anchor ray swings by
   * ~15° when a nearby user leans), and it is what scales the camera-pitch leak into
   * sagittal angles (∝ |cos opticalYaw|).
   */
  opticalYawDeg: number
}

/**
 * Which landmarks are usable this frame. `seen` = visibility ≥ V_SEEN and inside the
 * frame expanded by 5% (§1). Counts are per left/right pair (0..2). Keys use
 * MediaPipe's labels (which are the person's anatomical sides).
 */
export interface VisibilitySummary {
  head: boolean
  nose: boolean
  ears: number
  eyes: number
  shoulders: number
  hips: number
  /**
   * Hips whose image point lies inside the frame, seen or not (0..2): hips in the picture that
   * are not usable are hidden (a desk) or judged hallucinated, hips outside it need another
   * camera framing. (Optional: absent in hand-built summaries.)
   */
  hipsInFrame?: number
  knees: number
  seen: {
    nose: boolean
    leftEar: boolean
    rightEar: boolean
    leftEyeOuter: boolean
    rightEyeOuter: boolean
    leftShoulder: boolean
    rightShoulder: boolean
    leftHip: boolean
    rightHip: boolean
    leftKnee: boolean
    rightKnee: boolean
  }
}

/**
 * Per-frame posture geometry (§3). Only produced for GOOD frames (§2):
 * `extractFeatures` returns null otherwise. Angles in degrees, lengths in metres,
 * vectors in camera coordinates. Nullable fields are "not measurable from this
 * view right now" — never a guess.
 */
export interface PostureFeatures {
  /** always true: a features object exists only for GOOD frames */
  good: true
  vis: VisibilitySummary

  /** gravity used for this frame and where it came from */
  up: Vec3
  upSource: UpSource
  /** the person's left (horizontal unit vector) */
  left: Vec3
  /** the person's forward (horizontal unit vector, nose side) */
  forward: Vec3
  view: ViewInfo
  /** where the lateral axis (and so forward) came from */
  lateralAxis: LateralAxisSource
  /** side of the body facing the camera (for the overlay's alignment line) */
  nearSide: Side

  /** ears ahead of shoulders (+), in the sagittal plane */
  neckFwd: number
  /** lateral neck tilt toward the person's left (+); null unless both sides are in view */
  neckLat: number | null
  /**
   * 'trunk': neckLat is measured in the trunk's own frontal plane (both hips in view;
   * gravity plays no part). 'gravity': relative to Û (no pelvis in view). null with neckLat.
   * Deviations only compare like with like.
   */
  neckLatRef: NeckLatRef | null
  /** head direction below horizontal (+ = looking down); needs the nose */
  headPitch: number | null
  /** head turned relative to the body (+ = toward the person's left); needs the nose */
  headYaw: number | null
  /** both ears are inside the frame (the neck vector uses their midpoint, which a head turn does not move) */
  earsBoth: boolean
  /** ear (or eye) line vs shoulder line in the frontal plane (+ = left ear higher) */
  headRollRel: number | null
  /** shoulder line vs horizontal (+ = left shoulder higher) */
  shoulderTilt: number | null
  /** trunk lean (+ forward, − reclined); needs a hip */
  trunkFwd: number | null
  /**
   * Gravity-free: the neck's forward flexion ON THE TRUNK (deg, + = ears ahead of the trunk
   * line), measured in the body's own sagittal plane (⟂ the hip/shoulder line) between the
   * trunk (hip→shoulder) and the neck (shoulder→ear). ≈ neckFwd − trunkFwd, but no gravity
   * estimate enters. Needs a hip. (Optional: absent in hand-built features.)
   */
  neckOnTrunk?: number | null
  /**
   * Gravity-free: the head direction (ear→nose) pitched below the trunk's own "horizontal"
   * (deg, + = nose down on the trunk), in the body's sagittal plane. ≈ headPitch − trunkFwd.
   * Lying back with the eyes on the screen makes it large; leaning in makes it small. Needs a
   * hip and the nose. (Optional: absent in hand-built features.)
   */
  headOnTrunk?: number | null
  /**
   * The vectors behind neckOnTrunk / headOnTrunk in the trunk's own sagittal frame, metres:
   * [along the trunk's forward, along the trunk's up]. A robust summary of several frames takes
   * the angle of their component-wise median (medianFeatures): the angle of a short noisy vector
   * is skewed and heavy-tailed, its components are not.
   */
  neckOnTrunkVec?: readonly [number, number] | null
  headOnTrunkVec?: readonly [number, number] | null
  /** trunk lateral lean toward the person's left (+), relative to the pelvis; needs both hips */
  trunkLat: number | null
  /** hip→shoulder length (m); needs both hips */
  torsoLen: number | null

  /** image height-units per metre at the body; null with < 2 measurable segments */
  ppm: number | null
  /** shoulder point, camera-frame metres (needs ppm) */
  anchor: Vec3 | null
  /** ear point (or nose), camera-frame metres (needs ppm) */
  head: Vec3 | null
  /** image-plane vertical ear→shoulder distance along the projected up, metres (needs ppm) */
  neckH: number | null

  /** MediaPipe's left/right labels disagreed with the body geometry and were corrected */
  labelsSwapped: boolean
}
