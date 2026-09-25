import type { FaceLandmarker, PoseLandmarker, PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import type { DetectionStatus, PostureSnapshot } from '@shared/posture'
import { PRESET_FPS, type Settings } from '@shared/settings'
import { BodyMeshBuilder, type BodyMesh, type FaceInput } from '@renderer/overlay/bodyMesh'
import { CalibrationSession, assessPlacement } from '@renderer/posture/calibration'
import { CAL_COUNTDOWN_S } from '@renderer/posture/constants'
import { PostureEngine, type EngineSettings } from '@renderer/posture/engine'
import type { Frame } from '@renderer/posture/types'
import { useAppStore } from '@renderer/state/store'
import { CameraOpenError, listCameras, openCamera, stopStream } from './camera'
import { FrameLoop } from './frame-loop'
import { createFaceLandmarker, createLandmarker, faceMeshTopology, recreateAsCpu } from './landmarker'

const SNAPSHOT_MIN_INTERVAL_MS = 1000
const FPS_WINDOW_MS = 2000
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30000

/**
 * Owns the camera stream, the MediaPipe landmarker, the frame loop, and the
 * posture engine; bridges their results into the zustand store and main-process
 * IPC. Pausing releases the camera completely (webcam LED off — trust signal).
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
  /** how long the last frame took, all models included */
  private frameCostMs = 0
  /** whether this calibration capture can afford the face model (decided once per capture) */
  private faceDuringCapture = true

  private session: CalibrationSession | null = null
  private countdownTimer: ReturnType<typeof setInterval> | null = null

  private starting = false
  private pendingRestart = false
  private wantRunning = false
  private firstInferenceOk = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_BASE_MS

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
    window.sitsense.onWindowVisibility((visible) => {
      this.visibilityKnown = true
      this.windowVisible = visible
      useAppStore.setState({ windowVisible: visible })
    })
    const [settings, appStatus] = await Promise.all([
      window.sitsense.getSettings(),
      window.sitsense.getAppStatus()
    ])
    this.settings = settings
    this.engine = new PostureEngine(settings.calibration, toEngineSettings(settings))
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
        // a mid-capture pause would silently starve the calibration session
        if (this.session) this.cancelCalibration()
        this.stopCapture()
      } else {
        void this.start()
      }
    })
    window.sitsense.onNavigate((route) => useAppStore.getState().setRoute(route))
    window.sitsense.onRequestCalibration(() => useAppStore.getState().setRoute('calibrate'))
    window.sitsense.onSystemResumed(() => {
      // camera streams often die silently across sleep/resume
      if (this.wantRunning) void this.restart()
    })
    navigator.mediaDevices.addEventListener('devicechange', () => {
      void this.refreshCameraList()
      if (this.status.cameraError && this.wantRunning) void this.restart()
    })

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

  async start(): Promise<void> {
    this.wantRunning = true
    if (this.starting || !this.settings || !this.video) return
    this.starting = true
    this.clearRetry()
    try {
      // re-entry (retry / redundant resume): drop any existing loop and stream
      // first so nothing stacks or leaks
      this.loop?.stop()
      this.loop = null
      stopStream(this.stream)
      this.stream = null

      const stream = await openCamera(this.settings.cameraDeviceId)
      if (!this.wantRunning) {
        // paused while the camera was opening — release it immediately
        stopStream(stream)
        return
      }
      this.stream = stream
      const track = stream.getVideoTracks()[0]
      if (track) track.onended = () => this.scheduleRetry()
      this.video.srcObject = stream
      await this.video.play().catch(() => undefined)
      await this.refreshCameraList()

      if (!this.landmarker) {
        const pref =
          this.settings.delegate === 'auto' && this.settings.resolvedDelegate
            ? this.settings.resolvedDelegate
            : this.settings.delegate
        const created = await createLandmarker(pref)
        this.landmarker = created.landmarker
        this.delegate = created.delegate
        this.masksOn = false
        this.firstInferenceOk = false
        if (this.settings.resolvedDelegate !== created.delegate) {
          void window.sitsense.setSettings({ resolvedDelegate: created.delegate })
        }
      }

      if (!this.wantRunning) {
        stopStream(this.stream)
        this.stream = null
        this.video.srcObject = null
        return
      }
      const fps = PRESET_FPS[this.settings.performancePreset]
      this.loop = new FrameLoop(this.video, fps, () => this.processFrame())
      this.loop.start()
      this.retryDelay = RETRY_BASE_MS
      this.fpsWindowStart = performance.now()
      this.frameCount = 0
      this.updateStatus({ running: true, delegate: this.delegate, targetFps: fps, cameraError: null })
    } catch (err) {
      stopStream(this.stream)
      this.stream = null
      if (err instanceof CameraOpenError) {
        this.updateStatus({ running: false, cameraError: err.kind })
      } else {
        // landmarker/asset failure — not the camera's fault, don't mislabel it
        console.error('[detection] start failed:', err)
        this.updateStatus({ running: false })
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

  /** Releases everything camera-related; the landmarker survives for restarts. */
  stopCapture(): void {
    this.wantRunning = false
    this.clearRetry()
    this.loop?.stop()
    this.loop = null
    stopStream(this.stream)
    this.stream = null
    if (this.video) this.video.srcObject = null
    this.meshBuilder.reset()
    this.releaseFace()
    useAppStore.setState({ overlay: null, mesh: null })
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

  // ---------- calibration wizard driving ----------

  startPlacementCheck(): void {
    useAppStore.setState((s) => ({
      calibration: { ...s.calibration, phase: 'positioning', failReason: null, progress: 0 }
    }))
  }

  beginCountdown(): void {
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
    this.session = new CalibrationSession(performance.now())
    // the 5s capture needs ≥ ~45 samples for a solid median — temporarily lift
    // the frame rate above the power-saving preset (restored on finish/cancel)
    const captureFps = Math.max(PRESET_FPS.balanced, this.currentFps())
    this.loop?.setFps(captureFps)
    // a machine that can't fit the cosmetic face mesh into the capture frame
    // rate drops it for these few seconds rather than starve the baseline
    this.faceDuringCapture = this.frameCostMs < 0.6 * (1000 / captureFps)
    useAppStore.setState((s) => ({ calibration: { ...s.calibration, phase: 'capturing', progress: 0 } }))
  }

  cancelCalibration(): void {
    this.cancelCountdown()
    this.session = null
    this.loop?.setFps(this.currentFps())
    useAppStore.setState((s) => ({
      calibration: { ...s.calibration, phase: 'idle', progress: 0, banner: null }
    }))
  }

  private currentFps(): number {
    return PRESET_FPS[this.settings?.performancePreset ?? 'balanced']
  }

  private cancelCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = null
  }

  private finishCalibration(): void {
    if (!this.session) return
    const result = this.session.finish(Date.now(), this.settings?.cameraDeviceId ?? null)
    this.session = null
    this.loop?.setFps(this.currentFps())
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
    if (!this.landmarker || !this.video || !this.engine) return
    await this.syncMasks()
    const t = performance.now()
    try {
      await this.processDetections(t)
    } finally {
      this.frameCostMs = performance.now() - t
    }
  }

  private async processDetections(t: number): Promise<void> {
    if (!this.landmarker || !this.video || !this.engine) return

    let frame: Frame = null
    let mesh: BodyMesh | null = null
    let result: PoseLandmarkerResult | null = null
    try {
      result = this.landmarker.detectForVideo(this.video, t)
      frame = (result.landmarks?.[0] as Frame) ?? null
      this.firstInferenceOk = true
      if (this.masksOn) mesh = this.buildMesh(result, frame, t)
    } catch (err) {
      if (!this.firstInferenceOk && this.delegate === 'GPU') {
        // some GPU failures only surface at the first inference
        console.warn('[detection] first GPU inference failed, recreating as CPU:', err)
        this.landmarker = await recreateAsCpu(this.landmarker)
        this.masksOn = false
        this.delegate = 'CPU'
        void window.sitsense.setSettings({ resolvedDelegate: 'CPU' })
        this.updateStatus({ delegate: 'CPU' })
        return
      }
      console.error('[detection] inference failed:', err)
      return
    } finally {
      // masks are copies owned by us (no callback was passed) — free them every frame
      result?.close()
    }

    useAppStore.setState({ overlay: frame ? [...frame] : null, mesh })
    this.trackFps(t)

    const cal = useAppStore.getState().calibration
    if (cal.phase === 'positioning' || cal.phase === 'countdown' || cal.phase === 'capturing') {
      const placement = assessPlacement(frame)
      useAppStore.setState((s) => ({ calibration: { ...s.calibration, placement } }))
      if (this.session && cal.phase === 'capturing') {
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
    useAppStore.setState({ snapshot })
    for (const alert of alerts) window.sitsense.sendAlert(alert)
    this.maybeSendSnapshot(snapshot, t)
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
    }
    if (!this.masksOn) {
      this.meshBuilder.reset()
      this.releaseFace()
      useAppStore.setState({ mesh: null })
    }
  }

  /** Loads the face landmarker in the background; the mesh uses a plain head until it's ready. */
  private ensureFace(): void {
    if (this.face || this.faceLoading || this.faceFailed || !this.delegate) return
    this.faceLoading = true
    createFaceLandmarker(this.delegate === 'GPU' && !this.faceGpuBroken ? 'GPU' : 'CPU')
      .then((face) => {
        if (this.masksOn) this.face = face
        else face.close() // the preview went away while it loaded
      })
      .catch((err) => {
        console.warn('[detection] face mesh unavailable — the wireframe keeps a plain head:', err)
        this.faceFailed = true
      })
      .finally(() => {
        this.faceLoading = false
      })
  }

  private releaseFace(): void {
    try {
      this.face?.close()
    } catch {
      // closing a broken task is best-effort
    }
    this.face = null
  }

  private detectFace(t: number): FaceInput | null {
    if (!this.face || !this.video) return null
    if (this.session && !this.faceDuringCapture) return null
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
    const key = `${snapshot.presence}|${snapshot.worstStage}|${snapshot.calibrated}`
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
    if (prev && prev.cameraDeviceId !== next.cameraDeviceId && this.wantRunning) {
      void this.restart()
      return
    }
    if (prev && prev.performancePreset !== next.performancePreset) {
      const fps = PRESET_FPS[next.performancePreset]
      this.loop?.setFps(fps)
      this.updateStatus({ targetFps: fps })
    }
    if (prev && prev.delegate !== next.delegate) {
      // delegate preference changed: rebuild the landmarkers on next start
      this.landmarker?.close()
      this.landmarker = null
      this.delegate = null
      this.releaseFace()
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
