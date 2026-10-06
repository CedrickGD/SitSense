// The renderer's single store (zustand). Written ONLY by the detection controller
// (src/renderer/src/detection/controller.ts) except the navigation / UI-flow fields
// (route, setupFlow, settingsCategory, historyView, the Coach handoff — through the
// actions below), `sitting` and `update` (App.tsx) and `settings` (via patchSettings). UI components
// read it with narrow selectors.
//
// Navigation (docs/specs/ui-v3.md §2.1): four places — 'live' | 'coach' | 'history' |
// 'settings' — plus the posture-setup FLOW, an overlay state (setupFlow.open), not a
// place. Legacy names from main / older code are mapped: 'dashboard' → Live,
// 'calibrate' → openSetup().
//
// Render-cost contract: `pose` changes up to 15× a second while the window is visible
// (never while hidden), `setup` up to the detection rate while setup runs, `snapshot`
// only when something on screen changes (or ~1×/s while visible, for durations).
// Subscribe to `pose` only from the small component that draws it.

import { create } from 'zustand'
import type { AiPostureReview } from '@shared/ai'
import type { AppRoute, PauseState, SittingState } from '@shared/ipc'
import type { DetectionStatus, PostureSnapshot, Stage, TodayStats, UpSource, ViewKind } from '@shared/posture'
import type { Settings } from '@shared/settings'
import type { UpdateStatus } from '@shared/update'
import type { BodyMesh } from '@renderer/overlay/bodyMesh'
import type { CheckId, CheckStatus } from '@renderer/posture/assess'
import type { SetupFailReason, SetupPhase } from '@renderer/posture/calibration'
import type { Landmark } from '@renderer/posture/types'
import type { BodySegment, OverlayGuide } from '@renderer/detection/pose-geometry'

export type { BodySegment, OverlayGuide }

// ───────────────────────────── posture setup ─────────────────────────────

/** 'idle' = no setup session (not started, cancelled, or suspended by a pause). */
export type SetupUiPhase = 'idle' | SetupPhase

/** One checklist row (assess.ts CHECK_IDS order = priority order). */
export interface SetupCheckUi {
  id: CheckId
  /** short label, e.g. "Head over shoulders" */
  label: string
  /**
   * 'good' ✓ · 'adjust' ◐ (+ instruction) · 'unknown' — can't be checked from this angle.
   * v3: an 'unknown' ESSENTIAL check (back, head) blocks auto-save (detection.md §7,
   * ui-v3.md §7.3–7.4); a non-essential one does not.
   */
  status: CheckStatus
  /** one concrete instruction when 'adjust', else null */
  instruction: string | null
}

/** What was measured for the saved baseline (Done screen: "Neck 9° · Trunk upright · …"). */
export interface BaselineSummary {
  view: ViewKind
  /** the posture was confirmed (local judge, or the cloud reviewer when one ran) */
  verified: boolean
  /** the user chose "Save this posture anyway" */
  forced: boolean
  /** degrees; + = ears ahead of the shoulders */
  neckFwdDeg: number
  /** degrees; + = leaning forward, − = reclined; null = not measurable from this view */
  trunkFwdDeg: number | null
  /** degrees; + = looking down */
  headPitchDeg: number | null
  /** degrees; + = left shoulder higher */
  shoulderTiltDeg: number | null
  /** degrees; + = left ear higher than the shoulder line */
  headRollDeg: number | null
  /** degrees; + = trunk leaning to the person's left */
  trunkLatDeg: number | null
  /** where gravity came from (thighs / hips / camera) */
  gravity: UpSource
}

/** The cloud reviewer's last answer in this setup (accepted → Done screen; rejected → coaching). */
export interface SetupReviewResult {
  /** connection label, e.g. "Google Gemini" */
  label: string
  model: string
  verdict: 'good' | 'adjust'
  /** one sentence */
  summary: string
  /** ≤ 3 imperative tips; the first one is also the session's coaching instruction on 'adjust' */
  instructions: string[]
  /**
   * the capture's essentials the on-device judge could not verify and the reviewer judged
   * ([] = it confirmed a capture verified on-device); absent on older results
   */
  covered?: CheckId[]
}

