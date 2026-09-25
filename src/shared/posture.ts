// Core posture domain types — shared by main, preload, and renderer.
// The detection algorithm itself lives in src/renderer/src/posture/ (pure functions).

export const ISSUES = ['sink', 'headForward', 'lean', 'tooClose'] as const
export type IssueId = (typeof ISSUES)[number]

/** Status vocabulary — used identically everywhere (dashboard, tray, settings). */
export const ISSUE_LABELS: Record<IssueId, string> = {
  sink: 'Slouching',
  headForward: 'Head forward',
  lean: 'Leaning to one side',
  tooClose: 'Too close to screen'
}

/** 0 = fine, 1 = slight, 2 = clear, 3 = severe */
export type Stage = 0 | 1 | 2 | 3

export type PresenceState = 'active' | 'away'

export type TrayState = 'good' | 'warn' | 'bad' | 'paused' | 'away' | 'off'

export interface IssueSnapshot {
  issue: IssueId
  /** current smoothed severity (0 if fine or detector unavailable) */
  stage: Stage
  /** ms since this issue first left stage 0 in the current episode, null when fine */
  activeForMs: number | null
  /** dominant smoothed metric value, for debugging/UI */
  metric: number
  /** for `lean`: which side the user leans toward, in mirrored-preview terms */
  direction?: 'left' | 'right'
}

export interface PostureSnapshot {
  presence: PresenceState
  issues: Record<IssueId, IssueSnapshot>
  worstStage: Stage
  calibrated: boolean
  /** the camera view has drifted far from the calibrated distance for a while */
  recalibrationSuggested: boolean
  ts: number
}

export type AlertKind = 'initial' | 'escalation' | 'reminder' | 'recovery'

export interface PostureAlert {
  issue: IssueId
  stage: Stage
  kind: AlertKind
  /** how long the episode has been running when the alert fired */
  durationMs: number
  direction?: 'left' | 'right'
}

/** Which landmark groups were usable during calibration. */
export interface CalibrationCapabilities {
  shoulders: boolean
  ears: boolean
  eyes: boolean
}

/**
 * Numeric baseline captured while the user sits upright. Only numbers —
 * no image data is ever stored. See docs/specs/detection.md §3.
 */
export interface CalibrationBaseline {
  capturedAt: number
  cameraDeviceId: string | null
  /** the camera's name — its id changes when a webcam moves to another USB port */
  cameraLabel?: string | null
  capabilities: CalibrationCapabilities
  /** raw scales at calibration (normalized image units) */
  sSh0: number | null
  sEar0: number | null
  sEye0: number | null
  /** baseline unit (shoulder width or derived) + fallback ratios */
  U0: number
  REar: number | null
  REye: number | null
  /** vertical positions */
  ySh0: number | null
  yHd0: number | null
  /** head-above-shoulder gap in scale units */
  h0: number | null
  /** face-scale / shoulder-scale ratio */
  r0: number | null
  /** nose-below-ears pitch proxy (ear-referenced) */
  p0: number | null
  /** nose-below-eyes pitch proxy (eye-referenced, for the ears-hidden fallback) */
  pEye0: number | null
  /** ear-line, eye-line and shoulder-line angles (degrees) */
  phiHead0: number | null
  phiEye0: number | null
  phiSh0: number | null
  /** lateral head offset in scale units */
  o0: number | null
  /**
   * Eye-referenced twins of yHd0/h0/o0. yHd0/h0/o0 are measured from the ear
   * midpoint whenever ears were captured; when ears drop out at runtime the
   * head position comes from the eyes and must be compared against these.
   * Optional: baselines captured before they existed simply lack them.
   */
  yHdEye0?: number | null
  hEye0?: number | null
  oEye0?: number | null
}

export type CameraError = 'in-use' | 'not-found' | 'denied' | null

export interface DetectionStatus {
  running: boolean
  delegate: 'GPU' | 'CPU' | null
  targetFps: number
  measuredFps: number
  cameraError: CameraError
  /** the pose model couldn't be loaded or keeps failing (not a camera problem) */
  modelError: boolean
}

/** One minute of the day's posture log (for the Today strip). */
export interface StatMinute {
  /** epoch minute (Math.floor(ts / 60000)) */
  m: number
  /** dominant state that minute */
  s: 'good' | 'away' | 'paused' | `${IssueId}:${1 | 2 | 3}`
}

export interface TodayStats {
  date: string // YYYY-MM-DD local
  minutes: StatMinute[]
}
