// Every constant of the detection algorithm, from docs/specs/detection.md §10.
// All thresholds are BASE values at sensitivity σ = 1.0.

import type { IssueId } from '@shared/posture'

// MediaPipe Pose landmark indices
export const LM = {
  nose: 0,
  leftEyeOuter: 3,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12
} as const

// visibility gates
export const V_LM = 0.5
export const V_CAL = 0.6

// anthropometric fallbacks (face-only mode)
export const K_SH_PER_EAR = 2.4
export const R_EYE_FALLBACK = 3.0

// calibration
export const CAL_COUNTDOWN_S = 3
export const CAL_DURATION_S = 5
export const CAL_MIN_FRAMES = 30
export const CAL_MAX_CV = 0.06

// smoothing
export const TAU_METRIC_S = 0.6
export const TAU_SCALE_S = 1.0
export const DT_CAP_S = 0.5
export const MEDIAN_WINDOW = 3
export const OUTLIER_SCALE_JUMP = 0.35
export const OUTLIER_MAX_CONSEC = 3

// sink distance gate (metric held outside this D range)
export const SINK_D_MIN = 0.85
export const SINK_D_MAX = 1.18

// hysteresis: recovery threshold = HYST × trigger threshold
export const HYST = 0.75

// per-stage base thresholds [slight, clear, severe]
export const THRESHOLDS = {
  sink: [0.14, 0.28, 0.45],
  fwdGap: [0.15, 0.28, 0.42],
  fwdFace: [0.1, 0.18, 0.28],
  fwdPitch: [0.12, 0.25, 0.4],
  leanRoll: [8, 15, 25],
  leanTilt: [6, 12, 20],
  leanLateral: [0.18, 0.32, 0.5],
  close: [1.12, 1.25, 1.4]
} as const satisfies Record<string, readonly [number, number, number]>

// episode timing (dwell = per-issue multiplier on the user's base dwell setting)
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

// presence
export const AWAY_ENTER_S = 2.0
export const AWAY_EXIT_S = 1.5
export const AWAY_FULL_RESET_S = 30

// recalibration hint
export const RECAL_D_MIN = 0.5
export const RECAL_D_MAX = 1.8
export const RECAL_SUGGEST_S = 10
