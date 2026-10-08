import type { FaceLandmarker, PoseLandmarker, PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import { aiErrorMessage, type AiPostureReview, type AiReviewRequest } from '@shared/ai'
import { ISSUES, type CalibrationBaseline, type DetectionStatus, type PostureSnapshot } from '@shared/posture'
import { PRESET_FPS, type Settings } from '@shared/settings'
import {
  aiAvailable,
  aiReviewsSetup,
  measurementsFromBaseline,
  measurementsFromFeatures,
  primaryAiConnection
} from '@renderer/ai/helpers'
import { makeSketch, makeSnapshot } from '@renderer/ai/review-image'
import { BodyMeshBuilder, type BodyMesh, type FaceInput } from '@renderer/overlay/bodyMesh'
import { assessPosture } from '@renderer/posture/assess'
import { SetupSession, medianFeatures, type SetupPhase, type SetupState } from '@renderer/posture/calibration'
import { PostureEngine, baselineNeckLatRef, type EngineSettings } from '@renderer/posture/engine'
import { pickUser, posePoint, type PosePoint } from '@renderer/posture/select'
import type { Frame, PoseFrame, PostureFeatures } from '@renderer/posture/types'
import {
  IDLE_AI_CHECK,
  IDLE_SETUP,
  useAppStore,
  type AiCheckState,
  type CameraUiState,
  type DetectorError,
  type DetectorErrorReason
} from '@renderer/state/store'
import { CameraOpenError, listCameras, openCamera, stopStream } from './camera'
import { FrameLoop } from './frame-loop'
import { createFaceLandmarker, createLandmarker, faceMeshTopology, recreateAsCpu, webglAvailable } from './landmarker'
import { overlayGuide, segmentStages } from './pose-geometry'
import {
  IDLE_PROBE,
  NO_EXTRAS,
  SetupProbe,
  SetupViewTracker,
  publishProbe,
  reviewFailNote,
  reviewOutcome,
  setupReviewMeasurements,
  summarizeBaseline,
  toSetupUi,
  unverifiedPhrase,
  type SetupExtras,
  type SetupUi
} from './setup-ui'

const SNAPSHOT_MIN_INTERVAL_MS = 1000
/** the store's snapshot is refreshed at least this often while the window is visible (durations tick) */
const UI_SNAPSHOT_INTERVAL_MS = 1000
/** the Lines overlay data is published at most this often (≤ 15 Hz) */
const POSE_MIN_INTERVAL_MS = 1000 / 15 - 4
const FPS_WINDOW_MS = 2000
/** nobody in view for this long: the model looks for the user at IDLE_FPS (saves CPU and battery) */
const IDLE_AFTER_MS = 10_000
const IDLE_FPS = 4
/** the last picked pose is followed for this long when several poses are in view */
const PICK_FOLLOW_MS = 1500
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30000
/** model failures retry slowly (they no longer touch the camera, but cost CPU) */
const MODEL_RETRY_BASE_MS = 10000
const MODEL_RETRY_MAX_MS = 5 * 60000
/** a camera that opens but never delivers a frame (IR cam, shutter, half-dead driver) */
const FIRST_FRAME_TIMEOUT_MS = 8000
/** a muted track (Chromium: no frames arriving) for this long = stalled camera */
const MUTE_RESTART_MS = 5000
/** while another camera stands in for the preferred one, look for it this often */
const FALLBACK_RECHECK_MS = 15000
/** persistent inference failure: this many in a row, or no success for this long */
const INFER_FAIL_MAX = 10
const INFER_FAIL_MS = 3000
/** a rebuild this long after the previous one counts as a fresh incident */
const REBUILD_FORGET_MS = 60000
/** a failed setup capture is shown this long before setup restarts by itself */
const SETUP_FAIL_SHOW_MS = 2500
/** Ask AI needs a GOOD frame at most this old; the measurements use this much history */
const RECENT_MS = 1500

const NOT_PAUSED_MSG = 'Monitoring is paused — resume it to ask.'
const NO_AI_MSG = 'Turn on a connected AI model in Settings → AI models first.'
const NOT_IN_VIEW_MSG = "SitSense can't see you right now — sit in view and try again."

class ModelLoadError extends Error {
  readonly reason: DetectorErrorReason
  constructor(cause: unknown, reason: DetectorErrorReason = null) {
    super('posture model failed to load')
    this.cause = cause
    this.reason = reason
  }
}

/** Waits until the element has a decoded frame; false on timeout or when its source is removed. */
let requestSeq = 0
/** a fresh name for one posture review (validateRequestId: letters, digits, '-', '_') */
const newRequestId = (kind: 'setup' | 'check'): string =>
  `${kind}-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`

/** Tell main to drop a review the renderer abandoned (best effort; never throws). */
function cancelReviewInMain(requestId: string | null): void {
  if (!requestId) return
  const api = window.sitsense
  if (typeof api?.aiCancelReview !== 'function') return
  try {
    void api.aiCancelReview(requestId).catch(() => undefined)
  } catch {
    // main also frees the slot when the review finishes
  }
}

function waitForFirstFrame(video: HTMLVideoElement, timeoutMs: number): Promise<boolean> {
  if (video.readyState >= 2) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener('loadeddata', onData)
      video.removeEventListener('playing', onData)
      video.removeEventListener('emptied', onEmptied)
      resolve(ok)
    }
    const onData = (): void => {
      if (video.readyState >= 2) done(true)
    }
    const onEmptied = (): void => done(false)
    const timer = setTimeout(() => done(video.readyState >= 2), timeoutMs)
    video.addEventListener('loadeddata', onData)
    video.addEventListener('playing', onData)
    video.addEventListener('emptied', onEmptied)
    video.play().catch(() => undefined)
  })
}

interface RecentGood {
  t: number
  frame: PoseFrame
  f: PostureFeatures
}

/**
 * Owns the camera stream, the MediaPipe landmarker, the frame loop, the posture engine
 * and the setup session; bridges their results into the zustand store (contract:
 * state/store.ts) and main-process IPC. Pausing releases the camera completely (webcam
 * LED off — trust signal).
 *
 * Public API (for the UI):
 * - init(), getStream(), acquireMesh()
 * - start(), restart(), stopCapture(), retryCamera()
 * - startSetup() (step 1: camera check), beginSetupCoaching() (step 2), cancelSetup(),
 *   forceSetup(), restartSetup(), skipSetupReview()
 * - askAi(), dismissAiCheck()
 * - keepBaselineForThisCamera()
 */
class DetectionController {
  private video: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private landmarker: PoseLandmarker | null = null
  private delegate: 'GPU' | 'CPU' | null = null
  private loop: FrameLoop | null = null
  private engine: PostureEngine | null = null
  private settings: Settings | null = null

  /** preview components currently drawing the body mesh */
  private meshConsumers = 0
  private windowVisible = true
  /** a visibility event already arrived — newer than the status snapshot */
  private visibilityKnown = false
  /** the landmarker currently emits segmentation masks */
  private masksOn = false
  private masksFailed = false
  private meshBuilder = new BodyMeshBuilder()
  /** face mesh for the wireframe's face — alive only while masks are on */
  private face: FaceLandmarker | null = null
  private faceLoading = false
  private faceGpuBroken = false
  private faceFailed = false
  /** bumped on every release, so a load still in flight can't be adopted afterwards */
  private faceGen = 0
  /** how long the last frame took, all models included */
  private frameCostMs = 0
  /** since when nobody (no pose that could be the user) is in view while away; inference idles */
  private awaySince: number | null = null
  private idle = false
  /** where the last picked pose was (several poses in view: the user is followed) */
  private userAt: { p: PosePoint; t: number } | null = null