/**
 * Why the live assessment's essentials can't be verified (detection/setup-ui.ts viewFixOf):
 * camera fixes — 'hips' hidden or outside the picture · 'angle' the trunk lean can't be judged
 * from this direction · 'level' the camera looks tilted (rolled); posture fixes — 'lean' two
 * readings disagree as when leaning in ("sit back and look ahead") · 'head' the head is a
 * little past the limit, inside the margin for an imprecise gravity reference.
 */
export type SetupViewFix = 'hips' | 'angle' | 'level' | 'lean' | 'head'

export interface SetupUiState {
  phase: SetupUiPhase
  /** the wizard asked for setup but it is on hold: monitoring is paused (resumes by itself) */
  suspended: 'paused' | null
  /**
   * The one sentence to show large. null when nothing needs saying — the UI then shows
   * its own phase copy (searching: "Sit where you normally work…", holding: "That's it —
   * hold still.", reviewing / done copy).
   */
  instruction: string | null
  /** checklist rows; empty while 'idle' */
  checks: SetupCheckUi[]
  /** camera view (smoothed over ~2 s with hysteresis); null while not in view */
  view: ViewKind | null
  /** why an essential can't be verified right now (null: nothing unverified; absent = not known) */
  viewFix?: SetupViewFix | null
  /** 0..1 while holding (1.5 s ring), 1 afterwards */
  holdProgress: number
  /** 0..1 while capturing (3 s ring), 1 afterwards */
  captureProgress: number
  /** show "Save this posture anyway" → detectionController.forceSetup() */
  canForce: boolean
  /** false after repeated reviewer rejections: no automatic capture until restartSetup()/forceSetup() */
  autoCapture: boolean
  /** the running/last capture was forced */
  forced: boolean
  /** set in 'failed' (shown ~2.5 s, then setup restarts by itself — no Retry button needed) */
  failReason: SetupFailReason | null
  /** plain message for failReason, e.g. "Hold still for a moment." */
  failMessage: string | null
  /** message about the saved baseline (e.g. back angle not verifiable from this camera), else null */
  notice: string | null
  /** checks the local judge could not verify from this camera */
  unverifiedChecks: CheckId[]
  /**
   * v3: an essential check can't be verified from this camera, so the session keeps
   * coaching instead of holding (SetupState.needsVerification — detection.md §7).
   * Optional until setup-ui.ts maps it; treat undefined as false.
   */
  needsVerification?: boolean
  /** a cloud reviewer is being asked right now: "Asking <label> to double-check…" */
  reviewing: { label: string } | null
  /** short note when the review could not run, e.g. "AI check unavailable: … — used on-device judgment." */
  reviewNote: string | null
  /** the reviewer's last answer in this setup (null = none) */
  reviewResult: SetupReviewResult | null
  /** how many captures the reviewer rejected */
  reviewRejections: number
  /** set in 'done' */
  baselineSummary: BaselineSummary | null
  /** saving the baseline failed (settings write rejected) */
  saveError: string | null
}

export const IDLE_SETUP: SetupUiState = {
  phase: 'idle',
  suspended: null,
  instruction: null,
  checks: [],
  view: null,
  viewFix: null,
  holdProgress: 0,
  captureProgress: 0,
  canForce: false,
  autoCapture: true,
  forced: false,
  failReason: null,
  failMessage: null,
  notice: null,
  unverifiedChecks: [],
  needsVerification: false,
  reviewing: null,
  reviewNote: null,
  reviewResult: null,
  reviewRejections: 0,
  baselineSummary: null,
  saveError: null
}

// ───────────────────────────── live pose (Lines overlay) ─────────────────────────────

