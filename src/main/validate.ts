import { ISSUES, type DetectionStatus, type PostureAlert, type PostureSnapshot } from '../shared/posture'

// Renderer → main payloads are checked at the IPC boundary: a buggy or
// compromised renderer must not be able to crash main-process timers (a
// throwing interval pops a modal error dialog every few seconds) or smuggle
// odd values into the tray, stats or toasts.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStage = (v: unknown): boolean => v === 0 || v === 1 || v === 2 || v === 3
const isDirection = (v: unknown): boolean => v === undefined || v === 'left' || v === 'right'

export function isPostureSnapshot(v: unknown): v is PostureSnapshot {
  if (!isObject(v) || !isObject(v.issues)) return false
  if (v.presence !== 'active' && v.presence !== 'away') return false
  if (!isStage(v.worstStage) || typeof v.calibrated !== 'boolean') return false
  if (typeof v.recalibrationSuggested !== 'boolean' || !Number.isFinite(v.ts)) return false
  const issues = v.issues
  return ISSUES.every((id) => {
    const i = issues[id]
    return (
      isObject(i) &&
      i.issue === id &&
      isStage(i.stage) &&
      (i.activeForMs === null || (typeof i.activeForMs === 'number' && Number.isFinite(i.activeForMs))) &&
      isDirection(i.direction)
    )
  })
}

export function isPostureAlert(v: unknown): v is PostureAlert {
  return (
    isObject(v) &&
    ISSUES.includes(v.issue as never) &&
    isStage(v.stage) &&
    (v.kind === 'initial' || v.kind === 'escalation' || v.kind === 'reminder' || v.kind === 'recovery') &&
    typeof v.durationMs === 'number' &&
    Number.isFinite(v.durationMs) &&
    v.durationMs >= 0 &&
    isDirection(v.direction)
  )
}

export function isDetectionStatus(v: unknown): v is DetectionStatus {
  return (
    isObject(v) &&
    typeof v.running === 'boolean' &&
    (v.delegate === null || v.delegate === 'GPU' || v.delegate === 'CPU') &&
    (v.cameraError === null || v.cameraError === 'in-use' || v.cameraError === 'not-found' || v.cameraError === 'denied') &&
    (v.modelError === undefined || typeof v.modelError === 'boolean')
  )
}

/** pause:set arguments — a boolean plus null (until resumed) or whole minutes 1–1440. */
export function isPauseRequest(paused: unknown, minutes: unknown): boolean {
  if (typeof paused !== 'boolean') return false
  return minutes === null || minutes === undefined || (Number.isInteger(minutes) && (minutes as number) >= 1 && (minutes as number) <= 1440)
}
