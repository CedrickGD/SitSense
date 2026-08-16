import type { CalibrationBaseline, IssueId } from './posture'

export interface IssueSettings {
  enabled: boolean
  /** sensitivity σ ∈ [0.5, 2.0]; thresholds divide by it (higher = stricter) */
  sensitivity: number
  /** notify toggles per stage: [slight, clear, severe] */
  notifyStages: [boolean, boolean, boolean]
}

export type PerformancePreset = 'efficient' | 'balanced' | 'responsive'

export const PRESET_FPS: Record<PerformancePreset, number> = {
  efficient: 5,
  balanced: 10,
  responsive: 15
}

export interface NotificationSettings {
  enabled: boolean
  /** base dwell: seconds of sustained bad posture before the first nudge (5–30) */
  dwellSeconds: number
  /** quiet period between nudges for the same issue, minutes (1–10) */
  cooldownMinutes: number
  /** a worsening stage notifies immediately, even during the quiet period */
  escalation: boolean
  sound: boolean
}

export interface GeneralSettings {
  launchOnStartup: boolean
  startHidden: boolean
  /** dashboard camera preview collapsed (monitoring continues) */
  hidePreview: boolean
}

export interface Settings {
  cameraDeviceId: string | null
  performancePreset: PerformancePreset
  delegate: 'auto' | 'GPU' | 'CPU'
  /** delegate that actually worked last run ('auto' probe result) */
  resolvedDelegate: 'GPU' | 'CPU' | null
  issues: Record<IssueId, IssueSettings>
  notifications: NotificationSettings
  general: GeneralSettings
  calibration: CalibrationBaseline | null
  /** user has seen the close-to-tray coach mark */
  onboarded: boolean
}

const defaultIssue = (): IssueSettings => ({
  enabled: true,
  sensitivity: 1.0,
  notifyStages: [true, true, true]
})

export const DEFAULT_SETTINGS: Settings = {
  cameraDeviceId: null,
  performancePreset: 'balanced',
  delegate: 'auto',
  resolvedDelegate: null,
  issues: {
    sink: defaultIssue(),
    headForward: defaultIssue(),
    lean: defaultIssue(),
    tooClose: defaultIssue()
  },
  notifications: {
    enabled: true,
    dwellSeconds: 12,
    cooldownMinutes: 3,
    escalation: true,
    sound: false
  },
  general: {
    launchOnStartup: false,
    startHidden: false,
    hidePreview: false
  },
  calibration: null,
  onboarded: false
}

/** Deep-merge a possibly stale/partial persisted object over the defaults. */
export function mergeSettings(persisted: unknown): Settings {
  const p = (persisted ?? {}) as Partial<Settings>
  const base = structuredClone(DEFAULT_SETTINGS)
  if (typeof p !== 'object') return base
  const out: Settings = {
    ...base,
    ...p,
    issues: { ...base.issues },
    notifications: { ...base.notifications, ...(p.notifications ?? {}) },
    general: { ...base.general, ...(p.general ?? {}) },
    calibration: p.calibration ?? null
  }
  for (const id of Object.keys(base.issues) as IssueId[]) {
    out.issues[id] = { ...base.issues[id], ...(p.issues?.[id] ?? {}) }
    const ns = out.issues[id].notifyStages
    if (!Array.isArray(ns) || ns.length !== 3) out.issues[id].notifyStages = [true, true, true]
    out.issues[id].sensitivity = Math.min(2, Math.max(0.5, Number(out.issues[id].sensitivity) || 1))
  }
  out.notifications.dwellSeconds = Math.min(30, Math.max(5, Number(out.notifications.dwellSeconds) || 12))
  out.notifications.cooldownMinutes = Math.min(10, Math.max(1, Number(out.notifications.cooldownMinutes) || 3))
  return out
}
