// Settings v3 (docs/specs/ui-v3.md §6, §10.5): category metadata, copy and the pure
// helpers behind the controls. Unit-tested in __tests__/meta.test.ts.

import type { IssueId } from '@shared/posture'
import { BREAK_AWAY_MINUTES } from '@shared/ipc'
import type { UpdateMode } from '@shared/update'
import {
  DEFAULT_SETTINGS,
  MESH_INTENSITY_RANGE,
  type OverlayStyle,
  type Settings
} from '@shared/settings'
import { DEFAULT_AI_SETTINGS } from '@shared/ai'
import type { IconName } from '@renderer/components/icons'
import type { SettingsCategoryId } from '@renderer/state/store'

// ───────────────────────────── categories ─────────────────────────────

export interface CategoryMeta {
  title: string
  /** one line in the category list */
  description: string
  /** the sentence under the category title */
  intro: string
  icon: IconName
}

export const CATEGORY_META: Record<SettingsCategoryId, CategoryMeta> = {
  general: {
    title: 'General',
    description: 'Startup, window and posture setup',
    intro: 'How SitSense starts and runs.',
    icon: 'settings'
  },
  camera: {
    title: 'Camera & preview',
    description: 'Camera, overlay style and colors',
    intro: 'Which camera SitSense uses and how the preview looks.',
    icon: 'camera'
  },
  detection: {
    title: 'Posture detection',
    description: 'Sensitivity and speed',
    intro: 'How strict SitSense is, per issue.',
    icon: 'spine'
  },
  notifications: {
    title: 'Notifications & breaks',
    description: 'Nudges, sounds and break reminders',
    intro: 'When and how SitSense nudges you.',
    icon: 'bell'
  },
  ai: {
    title: 'AI models',
    description: 'Connect your own model',
    intro: 'Connect your own model for second opinions and the coach.',
    icon: 'spark'
  },
  privacy: {
    title: 'Privacy & data',
    description: 'What stays on this PC',
    intro: 'What stays on this PC and what can leave it.',
    icon: 'shield'
  },
  about: {
    title: 'About',
    description: 'Version, updates and credits',
    intro: 'SitSense, version {v}.',
    icon: 'info'
  }
}

export function categoryIntro(id: SettingsCategoryId, version: string): string {
  const intro = CATEGORY_META[id].intro
  return intro.replace('{v}', version || '—')
}

// ───────────────────────────── layout ─────────────────────────────

/** How the category list is drawn (§6.1). */
export type CategoryNavMode = 'full' | 'compact' | 'chips'

/** Category list width in px for a nav mode (null = no side list). */
export const CATEGORY_NAV_WIDTH: Record<CategoryNavMode, number | null> = {
  full: 260,
  compact: 200,
  chips: null
}

/** The content column needs this much for the 2-column card grid (SettingsGrid). */
export const SETTINGS_GRID_MIN = 600
/** The list's focus-ring bleed (+8) and the gap between list and content (gap-6). */
const NAV_CHROME = 8 + 24

/**
 * Picks the list layout from the width Settings really has (not the window's): a side
 * list only while the cards beside it still get their 2-column grid. Otherwise the list
 * folds into a chip row so the cards use the full width — a wider window never ends up
 * with fewer columns than a narrower one.
 *
 * `prev` (the mode on screen) adds hysteresis: switching to a WIDER-list mode needs
 * NAV_MODE_HYSTERESIS px beyond the threshold, more than a scrollbar (10 px). The page
 * height depends on the mode (a side list makes the cards narrower, so taller), and a
 * scrollbar appearing/disappearing changes the measured width — without the margin those
 * two can feed each other and flip list ↔ chips every frame. Narrowing never waits, so
 * a side list never sits beside a 1-column grid.
 */
export const NAV_MODE_HYSTERESIS = 16
const NAV_MODE_RANK: Record<CategoryNavMode, number> = { chips: 0, compact: 1, full: 2 }

export function categoryNavMode(availableWidth: number, prev?: CategoryNavMode): CategoryNavMode {
  const fits = (mode: 'full' | 'compact'): boolean => {
    const margin = prev !== undefined && NAV_MODE_RANK[mode] > NAV_MODE_RANK[prev] ? NAV_MODE_HYSTERESIS : 0
    return availableWidth - (CATEGORY_NAV_WIDTH[mode] ?? 0) - NAV_CHROME >= SETTINGS_GRID_MIN + margin
  }
  if (fits('full')) return 'full'
  if (fits('compact')) return 'compact'
  return 'chips'
}