/**
 * The latest pose for the Lines overlay. Written ≤ 15 Hz and only while the window is
 * visible (null while hidden, paused, or with no person in view).
 *
 * Coordinates: `image` is MediaPipe's 33 normalized landmarks (x by width, y by height,
 * y down) of the RAW camera frame — the preview video is mirrored with CSS, so mirror the
 * overlay the same way (e.g. `-scale-x-100` on the SVG). Draw in an SVG with
 * viewBox `0 0 100 100/aspect` and preserveAspectRatio "xMidYMid slice" (matches
 * object-cover): point = (x·100, y·100/aspect). That space is isotropic, so
 * `guide.up2d` can be used as-is: the true-vertical line through the shoulder is
 * shoulder ± t·up2d (in viewBox units: (x·100 + t·up2d[0], y·100/aspect + t·up2d[1])).
 */
export interface PoseOverlayData {
  image: readonly Landmark[]
  /** video width / height */
  aspect: number
  /**
   * Derived from the posture features; null when the frame isn't GOOD (head + a shoulder
   * not in view) — draw the landmarks without the guide then.
   */
  guide: OverlayGuide | null
  /**
   * Worst active issue stage per body segment (0 = fine): neck = head forward,
   * trunk = slouching, shoulders = leaning, head = too close (ISSUE_SEGMENT in
   * detection/pose-geometry.ts). With a fixed overlay hue, color a segment by its stage.
   */
  segments: Record<BodySegment, Stage>
}

// ───────────────────────────── Ask AI ─────────────────────────────

export type AiReviewOk = Extract<AiPostureReview, { ok: true }>

export interface AiCheckState {
  status: 'idle' | 'pending' | 'done' | 'error'
  /** connection asked (pending) or that answered (done); null when idle */
  label: string | null
  /** set when 'done': score 0–100, one-sentence summary, ≤ 3 instructions, model */
  review: AiReviewOk | null
  /** set when 'error': one short plain sentence */
  message: string | null
}

export const IDLE_AI_CHECK: AiCheckState = { status: 'idle', label: null, review: null, message: null }

// ───────────────────────────── camera / detector health ─────────────────────────────

export interface CameraUiState {
  /** device actually opened (MediaTrackSettings.deviceId), null when none / unknown */
  activeDeviceId: string | null
  /** its label, e.g. "Integrated Camera" */
  activeLabel: string | null
  /**
   * The camera chosen in Settings couldn't be opened and another camera is in use;
   * SitSense switches back as soon as it is connected again. Show e.g.
   * "Using <activeLabel> — <preferred> isn't connected".
   */
  usingFallback: boolean
}

/**
 * Detector trouble that isn't the camera's fault:
 * 'model' — the posture model failed to load (retrying slowly; suggest switching the
 *           processing mode in Settings or reinstalling);
 * 'inference' — the model stopped working and is being rebuilt ("Detection stopped — restarting…").
 */
export type DetectorError = 'model' | 'inference' | null
/** why detectorError is 'model' when it is not a plain load failure: no WebGL at all (copy differs) */
export type DetectorErrorReason = 'no-webgl' | null

// ───────────────────────────── navigation (v3) ─────────────────────────────

/** The four places in the sidebar, in order (Ctrl+1…4). */
export const NAV_ROUTES = ['live', 'coach', 'history', 'settings'] as const
export type NavRoute = (typeof NAV_ROUTES)[number]

/** Anything a caller may navigate with: a place, or a legacy name from main / older code. */
export type RouteInput = NavRoute | AppRoute

/** Settings categories, in list order (ui-v3.md §6.2). */
export const SETTINGS_CATEGORIES = ['general', 'camera', 'detection', 'notifications', 'ai', 'privacy', 'about'] as const
export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]

