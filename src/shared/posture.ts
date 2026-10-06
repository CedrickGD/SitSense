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

export type ViewKind = 'front' | 'angled' | 'side'

/** Live deviations from the baseline for the UI (docs/specs/detection.md §9). */
export interface PostureReadout {
  view: ViewKind
  /** degrees / cm; null when not measurable from this view right now */
  neckFwd: number | null
  trunkFwd: number | null
  drop: number | null
  forward: number | null
  lateral: number | null
  /** which segment `lateral` was measured from (a neck tilt has its own stage thresholds) */
  lateralFrom?: 'trunk' | 'neck'
}

export interface PostureSnapshot {
  presence: PresenceState
  issues: Record<IssueId, IssueSnapshot>
  worstStage: Stage
  calibrated: boolean
  /** the camera view has drifted far from the calibrated distance for a while */
  recalibrationSuggested: boolean
  /**
   * every detector is paused because the view is far off the setup distance: posture is
   * not judged until the view comes back or setup is redone. Optional for older producers.
   */
  suspended?: boolean
  readout?: PostureReadout
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

export type Vec3 = [number, number, number]

export type UpSource = 'body' | 'hips' | 'camera'

/**
 * Numeric baseline captured once the AI judged the posture good. Only numbers —
 * no image data is ever stored. Angles in degrees, lengths in metres, vectors
 * in camera coordinates (x right, y down, z away from the camera).
 * See docs/specs/detection.md §7.
 */
export interface CalibrationBaseline {
  version: 2
  capturedAt: number
  cameraDeviceId: string | null
  /** gravity "up" in camera coordinates (unit vector) and how it was estimated */
  up: Vec3
  upSource: UpSource
  /** body forward (toward the screen) at capture, unit vector */
  forward: Vec3
  view: { kind: ViewKind; yawDeg: number; elevationDeg: number }
  /** the AI judged this posture good (false = the user saved it anyway) */
  verified: boolean
  neckFwd: number
  /** null when both ears and both shoulders were not in view at capture (e.g. a profile camera) */
  neckLat: number | null
  /** what neckLat was measured against (absent in older baselines: 'trunk' iff trunkLat !== null) */
  neckLatRef?: 'trunk' | 'gravity'
  headPitch: number | null
  headRollRel: number | null
  shoulderTilt: number | null
  trunkFwd: number | null
  trunkLat: number | null
  torsoLen: number | null
  /** image-plane vertical ear→shoulder distance (m), front views only */
  neckH: number | null
  /** image height-units per metre at the body */
  ppm: number
  /** upper-body anchor (shoulder point) position, camera-frame metres */
  anchor: Vec3
}

/** True for a baseline written by the current (v2) detection engine. */
export function isCurrentBaseline(b: unknown): b is CalibrationBaseline {
  if (b === null || typeof b !== 'object') return false
  const c = b as Partial<CalibrationBaseline>
  const vec = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))
  return (
    c.version === 2 &&
    vec(c.up) &&
    vec(c.forward) &&
    vec(c.anchor) &&
    Number.isFinite(c.ppm) &&
    (c.ppm as number) > 0 &&
    Number.isFinite(c.neckFwd)
  )
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
  /** posture nudges shown that day (absent in files written before it was counted) */
  alerts?: number
  /** breaks taken after a sitting stretch (see main/break-tracker.ts) */
  breaks?: number
}