// ───────────────────────────── camera & preview ─────────────────────────────

/** The three styles the UI offers; the legacy 'hologram' is Mesh with a dimmed camera. */
export type PreviewStyle = 'skeleton' | 'mesh' | 'off'

export function previewStyleOf(style: OverlayStyle): PreviewStyle {
  return style === 'hologram' ? 'mesh' : style
}

export const STYLE_COPY: Record<PreviewStyle, string> = {
  skeleton: 'What the AI measures: ear, shoulder and hip joined by a line, next to true vertical.',
  mesh: 'A light wireframe over your whole body. You stay clearly visible.',
  off: 'Just the camera image.'
}

/** 0.15–1 → "45%" */
export function meshPercent(v: number): string {
  const c = Number.isFinite(v) ? Math.min(MESH_INTENSITY_RANGE.max, Math.max(MESH_INTENSITY_RANGE.min, v)) : MESH_INTENSITY_RANGE.default
  return `${Math.round(c * 100)}%`
}

// ───────────────────────────── posture detection ─────────────────────────────

export const SENSITIVITY_STEPS = [0.5, 0.75, 1.0, 1.5, 2.0] as const
export const SENSITIVITY_NAMES = ['Relaxed', 'Easygoing', 'Balanced', 'Attentive', 'Strict'] as const
export const SENSITIVITY_HINTS = [
  'Only flags big departures from your good posture.',
  'Lets small drifts slide.',
  'The recommended middle ground.',
  'Notices moderate drift early.',
  'Flags small departures from your good posture.'
] as const

/** The nearest of the 5 sensitivity steps. */
export function sensitivityIndex(v: number): number {
  let best = 0
  SENSITIVITY_STEPS.forEach((s, i) => {
    if (Math.abs(s - v) < Math.abs(SENSITIVITY_STEPS[best] - v)) best = i
  })
  return best
}

export const ISSUE_WATCHES: Record<IssueId, string> = {
  sink: 'Watches your back angle and how far you sink.',
  headForward: 'Watches how far your head drifts ahead of your shoulders.',
  lean: 'Watches side lean and tilted shoulders.',
  tooClose: 'Watches how close you get to the screen.'
}

export const DELEGATE_LABEL: Record<Settings['delegate'], string> = {
  auto: 'Auto',
  GPU: 'Graphics card',
  CPU: 'Processor'
}

// ───────────────────────────── notifications ─────────────────────────────

/** notifyStages → threshold model: contiguous [k..3] reads as "from stage k". */
export function notifyFrom(stages: readonly [boolean, boolean, boolean]): 1 | 2 | 3 | 'custom' | 'none' {
  const key = stages.map((b) => (b ? '1' : '0')).join('')
  if (key === '111') return 1
  if (key === '011') return 2
  if (key === '001') return 3
  if (key === '000') return 'none'
  return 'custom'
}

/** "from stage k" → notifyStages */
export function stagesFrom(k: 1 | 2 | 3): [boolean, boolean, boolean] {
  return [k <= 1, k <= 2, true]
}

/**
 * The first phrasing of each issue × stage — mirrors COPY[issue][stage][0] in
 * src/main/notification-copy.ts (main owns the real pool; the preview shows one).
 */
export const TOAST_PREVIEW: Record<IssueId, Record<1 | 2 | 3, { title: string; body: string }>> = {
  sink: {
    1: { title: 'Sinking a little', body: 'A gentle lift through the chest fixes it.' },
    2: { title: "You've settled into a slouch", body: 'Roll your shoulders back and sit tall.' },
    3: { title: 'Deep slouch, 6 min now', body: 'Worth a reset: sit back, feet flat, spine tall.' }
  },
  headForward: {
    1: { title: "Head's creeping forward", body: 'Tuck your chin back a touch.' },
    2: { title: "Head's well past your shoulders", body: 'Bring your ears back over them.' },
    3: { title: "Neck's doing all the work", body: 'Chin back and screen up — your neck will thank you.' }
  },
  lean: {
    1: { title: 'Listing to the left', body: 'Re-center over both sit bones.' },
    2: { title: 'Propped up on one side', body: 'Level your shoulders and square up to the screen.' },
    3: { title: 'Strong lean, 6 min now', body: 'Plant both feet and re-center — maybe stretch that side.' }
  },
  tooClose: {
    1: { title: 'Drifting toward the screen', body: 'Ease back a few centimeters.' },
    2: { title: 'Getting close to the screen', body: 'Sit back — about an arm’s length is right.' },
    3: { title: 'Nose-to-screen territory', body: 'Push back from the desk and reset your distance.' }
  }
}