  // ---- camera / start lifecycle ----
  private starting = false
  private pendingRestart = false
  private wantRunning = false
  /** bumped by every camera release: an in-flight start() notices and bails out */
  private captureGen = 0
  /** bumped whenever the landmarker is replaced or discarded */
  private modelGen = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_BASE_MS
  private modelRetryDelay = MODEL_RETRY_BASE_MS
  private muteTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackTimer: ReturnType<typeof setInterval> | null = null
  private activeDeviceId: string | null = null
  private usingFallback = false

  // ---- inference health ----
  private firstInferenceOk = false
  private inferFailures = 0
  private lastInferOkAt = 0
  private rebuilds = 0
  private lastRebuildAt = 0

  // ---- baseline ----
  /** JSON (without cameraDeviceId) of the baseline currently applied to the engine */
  private appliedBaselineKey = 'null'

  // ---- setup ----
  /** the wizard is open and wants a setup session (survives pauses) */
  private setupWanted = false
  /**
   * 'camera' = setup step 1: only the camera check runs (SetupProbe → useSetupProbe), no
   * session, so nothing can be captured before the user starts coaching; 'coach' = step 2+.
   */
  private setupStage: 'camera' | 'coach' = 'camera'
  private probe = new SetupProbe()
  /** step 2's camera view chip (smoothed, with hysteresis) */
  private setupView = new SetupViewTracker()
  private session: SetupSession | null = null
  private sessionDeviceId: string | null = null
  private lastSetupPhase: SetupPhase | null = null
  private lastSetupState: SetupState | null = null
  private setupExtras: SetupExtras = NO_EXTRAS
  private setupUiKey = ''
  /** last GOOD frame pushed to the setup session (for the review sketch) */
  private lastSetupGood: { frame: PoseFrame; f: PostureFeatures } | null = null
  private reviewToken = 0
  /** main's name for the setup review in flight (freed with aiCancelReview when abandoned) */
  private setupReqId: string | null = null
  private failTimer: ReturnType<typeof setTimeout> | null = null
  /** whether this setup can afford the cosmetic face model (decided once per session) */
  private faceDuringSetup = true

  // ---- Ask AI ----
  private recent: RecentGood[] = []
  private aiToken = 0
  /** main's name for the Ask AI review in flight */
  private aiReqId: string | null = null

  // ---- publishing ----
  private latestSnapshot: PostureSnapshot | null = null
  private lastUiSnapshotKey = ''
  private lastUiSnapshotAt = 0
  private lastPoseAt = 0
  private lastSnapshotSentAt = 0
  private lastSnapshotKey = ''
  private frameCount = 0
  private fpsWindowStart = 0
  private status: DetectionStatus = {
    running: false,
    delegate: null,
    targetFps: PRESET_FPS.balanced,
    measuredFps: 0,
    cameraError: null
  }

  async init(): Promise<void> {
    // listen before asking: the window may be shown while the status request is in flight
    window.sitsense.onWindowVisibility((visible) => this.onVisibility(visible))
    const [settings, appStatus] = await Promise.all([window.sitsense.getSettings(), window.sitsense.getAppStatus()])
    this.settings = settings
    this.engine = new PostureEngine(null, toEngineSettings(settings))
    this.syncBaseline()
    if (!this.visibilityKnown) this.windowVisible = appStatus.windowVisible
    useAppStore.setState({
      settings,
      pause: appStatus.pause,
      appVersion: appStatus.version,
      windowVisible: this.windowVisible
    })

    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.video.autoplay = true
    this.video.style.display = 'none'
    document.body.appendChild(this.video)

    window.sitsense.onSettingsChanged((next) => this.applySettings(next))
    window.sitsense.onPauseChanged((pause) => {
      useAppStore.setState({ pause })
      if (pause.paused) {
        // the camera goes off: setup is suspended (it restarts on resume while the wizard
        // is open), Ask AI is cancelled, and a camera/model error the user can't act on
        // while paused is cleared (resume re-probes)
        this.suspendSetup()
        this.cancelAiCheck()
        this.stopCapture()
        this.setDetectorError(null)
        this.updateStatus({ cameraError: null })
      } else {
        // setup is no longer paused, even if the camera can't start yet (busy, model error)
        this.unsuspendSetup()
        this.retryDelay = RETRY_BASE_MS
        void this.start()
      }
    })
    window.sitsense.onNavigate((route) => useAppStore.getState().setRoute(route))
    window.sitsense.onRequestCalibration(() => useAppStore.getState().setRoute('calibrate'))
    window.sitsense.onSystemResumed(() => {
      // camera streams and GPU contexts often die silently across sleep/resume:
      // rebuild the model and reopen the camera
      if (this.wantRunning) this.discardModels('system resumed', false)
    })
    navigator.mediaDevices.addEventListener('devicechange', () => void this.onDeviceChange())

    if (!appStatus.pause.paused) await this.start()
  }

  /**
   * A preview wants the body mesh. Segmentation costs extra work per frame, so
   * it only runs while at least one mesh preview is mounted AND the window is
   * on screen — never while SitSense sits in the tray.
   */
  acquireMesh(): () => void {
    this.meshConsumers++
    let released = false
    return () => {
      if (released) return
      released = true
      this.meshConsumers--
    }
  }

  private wantsMasks(): boolean {
    return this.meshConsumers > 0 && this.windowVisible && !this.masksFailed
  }

  /** The stream for preview <video> elements (shared MediaStream is fine). */
  getStream(): MediaStream | null {
    return this.stream
  }

  // ───────────────────────────── camera lifecycle ─────────────────────────────

