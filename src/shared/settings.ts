import { DEFAULT_AI_SETTINGS, mergeAiSettings, type AiSettings } from './ai'
import { isCurrentBaseline, type CalibrationBaseline, type IssueId } from './posture'

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
  /** a worse stage that holds for ESC_DWELL notifies even during the quiet period (≥ ESC_MIN_GAP apart) */
  escalation: boolean
  sound: boolean
}

/**
 * How the live preview draws what the pose model sees. 'skeleton' is the
 * "Lines" view: the ear–shoulder–hip alignment the AI measures (the default).
 * 'hologram' is legacy (Mesh with a dimmed camera): mergeSettings migrates it to
 * 'mesh' + meshBackdrop 'dim', so switching styles can never lose the dim choice.
 */
export type OverlayStyle = 'skeleton' | 'mesh' | 'hologram' | 'off'

export const OVERLAY_STYLES: readonly OverlayStyle[] = ['skeleton', 'mesh', 'hologram', 'off']

/** Bumped when a settings migration must run once over older files. */
export const SETTINGS_VERSION = 2

/** Fixed overlay hues; 'posture' follows the stage colors, 'custom' uses customColor. */
export const OVERLAY_PRESETS = {
  ice: '#cfe6ff',
  cyan: '#44d7f0',
  violet: '#a58bff',
  magenta: '#f266c8',
  lime: '#b6ec5c',
  gold: '#f5c65b',
  white: '#f4f0e8'
} as const

export type OverlayPreset = keyof typeof OVERLAY_PRESETS
export type OverlayColor = 'posture' | OverlayPreset | 'custom'

export interface OverlaySettings {
  style: OverlayStyle
  color: OverlayColor
  /** #rrggbb, used when color === 'custom' */
  customColor: string
  /** mesh/hologram fill strength 0.15–1 (lower = more of the person shows through) */
  meshIntensity: number
  /** what shows behind the Mesh style: the plain camera image, or a dimmed one ("Dim camera behind mesh") */
  meshBackdrop: 'camera' | 'dim'
}

export const MESH_INTENSITY_RANGE = { min: 0.15, max: 1, default: 0.4 } as const

export interface BreakSettings {
  /** remind to stand up after a continuous sitting stretch */
  enabled: boolean
  /** sitting minutes before the reminder (20–120) */
  intervalMinutes: number
}

export const BREAK_INTERVAL_RANGE = { min: 20, max: 120, default: 50 } as const

export interface UpdateSettings {
  /**
   * Ask GitHub for a newer version 30 s after start and every 6 h (src/main/updater.ts).
   * Off = no automatic network request at all; "Check for updates" still works.
   */
  autoCheck: boolean
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
  overlay: OverlaySettings
  breaks: BreakSettings
  /** app updates from GitHub Releases */
  updates: UpdateSettings
  calibration: CalibrationBaseline | null
  /** connected AI models (docs/specs/ai-providers.md) */
  ai: AiSettings
  /** user has seen the close-to-tray coach mark */
  onboarded: boolean
  settingsVersion: number
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
  overlay: {
    style: 'skeleton',
    color: 'posture',
    customColor: '#44d7f0',
    meshIntensity: MESH_INTENSITY_RANGE.default,
    meshBackdrop: 'camera'
  },
  breaks: {
    enabled: true,
    intervalMinutes: BREAK_INTERVAL_RANGE.default
  },
  updates: {
    autoCheck: true
  },
  calibration: null,
  ai: DEFAULT_AI_SETTINGS,
  onboarded: false,
  settingsVersion: SETTINGS_VERSION
}

/** a finite number clamped into range; anything else falls back to the default */
function clampNum(v: unknown, r: { min: number; max: number; default: number }): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return r.default
  return Math.min(r.max, Math.max(r.min, v))
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** a real boolean, else the default — "false" (a string) is truthy and must never pass */
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
/** only plain objects are spread: a string or array would spread "0","1",… keys into the saved file */
const obj = (v: unknown): Record<string, unknown> => (isPlainObject(v) ? v : {})