export interface SetupFlowState {
  /** the full-window posture setup flow is showing (it replaces the shell) */
  open: boolean
  /** where Exit / Start monitoring return to */
  returnTo: NavRoute
  /** UI-only stepper position: 1 Camera · 2 Posture · 3 Saved (the setup screen sets it) */
  step: 1 | 2 | 3
}

export const CLOSED_SETUP_FLOW: SetupFlowState = { open: false, returnTo: 'live', step: 1 }

export type HistoryView = 'day' | 'week'

/**
 * A request handed from another screen to Coach (Live's coach card). Coach takes it once
 * with consumeCoachIntent(id), then sends the text / runs the posture check.
 */
export type CoachIntent = { id: number; kind: 'ask'; text: string } | { id: number; kind: 'check' }

/**
 * Where a route input leads: a place, or the setup flow. Pure (unit-tested).
 * 'dashboard' → live · 'calibrate' → setup · places map to themselves · anything else → live.
 */
export function resolveRoute(input: unknown): { route: NavRoute } | { setup: true } {
  if (input === 'calibrate') return { setup: true }
  if (input === 'dashboard') return { route: 'live' }
  if (typeof input === 'string' && (NAV_ROUTES as readonly string[]).includes(input)) return { route: input as NavRoute }
  return { route: 'live' }
}

// ───────────────────────────── the store ─────────────────────────────

export interface AppState {
  settings: Settings | null
  /**
   * Latest posture snapshot. NOTE: kept (frozen) while paused / camera off — gate any
   * "live" display on `!pause.paused && detection.running && !detection.cameraError`.
   */
  snapshot: PostureSnapshot | null
  detection: DetectionStatus
  detectorError: DetectorError
  detectorErrorReason: DetectorErrorReason
  camera: CameraUiState
  pause: PauseState
  cameras: { deviceId: string; label: string }[]
  /** the place shown in the content column (setup is NOT a route — see setupFlow) */
  route: NavRoute
  /** the full-window posture setup flow (openSetup() / closeSetup()) */
  setupFlow: SetupFlowState
  /** the Settings category shown (kept while elsewhere; tray "Settings" reopens it) */
  settingsCategory: SettingsCategoryId
  /** History's Day | Week switch (kept for the session) */
  historyView: HistoryView
  /** posture setup session state (from the controller) — drive with detectionController.startSetup() etc. */
  setup: SetupUiState
  /** live pose for the Lines overlay (see PoseOverlayData) */
  pose: PoseOverlayData | null
  /** body wireframe for the mesh/hologram preview styles (null = no person or not requested) */
  mesh: BodyMesh | null
  /** segmentation isn't available on this machine — mesh styles fall back to the skeleton */
  meshUnavailable: boolean
  /**
   * A saved baseline exists but was captured with a different camera than the one in
   * use: it is NOT applied (no posture alerts). Offer "Redo setup", or
   * detectionController.keepBaselineForThisCamera().
   */
  baselineCameraMismatch: boolean
  /** Ask AI on the dashboard — detectionController.askAi() / dismissAiCheck() */
  aiCheck: AiCheckState
  /** main window shown and not minimized */
  windowVisible: boolean
  today: TodayStats | null
  /** continuous sitting / break state from main (null until the first status arrives) */
  sitting: SittingState | null
  appVersion: string
  /** app updates from GitHub (main's update service; null until the first status arrives) */
  update: UpdateStatus | null
  /** a Coach reply is in flight (sidebar: sage dot on Coach while elsewhere) — Coach sets it */
  coachPending: boolean
  /** a question / posture check handed to Coach from another screen */
  coachIntent: CoachIntent | null