  async start(): Promise<void> {
    this.wantRunning = true
    if (this.starting || !this.settings || !this.video) return
    this.starting = true
    this.clearRetry()
    // re-entry (retry / redundant resume): drop any existing loop and stream first
    this.releaseCamera()
    const gen = this.captureGen
    const video = this.video
    let opened: MediaStream | null = null
    /** stopCapture() ran during an await (pause, restart): this call is stale */
    const stale = (): boolean => gen !== this.captureGen || !this.wantRunning
    const bail = (): void => {
      if (opened && this.stream !== opened) stopStream(opened)
      // paused and resumed mid-start: open again once this call unwinds
      if (this.wantRunning) this.pendingRestart = true
    }
    try {
      // 1. the model first — a broken model must never switch the webcam on
      if (!this.landmarker) {
        const settings = this.settings
        const pref = settings.delegate === 'auto' && settings.resolvedDelegate ? settings.resolvedDelegate : settings.delegate
        const mGen = this.modelGen
        let created: Awaited<ReturnType<typeof createLandmarker>>
        if (!webglAvailable()) throw new ModelLoadError(new Error('no WebGL'), 'no-webgl')
        try {
          created = await createLandmarker(pref)
        } catch (err) {
          throw new ModelLoadError(err)
        }
        if (mGen !== this.modelGen || this.landmarker) {
          created.landmarker.close() // delegate changed while loading
        } else {
          this.landmarker = created.landmarker
          this.delegate = created.delegate
          this.masksOn = false
          this.firstInferenceOk = false
          this.inferFailures = 0
          // pin 'auto' only to what was actually probed: a GPU that worked, or one that failed
          const probed = created.delegate === 'GPU' || created.gpuFailed
          if (probed && settings.delegate === 'auto' && settings.resolvedDelegate !== created.delegate) {
            void window.sitsense.setSettings({ resolvedDelegate: created.delegate })
          }
        }
        if (stale()) return bail()
      }

      // 2. the camera
      const cam = await openCamera(this.settings.cameraDeviceId)
      opened = cam.stream
      if (stale()) return bail()
      this.stream = cam.stream
      this.activeDeviceId = cam.deviceId
      this.usingFallback = cam.fellBack
      this.setCameraUi({ activeDeviceId: cam.deviceId, activeLabel: cam.label || null, usingFallback: cam.fellBack })
      this.watchTrack(cam.stream)
      video.srcObject = cam.stream

      // 3. the first frame, bounded: a camera that never sends one must not wedge start()
      const gotFrame = await waitForFirstFrame(video, FIRST_FRAME_TIMEOUT_MS)
      if (stale()) return bail()
      if (!gotFrame) throw new CameraOpenError('in-use')
      void this.refreshCameraList()

      // 4. the loop (a fresh capture starts at the full rate)
      this.awaySince = null
      this.idle = false
      const fps = this.targetFps()
      this.loop = new FrameLoop(video, fps, () => this.processFrame(), { onStall: () => this.onLoopStall() })
      this.loop.start()
      this.retryDelay = RETRY_BASE_MS
      this.modelRetryDelay = MODEL_RETRY_BASE_MS
      this.fpsWindowStart = performance.now()
      this.frameCount = 0
      this.lastInferOkAt = performance.now()
      this.setDetectorError(null)
      this.updateStatus({ running: true, delegate: this.delegate, targetFps: fps, cameraError: null })
      this.syncBaseline()
      if (cam.fellBack) this.startFallbackRecheck()
      this.onCaptureStarted()
    } catch (err) {
      if (gen !== this.captureGen) {
        // released meanwhile: not our resources, not our error to show
        if (opened && this.stream !== opened) stopStream(opened)
        if (this.wantRunning) this.pendingRestart = true
        return
      }
      this.releaseCamera()
      if (opened) stopStream(opened)
      if (err instanceof CameraOpenError) {
        this.updateStatus({ running: false, cameraError: this.wantRunning ? err.kind : null })
        this.scheduleRetry('camera')
      } else {
        // model / asset failure — not the camera's fault, don't mislabel it
        console.error('[detection] start failed:', err)
        if (this.wantRunning) this.setDetectorError('model', err instanceof ModelLoadError ? err.reason : null)
        this.updateStatus({ running: false, cameraError: null })
        this.scheduleRetry('model')
      }
    } finally {
      this.starting = false
      if (this.pendingRestart) {
        this.pendingRestart = false
        void this.restart()
      }
    }
  }

  /** Releases everything camera-related and stops monitoring; the landmarker survives for restarts. */
  stopCapture(): void {
    this.wantRunning = false
    this.clearRetry()
    this.releaseCamera()
    this.updateStatus({ running: false, measuredFps: 0 })
  }

  async restart(): Promise<void> {
    if (this.starting) {
      this.pendingRestart = true
      return
    }
    const want = this.wantRunning
    this.stopCapture()
    if (want) await this.start()
  }

  /**
   * For camera/model error panels ("Try again", "Scan for cameras"): always does
   * something visible — resumes monitoring when paused, else re-probes right away.
   */
  retryCamera(): void {
    if (useAppStore.getState().pause.paused) {
      void window.sitsense.setPause(false)
      return
    }
    this.retryDelay = RETRY_BASE_MS
    this.modelRetryDelay = MODEL_RETRY_BASE_MS
    this.wantRunning = true
    void this.restart()
  }

  /** Stop the loop and the stream (wantRunning untouched). Any in-flight start() goes stale. */
  private releaseCamera(): void {
    this.captureGen++
    this.clearMuteTimer()
    this.stopFallbackRecheck()
    this.loop?.stop()
    this.loop = null
    stopStream(this.stream)
    this.stream = null
    if (this.video) this.video.srcObject = null
    this.meshBuilder.reset()
    this.releaseFace()
    this.recent = []
    // step 1's camera check must not keep "I can see you" (and an enabled Start) while no
    // frames arrive; publishing an unchanged idle probe is a no-op outside setup
    this.probe.reset()
    publishProbe(IDLE_PROBE)
    const s = useAppStore.getState()
    if (s.pose || s.mesh) useAppStore.setState({ pose: null, mesh: null })
  }

  private watchTrack(stream: MediaStream): void {
    const track = stream.getVideoTracks()[0]
    if (!track) return
    track.onended = () => {
      // unplugged / taken away: release it and reopen with backoff
      if (this.stream !== stream || !this.wantRunning) return
      console.warn('[detection] camera track ended')
      this.releaseCamera()
      this.updateStatus({ running: false, measuredFps: 0 })
      this.scheduleRetry('camera')
    }
    // Chromium mutes a video track whose source stops delivering frames
    track.onmute = () => {
      this.clearMuteTimer()
      this.muteTimer = setTimeout(() => {
        this.muteTimer = null
        if (this.stream === stream && track.muted && this.wantRunning) {
          console.warn('[detection] camera stopped sending frames — reopening it')
          void this.restart()
        }
      }, MUTE_RESTART_MS)
    }
    track.onunmute = () => this.clearMuteTimer()
  }

  private clearMuteTimer(): void {
    if (this.muteTimer) clearTimeout(this.muteTimer)
    this.muteTimer = null
  }

  /** The frame loop saw no new frame for a while (only trusted while the window is visible). */
  private onLoopStall(): void {
    if (!this.wantRunning || !this.windowVisible) return
    console.warn('[detection] no new camera frames — reopening the camera')
    void this.restart()
  }

  private async onDeviceChange(): Promise<void> {
    const cams = await this.refreshCameraList()
    if (!this.wantRunning) return
    if (this.status.cameraError) {
      void this.restart()
      return
    }
    if (this.usingFallback && cams && this.preferredPresent(cams)) void this.restart()
  }

  private preferredPresent(cams: { deviceId: string }[]): boolean {
    const preferred = this.settings?.cameraDeviceId
    return !!preferred && cams.some((c) => c.deviceId === preferred)
  }

  /** While another camera stands in, look for the preferred one (enumeration only — no LED). */
  private startFallbackRecheck(): void {
    this.stopFallbackRecheck()
    this.fallbackTimer = setInterval(() => {
      if (!this.wantRunning || !this.usingFallback) return this.stopFallbackRecheck()
      void this.refreshCameraList().then((cams) => {
        if (cams && this.usingFallback && this.wantRunning && this.preferredPresent(cams)) void this.restart()
      })
    }, FALLBACK_RECHECK_MS)
  }