/** Deep-merge a possibly stale/partial persisted object over the defaults. */
export function mergeSettings(persisted: unknown): Settings {
  const p = (persisted ?? {}) as Partial<Settings>
  const base = structuredClone(DEFAULT_SETTINGS)
  if (typeof p !== 'object') return base
  const pn = obj(p.notifications)
  const pg = obj(p.general)
  const pIssues = obj(p.issues)
  const out: Settings = {
    ...base,
    ...p,
    issues: { ...base.issues },
    notifications: { ...base.notifications, ...pn },
    general: { ...base.general, ...pg },
    overlay: { ...base.overlay, ...obj(p.overlay) },
    breaks: { ...base.breaks, ...obj(p.breaks) },
    updates: {
      autoCheck: isPlainObject(p.updates) && typeof p.updates['autoCheck'] === 'boolean' ? p.updates['autoCheck'] : base.updates.autoCheck
    },
    // v1 (frontal-camera) baselines are meaningless to the v2 engine — re-run setup
    calibration: isCurrentBaseline(p.calibration) ? p.calibration : null,
    ai: mergeAiSettings(p.ai),
    onboarded: p.onboarded === true,
    settingsVersion: SETTINGS_VERSION
  }
  const fromVersion = typeof p.settingsVersion === 'number' ? p.settingsVersion : 1
  // v1 shipped the full-body mesh as the default preview; v2's default is the
  // calmer alignment-lines view. Files from v1 still carry the old default.
  if (fromVersion < 2 && out.overlay.style === 'mesh') out.overlay.style = 'skeleton'
  for (const id of Object.keys(base.issues) as IssueId[]) {
    const pi = obj(pIssues[id])
    out.issues[id] = { ...base.issues[id], ...pi }
    out.issues[id].enabled = bool(pi['enabled'], base.issues[id].enabled)
    const ns = pi['notifyStages']
    out.issues[id].notifyStages =
      Array.isArray(ns) && ns.length === 3 ? [bool(ns[0], true), bool(ns[1], true), bool(ns[2], true)] : [true, true, true]
    out.issues[id].sensitivity = Math.min(2, Math.max(0.5, Number(out.issues[id].sensitivity) || 1))
  }
  // boolean switches: a hand-edited or buggy "false" string is truthy (would register
  // launch-at-login, keep nudging) while the UI toggles render the opposite state
  out.notifications.enabled = bool(pn['enabled'], base.notifications.enabled)
  out.notifications.escalation = bool(pn['escalation'], base.notifications.escalation)
  out.notifications.sound = bool(pn['sound'], base.notifications.sound)
  for (const k of ['launchOnStartup', 'startHidden', 'hidePreview'] as const) out.general[k] = bool(pg[k], base.general[k])
  out.notifications.dwellSeconds = Math.min(30, Math.max(5, Number(out.notifications.dwellSeconds) || 12))
  out.notifications.cooldownMinutes = Math.min(10, Math.max(1, Number(out.notifications.cooldownMinutes) || 3))
  if (typeof out.cameraDeviceId !== 'string' || out.cameraDeviceId === '') out.cameraDeviceId = null
  // enum fields from stale files must fall back, not poison frame pacing etc.
  // (hasOwn, not `in`: `in` also matches inherited keys like 'toString')
  if (typeof out.performancePreset !== 'string' || !Object.hasOwn(PRESET_FPS, out.performancePreset)) out.performancePreset = 'balanced'
  if (!['auto', 'GPU', 'CPU'].includes(out.delegate)) out.delegate = 'auto'
  if (out.resolvedDelegate !== 'GPU' && out.resolvedDelegate !== 'CPU') out.resolvedDelegate = null
  if (out.overlay.meshBackdrop !== 'camera' && out.overlay.meshBackdrop !== 'dim') out.overlay.meshBackdrop = base.overlay.meshBackdrop
  // legacy 'hologram' = Mesh over a dimmed camera: the dim choice is its own field now
  if (out.overlay.style === 'hologram') {
    out.overlay.style = 'mesh'
    out.overlay.meshBackdrop = 'dim'
  }
  if (!OVERLAY_STYLES.includes(out.overlay.style)) out.overlay.style = base.overlay.style
  if (out.overlay.color !== 'posture' && out.overlay.color !== 'custom' && !Object.hasOwn(OVERLAY_PRESETS, out.overlay.color)) {
    out.overlay.color = base.overlay.color
  }
  if (typeof out.overlay.customColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(out.overlay.customColor)) {
    out.overlay.customColor = base.overlay.customColor
  }
  out.overlay.meshIntensity = clampNum(out.overlay.meshIntensity, MESH_INTENSITY_RANGE)
  if (typeof out.breaks.enabled !== 'boolean') out.breaks.enabled = base.breaks.enabled
  out.breaks.intervalMinutes = Math.round(clampNum(out.breaks.intervalMinutes, BREAK_INTERVAL_RANGE))
  return out
}