  /**
   * Navigate. Takes places and the legacy names: 'dashboard' → Live, 'calibrate' →
   * openSetup(). Going to a place while setup is open closes setup (the setup screen
   * unmounts, which cancels its session).
   */
  setRoute: (r: RouteInput) => void
  /** alias of setRoute */
  navigate: (r: RouteInput) => void
  /**
   * Open the posture-setup flow over the shell. The setup screen starts the session when
   * it mounts (detectionController.startSetup()) and cancels it when it unmounts.
   * returnTo defaults to the current place. No-op while already open.
   */
  openSetup: (returnTo?: NavRoute) => void
  /** Leave setup (nothing saved unless it already finished) and go back to returnTo. */
  closeSetup: () => void
  /** setup screen: move the header stepper (1 Camera · 2 Posture · 3 Saved) */
  setSetupStep: (step: 1 | 2 | 3) => void
  /** Go to Settings, optionally on a category (default: the last one shown). */
  openSettings: (category?: SettingsCategoryId) => void
  setSettingsCategory: (category: SettingsCategoryId) => void
  setHistoryView: (view: HistoryView) => void
  /** Live → Coach: go to Coach and send `text` there (empty text is ignored). */
  askCoach: (text: string) => void
  /** Live → Coach: go to Coach and run "Check my posture now". */
  checkPostureInCoach: () => void
  /** Coach: clear the pending intent once handled (only if it is still `id`). */
  consumeCoachIntent: (id: number) => void
  setCoachPending: (pending: boolean) => void
  patchSettings: (patch: unknown) => Promise<void>
}

let intentSeq = 0

export const useAppStore = create<AppState>((set, get) => ({
  settings: null,
  snapshot: null,
  detection: { running: false, delegate: null, targetFps: 10, measuredFps: 0, cameraError: null },
  detectorError: null,
  detectorErrorReason: null,
  camera: { activeDeviceId: null, activeLabel: null, usingFallback: false },
  pause: { paused: false, resumeAt: null },
  cameras: [],
  route: 'live',
  setupFlow: CLOSED_SETUP_FLOW,
  settingsCategory: 'general',
  historyView: 'day',
  setup: IDLE_SETUP,
  pose: null,
  mesh: null,
  meshUnavailable: false,
  baselineCameraMismatch: false,
  aiCheck: IDLE_AI_CHECK,
  windowVisible: true,
  today: null,
  sitting: null,
  appVersion: '',
  update: null,
  coachPending: false,
  coachIntent: null,

  setRoute: (input) => {
    const target = resolveRoute(input)
    if ('setup' in target) {
      get().openSetup()
      return
    }
    set((s) => (s.setupFlow.open ? { route: target.route, setupFlow: CLOSED_SETUP_FLOW } : { route: target.route }))
  },
  navigate: (input) => get().setRoute(input),
  openSetup: (returnTo) => {
    if (get().setupFlow.open) return
    set((s) => ({ setupFlow: { open: true, returnTo: returnTo ?? s.route, step: 1 } }))
  },
  closeSetup: () => {
    const { setupFlow } = get()
    if (!setupFlow.open) return
    set({ route: setupFlow.returnTo, setupFlow: CLOSED_SETUP_FLOW })
  },
  setSetupStep: (step) =>
    set((s) => (s.setupFlow.open && s.setupFlow.step !== step ? { setupFlow: { ...s.setupFlow, step } } : {})),
  openSettings: (category) => {
    get().setRoute('settings')
    if (category) set({ settingsCategory: category })
  },
  setSettingsCategory: (settingsCategory) => set({ settingsCategory }),
  setHistoryView: (historyView) => set({ historyView }),
  askCoach: (text) => {
    const t = text.trim()
    if (!t) return
    set({ coachIntent: { id: ++intentSeq, kind: 'ask', text: t } })
    get().setRoute('coach')
  },
  checkPostureInCoach: () => {
    set({ coachIntent: { id: ++intentSeq, kind: 'check' } })
    get().setRoute('coach')
  },
  consumeCoachIntent: (id) => set((s) => (s.coachIntent?.id === id ? { coachIntent: null } : {})),
  setCoachPending: (coachPending) => set({ coachPending }),
  patchSettings: async (patch) => {
    const settings = await window.sitsense.setSettings(patch)
    set({ settings })
  }
}))