  private stopFallbackRecheck(): void {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer)
    this.fallbackTimer = null
  }

  // ───────────────────────────── posture setup ─────────────────────────────

  /**
   * The setup flow opened (or "Redo setup"): step 1, the camera check. No session runs yet
   * — the probe reports what the camera can see (useSetupProbe) until beginSetupCoaching().
   */
  startSetup(): void {
    this.setupWanted = true
    this.setupStage = 'camera'
    this.dropSession()
    this.probe.reset()
    publishProbe(IDLE_PROBE)
    this.setSetupUi(useAppStore.getState().pause.paused ? { ...IDLE_SETUP, suspended: 'paused' } : IDLE_SETUP)
  }

  /** Setup step 2 ("Start coaching"): start a fresh AI-coached setup session. */
  beginSetupCoaching(): void {
    if (!this.setupWanted) return
    this.setupStage = 'coach'
    this.newSession()
  }

  /** The setup screen closed: discard the session, nothing saved (unless it was already done). */
  cancelSetup(): void {
    this.setupWanted = false
    this.setupStage = 'camera'
    this.dropSession()
    this.probe.reset()
    publishProbe(IDLE_PROBE)
    this.setSetupUi(IDLE_SETUP)
  }

  /** "Save this posture anyway" (only while setup.canForce). */
  forceSetup(): void {
    if (!this.session) return
    if (this.lastSetupPhase === 'reviewing') this.abandonSetupReview() // ignore the pending review
    if (this.session.force()) this.afterSetupStep(this.session.state)
  }

  /** "Start over" while coaching: back to searching (a done or missing session starts fresh). */
  restartSetup(): void {
    if (!this.setupWanted || this.setupStage !== 'coach') return
    if (!this.session || this.lastSetupPhase === 'done') {
      this.newSession()
      return
    }
    this.abandonSetupReview()
    this.clearFailTimer()
    this.setupExtras = { ...NO_EXTRAS }
    this.session.restart()
    this.afterSetupStep(this.session.state)
  }

  /**
   * Don't wait for the cloud reviewer. A capture the on-device judge verified is saved on
   * its verdict; one it could not verify is NOT saved — coaching continues (ui-v3.md §7.5).
   */
  skipSetupReview(): void {
    if (!this.session || this.lastSetupPhase !== 'reviewing') return
    this.abandonSetupReview()
    const unverified = this.lastSetupState?.unverifiedChecks ?? []
    const note =
      unverified.length > 0
        ? `Skipped the second opinion — I still can't check ${unverifiedPhrase(unverified)} from this angle.`
        : 'Skipped the second opinion — saved on the on-device check.'
    this.setupExtras = { ...this.setupExtras, reviewing: null, reviewNote: note }
    this.session.skipReview()
    this.afterSetupStep(this.session.state)
  }

  private setupRunning(): boolean {
    return this.session !== null && this.lastSetupPhase !== 'done'
  }

  private newSession(): void {
    this.dropSession()
    if (useAppStore.getState().pause.paused) {
      this.setSetupUi({ ...IDLE_SETUP, suspended: 'paused' })
      return
    }
    // nobody can see the coach (closed to the tray, minimized): no session runs hidden — it
    // starts when the window is shown again (onVisibility)
    if (!this.windowVisible) {
      this.setSetupUi(IDLE_SETUP)
      return
    }
    this.session = new SetupSession({
      review: aiReviewsSetup(this.settings),
      cameraDeviceId: this.activeDeviceId
    })
    this.sessionDeviceId = this.activeDeviceId
    this.setupExtras = { ...NO_EXTRAS }
    // a machine that can't fit the cosmetic face mesh into the setup frame rate
    // drops it for the setup rather than starve the baseline
    this.faceDuringSetup = this.frameCostMs < 0.6 * (1000 / Math.max(PRESET_FPS.balanced, this.presetFps()))
    this.afterSetupStep(this.session.state)
  }

  private dropSession(): void {
    this.abandonSetupReview()
    this.clearFailTimer()
    this.session = null
    this.lastSetupPhase = null
    this.lastSetupState = null
    this.lastSetupGood = null
    this.setupUiKey = ''
    this.setupView.reset()
    this.applyLoopFps()
  }

  /** Pause: the camera goes off, so the session can't continue; it restarts on resume. */
  private suspendSetup(): void {
    if (!this.setupWanted) return
    const done = this.lastSetupPhase === 'done'
    if (done) return // keep the Done screen
    this.dropSession()
    this.probe.reset()
    publishProbe(IDLE_PROBE)
    this.setSetupUi({ ...IDLE_SETUP, suspended: 'paused' })
  }

  /**
   * Resume: setup is no longer paused, even while the camera can't start yet (another app
   * holds it, the model fails) — the setup screen then shows that problem, not "paused".
   * onCaptureStarted() starts the probe or the session once the camera is open.
   */
  private unsuspendSetup(): void {
    if (!this.setupWanted || this.session) return // the Done screen keeps its session
    if (useAppStore.getState().setup.suspended) this.setSetupUi(IDLE_SETUP)
  }

  /** The camera (re)started. */
  private onCaptureStarted(): void {
    if (!this.setupWanted) return
    if (this.setupStage === 'camera') {
      this.probe.reset()
      this.setSetupUi(IDLE_SETUP)
      return
    }
    if (!this.session) {
      this.newSession()
      return
    }
    const phase = this.lastSetupPhase
    if (phase === 'done') return
    if (this.sessionDeviceId !== this.activeDeviceId) {
      // a different camera: the gravity estimate and the view are different too
      this.newSession()
      return
    }
    this.setupView.reset()
    // frames from before the gap must not merge with frames after it
    if (phase === 'holding' || phase === 'capturing') {
      this.session.restart()
      this.afterSetupStep(this.session.state)
    }
  }

  private pushSetup(frame: Frame, t: number): void {
    if (!this.session) return
    const st = this.session.push(frame, t)
    if (frame && st.features) this.lastSetupGood = { frame, f: st.features }
    this.setupView.push(st, t)
    this.afterSetupStep(st)
  }

  /** Reacts to phase changes (review, failure, done) and publishes the setup UI state. */
  private afterSetupStep(st: SetupState): void {
    this.lastSetupState = st
    if (st.phase !== this.lastSetupPhase) {
      const prev = this.lastSetupPhase
      this.lastSetupPhase = st.phase
      if (prev === 'reviewing') this.setupExtras = { ...this.setupExtras, reviewing: null }
      if (st.phase === 'reviewing') this.beginReview(st)
      if (st.phase === 'failed') this.scheduleSetupRecover()
      if (st.phase === 'done') this.saveBaseline(st)
      if (st.phase === 'searching' || st.phase === 'coaching') this.setupExtras = { ...this.setupExtras, saveError: null }
      this.applyLoopFps()
    }
    this.publishSetup(st)
  }

  private publishSetup(st: SetupState): void {
    this.setSetupUi(toSetupUi(st, this.setupExtras, this.setupView.view))
  }

  private setSetupUi(ui: SetupUi): void {
    const key = JSON.stringify(ui)
    if (key === this.setupUiKey) return
    this.setupUiKey = key
    useAppStore.setState({ setup: ui })
  }

  private republishSetup(): void {
    if (this.session) this.publishSetup(this.lastSetupState ?? this.session.state)
  }

  private scheduleSetupRecover(): void {
    this.clearFailTimer()
    const session = this.session
    this.failTimer = setTimeout(() => {
      this.failTimer = null
      if (this.session !== session || !session || this.lastSetupPhase !== 'failed') return
      session.restart()
      this.afterSetupStep(session.state)
    }, SETUP_FAIL_SHOW_MS)
  }

  private clearFailTimer(): void {
    if (this.failTimer) clearTimeout(this.failTimer)
    this.failTimer = null
  }

  /**
   * Ignore the setup review in flight and tell main to drop it, so its single review slot is
   * free for the next capture or an Ask AI check at once.
   */
  private abandonSetupReview(): void {
    this.reviewToken++
    cancelReviewInMain(this.setupReqId)
    this.setupReqId = null
  }

  /** Entered 'reviewing' (once per capture): ask the connected model to double-check. */
  private beginReview(st: SetupState): void {
    const session = this.session
    const baseline = session?.pendingBaseline
    if (!session || !baseline) return
    this.abandonSetupReview()
    const token = this.reviewToken
    const settings = this.settings
    const conn = primaryAiConnection(settings)
    // decided async so the phase bookkeeping of this step completes first
    const skip = (note: string): void => {
      void Promise.resolve().then(() => {
        if (token !== this.reviewToken || this.session !== session || this.lastSetupPhase !== 'reviewing') return
        this.setupExtras = { ...this.setupExtras, reviewing: null, reviewNote: note }
        session.skipReview()
        this.afterSetupStep(session.state)
      })
    }
    const fail = (message: string): string => reviewFailNote(conn?.label ?? null, message, st.unverifiedChecks)
    if (!settings || !conn || !aiAvailable(settings)) return skip(fail('no AI model is turned on'))
    if (useAppStore.getState().pause.paused) return skip(fail('monitoring is paused'))
    // never capture (or send) an image while nobody can see the setup screen
    if (!this.windowVisible) return skip(fail('the SitSense window is hidden'))

    let image: string
    try {
      if (settings.ai.share === 'snapshot') {
        if (!this.video) throw new Error('No camera frame yet.')
        image = makeSnapshot(this.video)
      } else {
        const good = this.lastSetupGood
        if (!good) throw new Error('No pose to draw.')
        image = makeSketch(good.frame, { up: baseline.up, anchor: st.features?.anchor ?? good.f.anchor })
      }
    } catch (err) {
      return skip(fail(err instanceof Error ? err.message : 'could not prepare the image'))
    }

    this.setupExtras = { ...this.setupExtras, reviewing: { label: conn.label }, reviewNote: null }
    const requestId = newRequestId('setup')
    this.setupReqId = requestId
    const req: AiReviewRequest = {
      requestId,
      purpose: 'setup',
      imageJpegB64: image,
      share: settings.ai.share,
      // what the on-device judge couldn't verify goes to the model as "judge this" (§11.3)
      measurements: setupReviewMeasurements(measurementsFromBaseline(baseline), st.unverifiedChecks)
    }
    window.sitsense
      .aiReviewPosture(req)
      .catch((err): AiPostureReview => ({ ok: false, message: aiErrorMessage(err) }))
      .then((res) => {
        if (this.setupReqId === requestId) this.setupReqId = null
        this.onSetupReview(token, session, res)
      })
  }

  private onSetupReview(token: number, session: SetupSession, res: AiPostureReview): void {
    if (token !== this.reviewToken || this.session !== session || this.lastSetupPhase !== 'reviewing') return
    if (res.ok) {
      this.setupExtras = {
        ...this.setupExtras,
        reviewing: null,
        reviewNote: null,
        // still the 'reviewing' state: what the reviewer was asked to judge (acceptReview clears it)
        reviewResult: reviewOutcome(res, this.lastSetupState)
      }
      if (res.verdict === 'good') session.acceptReview()
      else session.rejectReview(res.instructions[0] ?? res.summary)
    } else {
      const label = this.setupExtras.reviewing?.label ?? null
      const unverified = this.lastSetupState?.unverifiedChecks ?? []
      this.setupExtras = { ...this.setupExtras, reviewing: null, reviewNote: reviewFailNote(label, res.message, unverified) }
      session.skipReview()
    }
    this.afterSetupStep(session.state)
  }

  /** 'done': persist the baseline, stamped with the camera actually in use. */
  private saveBaseline(st: SetupState): void {
    const b = st.baseline
    if (!b) return
    const baseline: CalibrationBaseline = {
      ...b,
      cameraDeviceId: this.activeDeviceId ?? b.cameraDeviceId,
      // every key explicit: settings patches deep-merge, so a missing key would keep
      // the previous baseline's value
      neckLatRef: b.neckLatRef ?? baselineNeckLatRef(b)
    }
    this.setupExtras = { ...this.setupExtras, baselineSummary: summarizeBaseline(baseline, st.forced), saveError: null }
    const session = this.session
    useAppStore
      .getState()
      .patchSettings({ calibration: baseline })
      .catch((err) => {
        console.error('[detection] saving the baseline failed:', err)
        if (this.session !== session) return
        this.setupExtras = { ...this.setupExtras, saveError: "Couldn't save your posture — redo setup to try again." }
        this.republishSetup()
      })
  }

  // ───────────────────────────── baseline vs camera ─────────────────────────────

  /**
   * Apply the saved baseline unless it was captured with a different camera than the
   * one in use (both ids known): a different camera is a different view, so comparing
   * against it would raise false alerts. A baseline without an id (older setups) adopts
   * the camera in use.
   */
  private syncBaseline(): void {
    if (!this.engine) return
    const b = this.settings?.calibration ?? null
    const active = this.activeDeviceId
    const mismatch = !!(b && b.cameraDeviceId && active && b.cameraDeviceId !== active)
    const apply = mismatch ? null : b
    const key = apply ? JSON.stringify({ ...apply, cameraDeviceId: null }) : 'null'
    if (key !== this.appliedBaselineKey) {
      this.appliedBaselineKey = key
      this.engine.setBaseline(apply)
    }
    if (useAppStore.getState().baselineCameraMismatch !== mismatch) useAppStore.setState({ baselineCameraMismatch: mismatch })
    if (b && !b.cameraDeviceId && active && !this.usingFallback && this.status.running) {
      void window.sitsense.setSettings({ calibration: { cameraDeviceId: active } })
    }
  }

  /** "Use it with this camera anyway": adopt the camera in use for the saved baseline. */
  keepBaselineForThisCamera(): void {
    const b = this.settings?.calibration
    if (!b || !this.activeDeviceId) return
    void useAppStore.getState().patchSettings({ calibration: { cameraDeviceId: this.activeDeviceId } })
  }

  // ───────────────────────────── Ask AI ─────────────────────────────

  /** Dashboard "Ask AI": one on-demand review of the current posture → store.aiCheck. */
  async askAi(): Promise<void> {
    const settings = this.settings
    const conn = primaryAiConnection(settings)
    if (useAppStore.getState().aiCheck.status === 'pending') return
    if (!settings || !conn || !aiAvailable(settings)) return this.setAiCheck({ ...IDLE_AI_CHECK, status: 'error', message: NO_AI_MSG })
    if (useAppStore.getState().pause.paused) return this.setAiCheck({ ...IDLE_AI_CHECK, status: 'error', message: NOT_PAUSED_MSG })
    const now = performance.now()
    const recent = this.recent.filter((r) => now - r.t <= RECENT_MS)
    const latest = recent[recent.length - 1]
    if (!latest || !this.status.running) {
      return this.setAiCheck({ ...IDLE_AI_CHECK, status: 'error', message: NOT_IN_VIEW_MSG })
    }
    const features = medianFeatures(recent.map((r) => r.f))
    const assessment = assessPosture(features, features.upSource)
    let image: string
    try {
      if (settings.ai.share === 'snapshot') {
        if (!this.video) throw new Error('No camera frame yet.')
        image = makeSnapshot(this.video)
      } else {
        image = makeSketch(latest.frame, latest.f)
      }
    } catch (err) {
      return this.setAiCheck({
        ...IDLE_AI_CHECK,
        status: 'error',
        message: `Couldn't prepare the image: ${err instanceof Error ? err.message : 'unknown error'}`
      })
    }
    const token = ++this.aiToken
    const requestId = newRequestId('check')
    this.aiReqId = requestId
    this.setAiCheck({ status: 'pending', label: conn.label, review: null, message: null })
    const res = await window.sitsense
      .aiReviewPosture({
        requestId,
        purpose: 'check',
        imageJpegB64: image,
        share: settings.ai.share,
        measurements: measurementsFromFeatures(features, assessment)
      })
      .catch((err): AiPostureReview => ({ ok: false, message: aiErrorMessage(err) }))
    if (this.aiReqId === requestId) this.aiReqId = null
    if (token !== this.aiToken) return // dismissed, paused or superseded meanwhile
    if (res.ok) this.setAiCheck({ status: 'done', label: res.connectionLabel, review: res, message: null })
    else this.setAiCheck({ status: 'error', label: conn.label, review: null, message: res.message })
  }

  /** Close the Ask AI card (also ignores a result still on its way). */
  dismissAiCheck(): void {
    this.abandonAiReview()
    this.setAiCheck(IDLE_AI_CHECK)
  }

  private cancelAiCheck(): void {
    if (useAppStore.getState().aiCheck.status !== 'idle') this.dismissAiCheck()
    else this.abandonAiReview()
  }

  /** Ignore the Ask AI review in flight and free main's review slot (aiCancelReview). */
  private abandonAiReview(): void {
    this.aiToken++
    cancelReviewInMain(this.aiReqId)
    this.aiReqId = null
  }

  private setAiCheck(s: AiCheckState): void {
    useAppStore.setState({ aiCheck: s })
  }

  // ───────────────────────────── per-frame ─────────────────────────────

  private async processFrame(): Promise<void> {
    if (!this.landmarker || !this.video || !this.engine) return
    // the capture this frame belongs to (a release while syncMasks() awaits makes it stale)
    const gen = this.captureGen
    await this.syncMasks()
    const t = performance.now()
    try {
      await this.processDetections(t, gen)
    } finally {
      this.frameCostMs = performance.now() - t
    }
  }

  private async processDetections(t: number, gen: number = this.captureGen): Promise<void> {
    const landmarker = this.landmarker
    const video = this.video
    const engine = this.engine
    if (!landmarker || !video || !engine) return

    let frame: Frame = null
    let mesh: BodyMesh | null = null
    let result: PoseLandmarkerResult | null = null
    try {
      result = landmarker.detectForVideo(video, t)
      const vw = video.videoWidth
      const vh = video.videoHeight
      const aspect = vw > 0 && vh > 0 ? vw / vh : 4 / 3
      const pick = this.pickPose(result, aspect, engine, t)
      const image = result.landmarks?.[pick]
      if (image && image.length > 0) {
        frame = { image, world: result.worldLandmarks?.[pick] ?? null, aspect }
        const p = posePoint(frame)
        if (p) this.userAt = { p, t }
      }
      this.onInferenceOk(t)
      if (this.masksOn) mesh = this.buildMesh(result, frame, t, pick)
    } catch (err) {
      await this.onInferenceError(err, t)
      return
    } finally {
      // masks are copies owned by us (no callback was passed) — free them every frame
      result?.close()
    }
    if (landmarker !== this.landmarker) return // replaced while this frame ran

    this.trackFps(t)

    const setupLive = this.setupRunning()
    if (setupLive) this.pushSetup(frame, t)

    const { snapshot, alerts } = engine.processFrame(frame, t)
    // no nudges while someone can see the setup flow (camera check, coaching, Saved); once
    // the window is hidden (closed to the tray, minimized) SitSense monitors as usual
    const setupHoldsNudges = this.windowVisible && (setupLive || this.setupWanted)
    if (!setupHoldsNudges) for (const alert of alerts) window.sitsense.sendAlert(alert)
    // setup step 1: report what the camera can see (no session runs yet), measured as the
    // session will measure it — never with the saved baseline's gravity or hip setting
    if (this.setupWanted && this.setupStage === 'camera' && gen === this.captureGen) {
      publishProbe(this.probe.push(frame, t))
    }
    this.maybeSendSnapshot(snapshot, t)
    this.publishSnapshot(snapshot, t)

    const features = engine.lastFeatures
    if (frame && features) {
      this.recent.push({ t, frame, f: features })
    }
    while (this.recent.length > 0 && t - this.recent[0].t > RECENT_MS) this.recent.shift()

    const overlayFeatures = setupLive ? (this.lastSetupState?.features ?? null) : features
    // a pose that is not the seated user (a print on the desk, a poster, someone far
    // behind) is neither drawn nor reported as "seeing you"
    const reject = setupLive ? this.lastSetupState?.frameReject : engine.frameReject
    const notUser = reject === 'too-far' || reject === 'not-upright'
    this.publishPose(notUser ? null : frame, overlayFeatures, snapshot, notUser ? null : mesh, t)
    this.updateIdle(engine, frame !== null && !notUser, t)
  }

  /**
   * Index of the user among the poses the model found: with room for two poses, a figure on
   * the desk mat or a poster can be in the result beside the user (posture/select.ts).
   */
  private pickPose(result: PoseLandmarkerResult, aspect: number, engine: PostureEngine, t: number): number {
    const poses = result.landmarks ?? []
    if (poses.length <= 1) return 0
    const frames: PoseFrame[] = poses.map((image, i) => ({ image, world: result.worldLandmarks?.[i] ?? null, aspect }))
    const prev = this.userAt && t - this.userAt.t <= PICK_FOLLOW_MS ? this.userAt.p : null
    return pickUser(frames, engine.extractOptions, prev)
  }

  /**
   * Nobody at the desk for IDLE_AFTER_MS: the model runs at IDLE_FPS until a pose that could be
   * the user appears, then at once at the full rate again (before presence even confirms it).
   */
  private updateIdle(engine: PostureEngine, someone: boolean, t: number): void {
    if (engine.presenceState === 'away' && !someone) this.awaySince ??= t
    else this.awaySince = null
    const idle = this.awaySince !== null && t - this.awaySince >= IDLE_AFTER_MS
    if (idle !== this.idle) {
      this.idle = idle
      this.applyLoopFps()
    }
  }

  private onInferenceOk(t: number): void {
    this.firstInferenceOk = true
    this.inferFailures = 0
    this.lastInferOkAt = t
    if (this.rebuilds > 0 && t - this.lastRebuildAt > REBUILD_FORGET_MS) this.rebuilds = 0
    if (useAppStore.getState().detectorError === 'inference') this.setDetectorError(null)
  }

  private async onInferenceError(err: unknown, t: number): Promise<void> {
    if (this.masksOn && !this.masksFailed) {
      // the segmentation graph is the newest moving part: blame it first — even on the
      // very first frame, so it can't get the GPU blamed (syncMasks turns it off next frame)
      console.warn('[detection] inference failed with segmentation on — disabling the mesh preview:', err)
      this.masksFailed = true
      useAppStore.setState({ meshUnavailable: true })
      return
    }
    if (!this.firstInferenceOk && this.delegate === 'GPU') {
      // the pose graph itself failed its first inference on the GPU
      console.warn('[detection] first GPU inference failed, recreating as CPU:', err)
      const mGen = ++this.modelGen
      let cpu: PoseLandmarker
      try {
        cpu = await recreateAsCpu(this.landmarker)
      } catch (e) {
        if (mGen === this.modelGen) {
          this.landmarker = null
          this.discardModels(`CPU fallback failed: ${String(e)}`, true)
        }
        return
      }
      if (mGen !== this.modelGen) {
        cpu.close()
        return
      }
      this.landmarker = cpu
      this.masksOn = false
      this.delegate = 'CPU'
      this.inferFailures = 0
      // a different delegate deserves a fresh chance at the preview extras
      this.masksFailed = false
      this.faceFailed = false
      this.faceGpuBroken = false
      useAppStore.setState({ meshUnavailable: false })
      if (this.settings?.delegate === 'auto') void window.sitsense.setSettings({ resolvedDelegate: 'CPU' })
      this.updateStatus({ delegate: 'CPU' })
      return
    }
    this.inferFailures++
    console.error('[detection] inference failed:', err)
    if (this.inferFailures >= INFER_FAIL_MAX || t - this.lastInferOkAt > INFER_FAIL_MS) {
      this.discardModels('inference keeps failing', true)
    }
  }

  /**
   * Throw the landmarker away and start over (a broken GPU context, a WASM abort, or
   * after sleep). Repeated failures release the camera and back off.
   */
  private discardModels(reason: string, failure: boolean): void {
    console.warn('[detection] rebuilding the posture model:', reason)
    this.modelGen++
    try {
      this.landmarker?.close()
    } catch {
      // already broken
    }
    this.landmarker = null
    this.delegate = null
    this.masksOn = false
    this.firstInferenceOk = false
    this.inferFailures = 0
    this.releaseFace()
    if (failure) {
      this.rebuilds++
      this.lastRebuildAt = performance.now()
      this.setDetectorError('inference')
    }
    if (!this.wantRunning) return
    if (failure && this.rebuilds > 1) {
      this.releaseCamera()
      this.updateStatus({ running: false, delegate: null, measuredFps: 0 })
      this.scheduleRetry('model')
    } else {
      void this.restart()
    }
  }

  /** Switches segmentation output on/off to match whether anyone can see the mesh. */
  private async syncMasks(): Promise<void> {
    const want = this.wantsMasks()
    if (want && this.masksOn) this.ensureFace()
    if (!this.landmarker || want === this.masksOn) return
    try {
      await this.landmarker.setOptions({ outputSegmentationMasks: want })
      this.masksOn = want
    } catch (err) {
      console.warn('[detection] segmentation unavailable — mesh preview falls back to the skeleton:', err)
      this.masksFailed = true
      this.masksOn = false
      useAppStore.setState({ meshUnavailable: true })
      await this.recoverPoseGraph()
    }
    if (!this.masksOn) {
      this.meshBuilder.reset()
      this.releaseFace()
      if (useAppStore.getState().mesh) useAppStore.setState({ mesh: null })
    }
  }

  /**
   * setOptions() swaps the pose graph before it reports errors, so after a
   * failed switch the old graph is gone. Posture detection must not die with
   * the cosmetic mesh: rebuild a mask-free graph, or recreate the landmarker.
   */
  private async recoverPoseGraph(): Promise<void> {
    if (!this.landmarker) return
    try {
      await this.landmarker.setOptions({ outputSegmentationMasks: false })
    } catch (err) {
      console.error('[detection] landmarker unusable after the segmentation failure — recreating it:', err)
      this.discardModels('segmentation switch broke the pose graph', false)
    }
  }

  /** Loads the face landmarker in the background; the mesh uses a plain head until it's ready. */
  private ensureFace(): void {
    if (this.face || this.faceLoading || this.faceFailed || !this.delegate) return
    this.faceLoading = true
    const gen = this.faceGen
    const delegate = this.delegate === 'GPU' && !this.faceGpuBroken ? 'GPU' : 'CPU'
    createFaceLandmarker(delegate)
      .then((face) => {
        if (gen === this.faceGen && this.masksOn) this.face = face
        else face.close() // released (pause, restart, delegate change, preview gone) while it loaded
      })
      .catch((err) => {
        if (gen !== this.faceGen) return // a stale load for an old delegate or capture
        console.warn(`[detection] face mesh unavailable on ${delegate}:`, err)
        // a GPU failure gets one retry on the CPU; after that the head stays plain
        if (delegate === 'GPU') this.faceGpuBroken = true
        else this.faceFailed = true
      })
      .finally(() => {
        this.faceLoading = false
      })
  }

  private releaseFace(): void {
    this.faceGen++
    try {
      this.face?.close()
    } catch {
      // closing a broken task is best-effort
    }
    this.face = null
  }

  private detectFace(t: number): FaceInput | null {
    if (!this.face || !this.video) return null
    if (this.setupRunning() && !this.faceDuringSetup) return null
    try {
      const points = this.face.detectForVideo(this.video, t).faceLandmarks?.[0]
      return points ? { points, topology: faceMeshTopology() } : null
    } catch (err) {
      // GPU trouble gets one retry on the CPU; after that the head stays plain
      console.warn('[detection] face mesh inference failed:', err)
      if (this.delegate === 'GPU' && !this.faceGpuBroken) this.faceGpuBroken = true
      else this.faceFailed = true
      this.releaseFace()
      return null
    }
  }

  private buildMesh(result: PoseLandmarkerResult, frame: Frame, t: number, pick: number): BodyMesh | null {
    const mask = result.segmentationMasks?.[pick]
    if (!mask || !frame) {
      this.meshBuilder.reset()
      return null
    }
    try {
      return this.meshBuilder.update(mask.getAsFloat32Array(), mask.width, mask.height, frame.image, t, this.detectFace(t))
    } catch (err) {
      // purely cosmetic — never let it take posture detection down with it
      console.warn('[detection] body mesh failed — falling back to the skeleton:', err)
      this.masksFailed = true
      useAppStore.setState({ meshUnavailable: true })
      return null
    }
  }

  // ───────────────────────────── publishing ─────────────────────────────

  /**
   * The Lines overlay data: ≤ 15 Hz, only while the window is visible. The mesh (if
   * on) goes out with every frame — MeshOverlay reads it outside React.
   */
  private publishPose(
    frame: Frame,
    features: PostureFeatures | null,
    snapshot: PostureSnapshot,
    mesh: BodyMesh | null,
    t: number
  ): void {
    const s = useAppStore.getState()
    if (!this.windowVisible) {
      if (s.pose || s.mesh) useAppStore.setState({ pose: null, mesh: null })
      return
    }
    const patch: { pose?: AppStatePose; mesh?: BodyMesh | null } = {}
    if (mesh !== s.mesh) patch.mesh = mesh
    if (!frame) {
      if (s.pose) patch.pose = null
    } else if (t - this.lastPoseAt >= POSE_MIN_INTERVAL_MS) {
      this.lastPoseAt = t
      patch.pose = {
        image: frame.image,
        aspect: frame.aspect,
        guide: overlayGuide(frame, features),
        segments: segmentStages(snapshot)
      }
    }
    if (patch.pose !== undefined || patch.mesh !== undefined) useAppStore.setState(patch)
  }

  /** The store's snapshot changes only when something on screen would (or ~1×/s while visible). */
  private publishSnapshot(s: PostureSnapshot, t: number): void {
    this.latestSnapshot = s
    const key = `${s.presence}|${s.worstStage}|${s.calibrated}|${s.recalibrationSuggested}|${s.suspended === true}|${ISSUES.map(
      (i) => s.issues[i].stage
    ).join(',')}|${s.issues.lean.direction ?? ''}|${s.readout?.view ?? ''}`
    const due = this.windowVisible && t - this.lastUiSnapshotAt >= UI_SNAPSHOT_INTERVAL_MS
    if (key !== this.lastUiSnapshotKey || due) {
      this.lastUiSnapshotKey = key
      this.lastUiSnapshotAt = t
      useAppStore.setState({ snapshot: s })
    }
  }

  private onVisibility(visible: boolean): void {
    this.visibilityKnown = true
    this.windowVisible = visible
    const patch: Partial<{ windowVisible: boolean; snapshot: PostureSnapshot | null; pose: null; mesh: null }> = {
      windowVisible: visible
    }
    // shown: be current immediately; hidden: drop the per-frame data nobody can see
    if (visible && this.latestSnapshot) patch.snapshot = this.latestSnapshot
    if (!visible) {
      patch.pose = null
      patch.mesh = null
    }
    useAppStore.setState(patch)
    this.syncSetupVisibility(visible)
  }

  /**
   * Coaching only runs while someone can see it. Hidden (closed to the tray, minimized), the
   * session is dropped: no raised frame rate, no capture, no review image; nudges resume
   * (processDetections). Shown again, coaching starts over. A finished setup (Done) stays.
   */
  private syncSetupVisibility(visible: boolean): void {
    if (!this.setupWanted || this.setupStage !== 'coach') return
    if (!visible) {
      if (this.session && this.lastSetupPhase !== 'done') {
        this.dropSession()
        this.setSetupUi(IDLE_SETUP)
      }
    } else if (!this.session) {
      this.newSession()
    }
  }

  private maybeSendSnapshot(snapshot: PostureSnapshot, t: number): void {
    const key = `${snapshot.presence}|${snapshot.worstStage}|${snapshot.calibrated}|${snapshot.suspended === true}`
    if (key !== this.lastSnapshotKey || t - this.lastSnapshotSentAt >= SNAPSHOT_MIN_INTERVAL_MS) {
      this.lastSnapshotKey = key
      this.lastSnapshotSentAt = t
      window.sitsense.sendPostureUpdate({ ...snapshot, ts: Date.now() })
    }
  }

  private trackFps(t: number): void {
    this.frameCount++
    if (t - this.fpsWindowStart >= FPS_WINDOW_MS) {
      const measured = Math.round((this.frameCount * 1000) / (t - this.fpsWindowStart))
      this.frameCount = 0
      this.fpsWindowStart = t
      if (measured !== this.status.measuredFps) this.updateStatus({ measuredFps: measured })
    }
  }

  // ───────────────────────────── settings / status ─────────────────────────────

  private presetFps(): number {
    return PRESET_FPS[this.settings?.performancePreset ?? 'balanced'] ?? PRESET_FPS.balanced
  }

  /**
   * The preset rate, raised to at least 'balanced' while setup runs (enough frames for the
   * capture), lowered to IDLE_FPS while nobody is at the desk (never with the setup on screen).
   */
  private targetFps(): number {
    const preset = this.presetFps()
    if (this.setupRunning()) return Math.max(PRESET_FPS.balanced, preset)
    return this.idle && !this.setupWanted ? Math.min(preset, IDLE_FPS) : preset
  }

  private applyLoopFps(): void {
    const fps = this.targetFps()
    if (this.loop && Math.abs(this.loop.fps - fps) > 0.01) this.loop.setFps(fps)
    if (this.status.targetFps !== fps) this.updateStatus({ targetFps: fps })
  }

  private applySettings(next: Settings): void {
    const prev = this.settings
    this.settings = next
    useAppStore.setState({ settings: next })
    if (!this.engine) return

    this.engine.updateSettings(toEngineSettings(next))
    this.syncBaseline()
    if (!aiAvailable(next)) this.cancelAiCheck()
    // the AI second opinion for setup was turned on or off (e.g. from the setup flow's AI
    // sheet): a session decides about its reviewer once, so coach again with a fresh one
    if (
      prev &&
      this.setupWanted &&
      this.setupStage === 'coach' &&
      this.session &&
      aiReviewsSetup(prev) !== aiReviewsSetup(next) &&
      this.lastSetupPhase !== 'done' &&
      this.lastSetupPhase !== 'reviewing'
    ) {
      this.newSession()
    }
    if (prev && prev.cameraDeviceId !== next.cameraDeviceId && this.wantRunning) {
      this.retryDelay = RETRY_BASE_MS
      void this.restart()
      return
    }
    if (prev && prev.performancePreset !== next.performancePreset) this.applyLoopFps()
    if (prev && prev.delegate !== next.delegate) {
      // delegate preference changed: rebuild the landmarkers on next start
      this.modelGen++
      try {
        this.landmarker?.close()
      } catch {
        // best-effort
      }
      this.landmarker = null
      this.delegate = null
      this.releaseFace()
      // a different delegate deserves a fresh chance at the preview extras
      this.masksFailed = false
      this.faceFailed = false
      this.faceGpuBroken = false
      this.rebuilds = 0
      this.modelRetryDelay = MODEL_RETRY_BASE_MS
      useAppStore.setState({ meshUnavailable: false })
      if (this.wantRunning) void this.restart()
    }
  }

  private updateStatus(patch: Partial<DetectionStatus>): void {
    const next = { ...this.status, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.status)) return
    this.status = next
    useAppStore.setState({ detection: this.status })
    window.sitsense.sendDetectionStatus(this.status)
  }

  private setDetectorError(e: DetectorError, reason: DetectorErrorReason = null): void {
    const s = useAppStore.getState()
    const r = e === 'model' ? reason : null
    if (s.detectorError !== e || s.detectorErrorReason !== r) useAppStore.setState({ detectorError: e, detectorErrorReason: r })
  }

  private setCameraUi(c: CameraUiState): void {
    const cur = useAppStore.getState().camera
    if (
      cur.activeDeviceId !== c.activeDeviceId ||
      cur.activeLabel !== c.activeLabel ||
      cur.usingFallback !== c.usingFallback
    ) {
      useAppStore.setState({ camera: c })
    }
  }

  private async refreshCameraList(): Promise<{ deviceId: string; label: string }[] | null> {
    try {
      const cams = await listCameras()
      useAppStore.setState({ cameras: cams })
      return cams
    } catch {
      // enumeration can fail before any grant — ignore
      return null
    }
  }

  private scheduleRetry(kind: 'camera' | 'model'): void {
    if (!this.wantRunning || this.retryTimer) return
    const delay = kind === 'camera' ? this.retryDelay : this.modelRetryDelay
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (kind === 'camera') this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS)
      else this.modelRetryDelay = Math.min(this.modelRetryDelay * 2, MODEL_RETRY_MAX_MS)
      if (this.wantRunning) void this.start()
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}

type AppStatePose = ReturnType<typeof useAppStore.getState>['pose']

function toEngineSettings(s: Settings): EngineSettings {
  return {
    issues: s.issues,
    dwellSeconds: s.notifications.dwellSeconds,
    cooldownMinutes: s.notifications.cooldownMinutes,
    escalation: s.notifications.escalation
  }
}

export const detectionController = new DetectionController()
