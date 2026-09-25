import type { FaceLandmarker, PoseLandmarker, PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import type { DetectionStatus, PostureSnapshot } from '@shared/posture'
import { PRESET_FPS, type Settings } from '@shared/settings'
import { BodyMeshBuilder, type BodyMesh, type FaceInput } from '@renderer/overlay/bodyMesh'
import { CalibrationSession, assessPlacement } from '@renderer/posture/calibration'
import { CAL_COUNTDOWN_S, CAL_DURATION_S } from '@renderer/posture/constants'
import { PostureEngine, type EngineSettings } from '@renderer/posture/engine'
import type { Frame } from '@renderer/posture/types'
import { useAppStore } from '@renderer/state/store'
import { CameraOpenError, listCameras, openCamera, stopStream } from './camera'
import { FrameLoop } from './frame-loop'
import { createFaceLandmarker, createLandmarker, faceMeshTopology, recreateAsCpu, type VisionTask } from './landmarker'

const SNAPSHOT_MIN_INTERVAL_MS = 1000
const FPS_WINDOW_MS = 2000
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30000
/** a camera that opens but delivers no frame within this is treated as unusable */
const FIRST_FRAME_TIMEOUT_MS = 5000
/** a stalled (muted) camera track is reopened after this long */
const STALL_RESTART_MS = 5000
/** consecutive inference failures (GPU loss, driver reset) before the model is rebuilt */
const MAX_INFERENCE_FAILURES = 10
/** the face model outlives short hides; it's released once unused this long */
const FACE_IDLE_RELEASE_MS = 10 * 60_000
/** away this long → look for the user at a low frame rate */
const AWAY_PROBE_AFTER_MS = 60_000
const AWAY_PROBE_FPS = 2
/** a GPU failure under 'auto' pins the CPU for this long, then the GPU gets another try */
const GPU_RETRY_AFTER_MS = 7 * 24 * 3600_000
/** a capture that stops receiving frames ends (as failed) instead of hanging */
const CAPTURE_GRACE_MS = 1500

type CalibrationPhase = ReturnType<typeof useAppStore.getState>['calibration']['phase']
const calibrating = (phase: CalibrationPhase): boolean =>
  phase === 'positioning' || phase === 'countdown' || phase === 'capturing'

/**
 * Owns the camera stream, the MediaPipe landmarker, the frame loop, and the
 * posture engine; bridges their results into the zustand store and main-process
 * IPC. Pausing releases the camera completely (webcam LED off — trust signal).
 */
class DetectionController {
  private video: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private activeCameraId: string | null = null
  private pose: VisionTask<PoseLandmarker> | null = null
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
  /** face mesh for the wireframe's face — kept across short hides, released when idle or paused */
  private face: VisionTask<FaceLandmarker> | null = null
  private faceLoading = false
  private faceGpuBroken = false
  private faceFailed = false
  /** bumped on every release, so a load still in flight can't be adopted afterwards */
  private faceGen = 0
  private faceIdleTimer: ReturnType<typeof setTimeout> | null = null
  /** how long the last frame took, all models included */
  private frameCostMs = 0
  /** whether this calibration capture can afford the face model (decided once per capture) */
  private faceDuringCapture = true

  private session: CalibrationSession | null = null
  private countdownTimer: ReturnType<typeof setInterval> | null = null
  private captureTimer: ReturnType<typeof setTimeout> | null = null

  private starting = false
  private pendingRestart = false
  private wantRunning = false
  private firstInferenceOk = false
  private inferenceFailures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_BASE_MS
  private stallTimer: ReturnType<typeof setTimeout> | null = null

  /** latest snapshot, kept while the store isn't fed (window hidden) */
  private latestSnapshot: PostureSnapshot | null = null
  private awaySince: number | null = null
  private probing = false

  private lastSnapshotSentAt = 0
  private lastSnapshotKey = ''
  private frameCount = 0
  private fpsWindowStart = 0
  private status: DetectionStatus = {
    running: false,
    delegate: null,
    targetFps: PRESET_FPS.balanced,
    measuredFps: 0,
    cameraError: null,
    modelError: false
  }

  /** Resolves once settings are known; detection starts in the background. */
  async init(): Promise<void> {
    // listen before asking: the window may be shown while the status request is in flight
    window.sitsense.onWindowVisibility((visible) => this.setWindowVisible(visible))
    const [settings, appStatus] = await Promise.all([
      window.sitsense.getSettings(),
      window.sitsense.getAppStatus()
    ])
    this.settings = settings
    this.engine = new PostureEngine(settings.calibration, toEngineSettings(settings))
    if (!this.visibilityKnown) this.applyVisibility(appStatus.windowVisible)
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
        this.stopCapture()
        this.releaseFace()
      } else {
        void this.start()
      }
    })
    window.sitsense.onNavigate((route) => useAppStore.getState().setRoute(route))
    window.sitsense.onRequestCalibration(() => useAppStore.getState().setRoute('calibrate'))
    window.sitsense.onSystemSuspend(() => {
      // release the camera before sleep; resume brings it back
      if (!this.wantRunning) return
      this.stopCapture()
      this.wantRunning = true
    })
    window.sitsense.onSystemResumed(() => {
      // camera streams often die silently across sleep/resume
      if (this.wantRunning) void this.restart()
    })
    navigator.mediaDevices.addEventListener('devicechange', () => void this.onDeviceChange())

    if (!appStatus.pause.paused) void this.start()
  }

  private setWindowVisible(visible: boolean): void {
    this.visibilityKnown = true
    this.applyVisibility(visible)
    // the store isn't fed while hidden — catch the dashboard up on show
    useAppStore.setState({ windowVisible: visible, ...(visible ? { snapshot: this.latestSnapshot } : {}) })
    if (visible && this.wantRunning && this.status.cameraError) {
      // the user may have just fixed it (privacy toggle, closed the other app)
      this.retryDelay = RETRY_BASE_MS
      void this.restart()
    }
  }

  private applyVisibility(visible: boolean): void {
    this.windowVisible = visible
    // CSS pauses every animation while nobody can see the window
    document.documentElement.toggleAttribute('data-hidden', !visible)
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
    // never before the first clean inference: a mask failure there would be
    // misread as a GPU failure and pin the pose model to the CPU for good
    return this.meshConsumers > 0 && this.windowVisible && !this.masksFailed && this.firstInferenceOk
  }

  /** The stream for preview <video> elements (shared MediaStream is fine). */
  getStream(): MediaStream | null {
    return this.stream
  }

  async start(): Promise<void> {
    this.wantRunning = true
    if (!this.settings || !this.video) return
    if (this.starting) {
      // e.g. pause → resume while the model loads: redo the start once it's done
      this.pendingRestart = true
      return
    }
    this.starting = true
    this.clearRetry()
    try {
      // re-entry (retry / redundant resume): drop any existing loop and stream first
      this.teardownStream()

      // the model first: a broken install must not flash the webcam LED on every retry
      if (!this.pose) {
        const preference = this.delegatePreference()
        this.pose = await createLandmarker(preference)
        this.masksOn = false
        this.firstInferenceOk = false
        this.inferenceFailures = 0
        this.rememberDelegate(this.pose.delegate, this.pose.gpuFailed === true)
      }
      if (!this.wantRunning) return

      const opened = await openCamera(this.settings.cameraDeviceId, this.settings.cameraLabel)
      if (!this.wantRunning) {
        stopStream(opened.stream) // paused while the camera was opening
        return
      }
      this.adoptStream(opened.stream)
      this.noteActiveCamera(opened.deviceId, opened.label)
      await this.waitForFirstFrame(opened.stream)
      if (!this.wantRunning || this.stream !== opened.stream) return // stopped meanwhile
      await this.refreshCameraList()

      const fps = this.session ? this.captureFps() : this.currentFps()
      this.loop = new FrameLoop(this.video, fps, () => this.processFrame())
      this.loop.start()
      this.fpsWindowStart = performance.now()
      this.frameCount = 0
      this.updateStatus({
        running: true,
        delegate: this.pose.delegate,
        targetFps: fps,
        cameraError: null,
        modelError: false
      })
    } catch (err) {
      this.teardownStream()
      if (err instanceof CameraOpenError) {
        this.updateStatus({ running: false, cameraError: err.kind, modelError: false })
      } else {
        // landmarker/asset failure — not the camera's fault, don't mislabel it
        console.error('[detection] start failed:', err)
        this.updateStatus({ running: false, cameraError: null, modelError: true })
      }
      this.scheduleRetry()
    } finally {
      this.starting = false
      if (this.pendingRestart) {
        this.pendingRestart = false
        void this.restart()
      }
    }
  }

  private adoptStream(stream: MediaStream): void {
    this.stream = stream
    this.video!.srcObject = stream
    const track = stream.getVideoTracks()[0]
    if (!track) return
    track.onended = () => this.scheduleRetry()
    // a camera that stops delivering frames without ending mutes its track
    track.onmute = () => {
      this.clearStallTimer()
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null
        if (this.wantRunning && this.stream === stream) void this.restart()
      }, STALL_RESTART_MS)
    }
    track.onunmute = () => this.clearStallTimer()
  }

  /** Waits for real frames: some cameras open fine and then never deliver one. */
  private async waitForFirstFrame(stream: MediaStream): Promise<void> {
    const video = this.video!
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      video.play().catch(() => undefined),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, FIRST_FRAME_TIMEOUT_MS)))
    ])
    clearTimeout(timer)
    if (this.stream !== stream || !this.wantRunning) return
    if (video.readyState < 2) throw new CameraOpenError('in-use')
  }

  /** Stops the loop and the camera; leaves intent (wantRunning) and models alone. */
  private teardownStream(): void {
    this.loop?.stop()
    this.loop = null
    this.clearStallTimer()
    const track = this.stream?.getVideoTracks()[0]
    if (track) track.onended = track.onmute = track.onunmute = null
    stopStream(this.stream)
    this.stream = null
    if (this.video) this.video.srcObject = null
  }

  /** Releases everything camera-related; the landmarkers survive for restarts. */
  stopCapture(): void {
    this.wantRunning = false
    this.clearRetry()
    this.teardownStream()
    this.abortCalibration()
    this.meshBuilder.reset()
    this.awaySince = null
    this.probing = false
    useAppStore.setState({ overlay: null, mesh: null })
    this.updateStatus({ running: false, measuredFps: 0, cameraError: null, modelError: false })
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

  private async onDeviceChange(): Promise<void> {
    await this.refreshCameraList()
    if (!this.wantRunning) return
    if (this.status.cameraError) {
      void this.restart()
      return
    }
    // the chosen camera came back (replugged) while a fallback camera is in use
    const s = this.settings
    const cams = useAppStore.getState().cameras
    const back =
      !!s?.cameraDeviceId &&
      s.cameraDeviceId !== this.activeCameraId &&
      cams.some((c) => c.deviceId === s.cameraDeviceId || (!!s.cameraLabel && c.label === s.cameraLabel))
    if (back) void this.restart()
  }

  /** Tracks the camera actually in use; re-points a stale saved id found again by its label. */
  private noteActiveCamera(deviceId: string | null, label: string | null): void {
    this.activeCameraId = deviceId
    useAppStore.setState({ activeCameraId: deviceId })
    const s = this.settings
    if (s?.cameraDeviceId && deviceId && deviceId !== s.cameraDeviceId && label && label === s.cameraLabel) {
      void window.sitsense.setSettings({ cameraDeviceId: deviceId })
    }
  }

  // ---------- delegate choice ----------

  private delegatePreference(): 'auto' | 'GPU' | 'CPU' {
    const s = this.settings!
    if (s.delegate !== 'auto') return s.delegate
    // a GPU failure is a hint, not a life sentence: retry it after a while
    // (and at once for settings from before the failure was timestamped)
    if (s.resolvedDelegate === 'CPU' && s.gpuFailedAt !== null && Date.now() - s.gpuFailedAt < GPU_RETRY_AFTER_MS) {
      return 'CPU'
    }
    return 'auto'
  }

  private rememberDelegate(delegate: 'GPU' | 'CPU', gpuFailed: boolean): void {
    if (this.settings?.delegate !== 'auto') return
    if (gpuFailed) void window.sitsense.setSettings({ resolvedDelegate: 'CPU', gpuFailedAt: Date.now() })
    else if (this.settings.resolvedDelegate !== delegate) void window.sitsense.setSettings({ resolvedDelegate: delegate })
  }

  // ---------- calibration wizard driving ----------

  startPlacementCheck(): void {
    // a stale verdict from an earlier visit must not enable "Continue"
    this.engine?.resetEpisodes()
    useAppStore.setState((s) => ({
      calibration: { ...s.calibration, phase: 'positioning', placement: null, failReason: null, progress: 0 }
    }))
  }

  beginCountdown(): void {
    if (!this.loop) return // nothing is being captured (paused, camera error)
    this.cancelCountdown()
    let value = CAL_COUNTDOWN_S
    useAppStore.setState((s) => ({ calibration: { ...s.calibration, phase: 'countdown', countdownValue: value } }))
    this.countdownTimer = setInterval(() => {
      value -= 1
      if (value <= 0) {
        this.cancelCountdown()
        this.beginCapture()
      } else {
        useAppStore.setState((s) => ({ calibration: { ...s.calibration, countdownValue: value } }))
      }
    }, 1000)
  }

  beginCapture(): void {
    if (!this.loop) {
      this.failCalibration('interrupted')
      return
    }
    this.session = new CalibrationSession(performance.now())
    // the 5s capture needs ≥ ~45 samples for a solid median — temporarily lift
    // the frame rate above the power-saving preset (restored on finish/cancel)
    const fps = this.captureFps()
    this.probing = false
    this.loop.setFps(fps)
    // a machine that can't fit the cosmetic face mesh into the capture frame
    // rate drops it for these few seconds rather than starve the baseline
    this.faceDuringCapture = this.frameCostMs < 0.6 * (1000 / fps)
    // frames drive completion — if they stop, end the capture instead of hanging
    this.captureTimer = setTimeout(() => this.finishCalibration(), CAL_DURATION_S * 1000 + CAPTURE_GRACE_MS)
    useAppStore.setState((s) => ({ calibration: { ...s.calibration, phase: 'capturing', progress: 0 } }))
  }

  /** The user left the wizard mid-way. */
  cancelCalibration(): void {
    this.endCalibration()
    this.engine?.resetEpisodes()
    useAppStore.setState((s) => ({
      calibration: { ...s.calibration, phase: 'idle', progress: 0, banner: null }
    }))
  }

  /** The camera went away under a running countdown or capture. */
  private abortCalibration(): void {
    if (this.session || this.countdownTimer) this.failCalibration('interrupted')
  }

  private failCalibration(reason: 'interrupted'): void {
    this.endCalibration()
    useAppStore.setState((s) => ({
      calibration: { ...s.calibration, phase: 'failed', failReason: reason, progress: 0, banner: null }
    }))
  }

  private endCalibration(): void {
    this.cancelCountdown()
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.captureTimer = null
    this.session = null
    this.loop?.setFps(this.currentFps())
  }

  private currentFps(): number {
    return PRESET_FPS[this.settings?.performancePreset ?? 'balanced']
  }

  private captureFps(): number {
    return Math.max(PRESET_FPS.balanced, this.currentFps())
  }

  private cancelCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = null
  }

  private finishCalibration(): void {
    const session = this.session
    if (!session) return
    this.endCalibration()
    const result = session.finish(Date.now(), this.activeCameraId ?? this.settings?.cameraDeviceId ?? null)
    if (result.ok) {
      void useAppStore.getState().patchSettings({ calibration: result.baseline })
      useAppStore.setState((s) => ({ calibration: { ...s.calibration, phase: 'done', banner: null } }))
    } else {
      useAppStore.setState((s) => ({
        calibration: { ...s.calibration, phase: 'failed', failReason: result.reason, banner: null }
      }))
    }
  }

  // ---------- per-frame ----------

  private async processFrame(): Promise<void> {
    if (!this.pose || !this.video || !this.engine) return
    await this.syncMasks()
    const t = performance.now()
    try {
      await this.processDetections(t)
    } finally {
      this.frameCostMs = performance.now() - t
    }
  }

  private async processDetections(t: number): Promise<void> {
    if (!this.pose || !this.video || !this.engine) return

    let frame: Frame = null
    let mesh: BodyMesh | null = null
    let result: PoseLandmarkerResult | null = null
    try {
      result = this.pose.task.detectForVideo(this.video, t)
      frame = (result.landmarks?.[0] as Frame) ?? null
      this.firstInferenceOk = true
      this.inferenceFailures = 0
      // only a working inference proves the start worked: a model that opens
      // fine but throws on every frame must keep backing off, not reopen the
      // camera every few seconds
      this.retryDelay = RETRY_BASE_MS
      if (this.masksOn) mesh = this.buildMesh(result, frame, t)
    } catch (err) {
      if (!this.firstInferenceOk && this.pose.delegate === 'GPU') {
        // some GPU failures only surface at the first inference
        console.warn('[detection] first GPU inference failed, recreating as CPU:', err)
        try {
          this.pose = await recreateAsCpu(this.pose)
        } catch (cpuErr) {
          this.pose = null
          this.rebuildModel(cpuErr)
          return
        }
        this.masksOn = false
        this.rememberDelegate('CPU', true)
        this.updateStatus({ delegate: 'CPU' })
        return
      }
      if (this.masksOn && !this.masksFailed) {
        // the segmentation graph is the newest moving part — drop it before
        // it can take posture detection down (syncMasks switches it off next frame)
        console.warn('[detection] inference failed with segmentation on — disabling the mesh preview:', err)
        this.masksFailed = true
        useAppStore.setState({ meshUnavailable: true })
        return
      }
      this.inferenceFailures++
      if (this.inferenceFailures === 1) console.error('[detection] inference failed:', err)
      if (this.inferenceFailures >= MAX_INFERENCE_FAILURES) this.rebuildModel(err)
      return
    } finally {
      // masks are copies owned by us (no callback was passed) — free them every frame
      result?.close()
    }

    // nobody sees the dashboard while hidden: don't re-render it per frame
    if (this.windowVisible) useAppStore.setState({ overlay: frame ? [...frame] : null, mesh })
    this.trackFps(t)

    const phase = useAppStore.getState().calibration.phase
    if (calibrating(phase)) {
      const placement = assessPlacement(frame)
      useAppStore.setState((s) => ({ calibration: { ...s.calibration, placement } }))
      if (this.session && phase === 'capturing') {
        this.session.addFrame(frame, t)
        const progress = this.session.progress(t)
        useAppStore.setState((s) => ({
          calibration: {
            ...s.calibration,
            progress,
            banner: placement.verdict === 'unusable' ? 'hold' : null
          }
        }))
        if (this.session.isComplete(t)) this.finishCalibration()
      }
    }

    const { snapshot, alerts } = this.engine.processFrame(frame, t)
    this.latestSnapshot = snapshot
    if (this.windowVisible) useAppStore.setState({ snapshot })
    // judging against the baseline that's being replaced would only nag
    if (!calibrating(phase)) for (const alert of alerts) window.sitsense.sendAlert(alert)
    this.maybeSendSnapshot(snapshot, t)
    this.paceForPresence(snapshot, t, phase)
  }

  /**
   * GPU process crash, driver reset, lost WebGL context: every detect now
   * throws. Rebuild the model (with retry backoff) instead of logging forever
   * while the UI claims to be monitoring.
   */
  private rebuildModel(err: unknown): void {
    console.error('[detection] inference keeps failing — rebuilding the model:', err)
    const want = this.wantRunning
    this.pose?.dispose()
    this.pose = null
    this.releaseFace()
    this.inferenceFailures = 0
    this.teardownStream()
    this.updateStatus({ running: false, measuredFps: 0, modelError: true })
    if (want) this.scheduleRetry()
  }

  /** Long away: look for the user a couple of times a second instead of at full rate. */
  private paceForPresence(snapshot: PostureSnapshot, t: number, phase: CalibrationPhase): void {
    if (snapshot.presence === 'away' && phase === 'idle' && !this.session) {
      this.awaySince ??= t
      if (!this.probing && t - this.awaySince > AWAY_PROBE_AFTER_MS) {
        this.probing = true
        this.loop?.setFps(AWAY_PROBE_FPS)
      }
    } else {
      this.awaySince = null
      if (this.probing) {
        this.probing = false
        this.loop?.setFps(this.session ? this.captureFps() : this.currentFps())
      }
    }
  }

  /** Switches segmentation output on/off to match whether anyone can see the mesh. */
  private async syncMasks(): Promise<void> {
    const want = this.wantsMasks()
    if (want && this.masksOn) this.ensureFace()
    if (!this.pose || want === this.masksOn) return
    try {
      await this.pose.task.setOptions({ outputSegmentationMasks: want })
      this.masksOn = want
    } catch (err) {
      console.warn('[detection] segmentation unavailable — mesh preview falls back to the skeleton:', err)
      this.masksFailed = true
      this.masksOn = false
      useAppStore.setState({ meshUnavailable: true })
      await this.recoverPoseGraph()
    }
    if (this.masksOn) {
      this.clearFaceIdleTimer()
    } else {
      this.meshBuilder.reset()
      useAppStore.setState({ mesh: null })
      // hide/show flips shouldn't rebuild the face model each time — keep it a while
      this.scheduleFaceRelease()
    }
  }

  /**
   * setOptions() swaps the pose graph before it reports errors, so after a
   * failed switch the old graph is gone. Posture detection must not die with
   * the cosmetic mesh: rebuild a mask-free graph, or recreate the landmarker.
   */
  private async recoverPoseGraph(): Promise<void> {
    if (!this.pose) return
    try {
      await this.pose.task.setOptions({ outputSegmentationMasks: false })
    } catch (err) {
      console.error('[detection] landmarker unusable after the segmentation failure — recreating it:', err)
      this.pose.dispose()
      this.pose = null
      if (this.wantRunning) void this.restart()
    }
  }

  /** Loads the face landmarker in the background; the mesh uses a plain head until it's ready. */
  private ensureFace(): void {
    if (this.face || this.faceLoading || this.faceFailed || !this.pose) return
    this.faceLoading = true
    const gen = this.faceGen
    const delegate = this.pose.delegate === 'GPU' && !this.faceGpuBroken ? 'GPU' : 'CPU'
    createFaceLandmarker(delegate)
      .then((face) => {
        if (gen === this.faceGen && this.masksOn) this.face = face
        else face.dispose() // released (pause, delegate change, preview gone) while it loaded
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

  private scheduleFaceRelease(): void {
    if (!this.face || this.faceIdleTimer) return
    this.faceIdleTimer = setTimeout(() => {
      this.faceIdleTimer = null
      if (!this.masksOn) this.releaseFace()
    }, FACE_IDLE_RELEASE_MS)
  }

  private clearFaceIdleTimer(): void {
    if (this.faceIdleTimer) clearTimeout(this.faceIdleTimer)
    this.faceIdleTimer = null
  }

  private releaseFace(): void {
    this.faceGen++
    this.clearFaceIdleTimer()
    this.face?.dispose()
    this.face = null
  }

  private detectFace(t: number): FaceInput | null {
    if (!this.face || !this.video) return null
    if (this.session && !this.faceDuringCapture) return null
    try {
      const points = this.face.task.detectForVideo(this.video, t).faceLandmarks?.[0]
      return points ? { points, topology: faceMeshTopology() } : null
    } catch (err) {
      // GPU trouble gets one retry on the CPU; after that the head stays plain
      console.warn('[detection] face mesh inference failed:', err)
      if (this.face.delegate === 'GPU' && !this.faceGpuBroken) this.faceGpuBroken = true
      else this.faceFailed = true
      this.releaseFace()
      return null
    }
  }

  private buildMesh(result: PoseLandmarkerResult, frame: Frame, t: number): BodyMesh | null {
    const mask = result.segmentationMasks?.[0]
    if (!mask || !frame) {
      this.meshBuilder.reset()
      return null
    }
    try {
      return this.meshBuilder.update(mask.getAsFloat32Array(), mask.width, mask.height, frame, t, this.detectFace(t))
    } catch (err) {
      // purely cosmetic — never let it take posture detection down with it
      console.warn('[detection] body mesh failed — falling back to the skeleton:', err)
      this.masksFailed = true
      useAppStore.setState({ meshUnavailable: true })
      return null
    }
  }

  private maybeSendSnapshot(snapshot: PostureSnapshot, t: number): void {
    const key = `${snapshot.presence}|${snapshot.worstStage}|${snapshot.calibrated}|${snapshot.recalibrationSuggested}`
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

  // ---------- settings / status ----------

  private applySettings(next: Settings): void {
    const prev = this.settings
    this.settings = next
    useAppStore.setState({ settings: next })
    if (!this.engine) return

    this.engine.updateSettings(toEngineSettings(next))
    if (JSON.stringify(prev?.calibration ?? null) !== JSON.stringify(next.calibration ?? null)) {
      this.engine.setBaseline(next.calibration)
    }
    // a stale id re-pointed to the camera already open needs no restart
    if (prev && prev.cameraDeviceId !== next.cameraDeviceId && next.cameraDeviceId !== this.activeCameraId && this.wantRunning) {
      void this.restart()
      return
    }
    if (prev && prev.performancePreset !== next.performancePreset) {
      const fps = PRESET_FPS[next.performancePreset]
      if (!this.probing && !this.session) this.loop?.setFps(fps)
      this.updateStatus({ targetFps: fps })
    }
    if (prev && prev.delegate !== next.delegate) {
      // delegate preference changed: rebuild the landmarkers on next start
      this.pose?.dispose()
      this.pose = null
      this.releaseFace()
      // a different delegate deserves a fresh chance at the preview extras
      this.masksFailed = false
      this.faceFailed = false
      this.faceGpuBroken = false
      useAppStore.setState({ meshUnavailable: false })
      if (this.wantRunning) void this.restart()
    }
  }

  private updateStatus(patch: Partial<DetectionStatus>): void {
    this.status = { ...this.status, ...patch }
    useAppStore.setState({ detection: this.status })
    window.sitsense.sendDetectionStatus(this.status)
  }

  private async refreshCameraList(): Promise<void> {
    try {
      useAppStore.setState({ cameras: await listCameras() })
    } catch {
      // enumeration can fail before any grant — ignore
    }
  }

  private scheduleRetry(): void {
    if (!this.wantRunning || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS)
      if (this.wantRunning) void this.start()
    }, this.retryDelay)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = null
  }
}

function toEngineSettings(s: Settings): EngineSettings {
  return {
    issues: s.issues,
    dwellSeconds: s.notifications.dwellSeconds,
    cooldownMinutes: s.notifications.cooldownMinutes,
    escalation: s.notifications.escalation
  }
}

export const detectionController = new DetectionController()