/** Minutes away from the desk that end a sitting stretch (shared; main/break-tracker.ts). */
export { BREAK_AWAY_MINUTES }

export function breakHint(awayMinutes: number = BREAK_AWAY_MINUTES): string {
  return `SitSense notices when you leave your desk — walking away for ${awayMinutes} minutes counts as a break. No need to tell it.`
}

// ───────────────────────────── privacy & data ─────────────────────────────

/**
 * "Reset all settings": every setting back to its default, except what the user would
 * lose for good — the saved posture, AI connections and keys. Main strips
 * `ai.connections` from a settings patch anyway; it is omitted here too.
 */
export function resetPatch(): Record<string, unknown> {
  const d = structuredClone(DEFAULT_SETTINGS)
  return {
    cameraDeviceId: d.cameraDeviceId,
    performancePreset: d.performancePreset,
    delegate: d.delegate,
    issues: d.issues,
    notifications: d.notifications,
    general: d.general,
    overlay: d.overlay,
    breaks: d.breaks,
    updates: d.updates,
    ai: { enabled: DEFAULT_AI_SETTINGS.enabled, share: DEFAULT_AI_SETTINGS.share, useInSetup: DEFAULT_AI_SETTINGS.useInSetup }
  }
}

/** True when nothing a reset would change differs from the defaults. */
export function isAtDefaults(s: Settings): boolean {
  const patch = resetPatch()
  const pick = {
    cameraDeviceId: s.cameraDeviceId,
    performancePreset: s.performancePreset,
    delegate: s.delegate,
    issues: s.issues,
    notifications: s.notifications,
    general: s.general,
    overlay: s.overlay,
    breaks: s.breaks,
    updates: s.updates,
    ai: { enabled: s.ai.enabled, share: s.ai.share, useInSetup: s.ai.useInSetup }
  }
  return stableJson(pick) === stableJson(patch)
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val
  )
}

/**
 * Privacy › Can leave this PC: what an update check sends and fetches (src/main/updater.ts).
 * An installed copy downloads a newer installer in the background right after the check
 * (autoDownload); a portable copy only checks. Unknown mode (status not loaded yet) reads
 * as installed, so the line never under-states the traffic.
 */
export function updateCheckLine(autoCheck: boolean, mode: UpdateMode | null): string {
  if (mode === 'portable') {
    return autoCheck
      ? 'Update checks: SitSense asks GitHub for its latest version shortly after it starts and every 6 hours. No posture data, camera image or settings are sent.'
      : 'Update checks: only when you press “Check for updates” in About. No posture data, camera image or settings are sent.'
  }
  return autoCheck
    ? 'Update checks: SitSense asks GitHub for its latest version shortly after it starts and every 6 hours, and downloads a newer version from GitHub in the background when there is one. No posture data, camera image or settings are sent.'
    : 'Update checks: only when you press “Check for updates” in About (a newer version then downloads right away). No posture data, camera image or settings are sent.'
}

/** Privacy › Can leave this PC with AI off and automatic checks on: the summary sentence. */
export function updateOnlyRequestLine(mode: UpdateMode | null): string {
  return mode === 'portable'
    ? 'With AI models off, the only request SitSense makes is asking GitHub for its latest version.'
    : 'With AI models off, SitSense only talks to GitHub: it asks for its latest version and downloads a newer one in the background when there is one.'
}

/** "2 keys, encrypted with Windows" / "No keys saved" */
export function keysLine(connections: readonly { hasKey: boolean }[]): string {
  const n = connections.filter((c) => c.hasKey).length
  if (n === 0) return 'No keys saved'
  return `${n} ${n === 1 ? 'key' : 'keys'}, encrypted with Windows`
}

/** "12 days" / "1 day" / "Nothing yet" */
export function historyLine(daysWithData: number | null): string {
  if (daysWithData === null) return '—'
  if (daysWithData <= 0) return 'Nothing yet'
  return `${daysWithData} ${daysWithData === 1 ? 'day' : 'days'}`
}

// ───────────────────────────── about ─────────────────────────────

export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['Ctrl', '1…4'], label: 'Switch places' },
  { keys: ['Ctrl', ','], label: 'Open Settings' },
  { keys: ['Ctrl', 'L'], label: 'Ask the coach' },
  { keys: ['Ctrl', 'Shift', 'P'], label: 'Pause or resume' },
  { keys: ['Ctrl', 'W'], label: 'Hide to the tray' },
  { keys: ['Esc'], label: 'Leave posture setup' }
]

