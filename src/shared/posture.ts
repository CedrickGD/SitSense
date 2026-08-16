// Core posture domain types — shared by main, preload, and renderer.
// The detection algorithm itself lives in src/renderer/src/posture/ (pure functions).

export const ISSUES = ['sink', 'headForward', 'lean', 'tooClose'] as const
export type IssueId = (typeof ISSUES)[number]

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
  /** nose-below-ears pitch proxy */
  p0: number | null
  /** ear-line, eye-line and shoulder-line angles (degrees) */
  phiHead0: number | null
  phiEye0: number | null
  phiSh0: number | null
  /** lateral head offset in scale units */
  o0: number | null
}

export type CameraError = 'in-use' | 'not-found' | 'denied' | null

export interface DetectionStatus {
  running: boolean
  delegate: 'GPU' | 'CPU' | null
  targetFps: number
  measuredFps: number
  cameraError: CameraError
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
