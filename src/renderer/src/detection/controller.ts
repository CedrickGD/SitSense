import type { PoseLandmarker } from '@mediapipe/tasks-vision'
import type { DetectionStatus, PostureSnapshot } from '@shared/posture'
import { PRESET_FPS, type Settings } from '@shared/settings'
import { CalibrationSession, assessPlacement } from '@renderer/posture/calibration'
import { CAL_COUNTDOWN_S } from '@renderer/posture/constants'
import { PostureEngine, type EngineSettings } from '@renderer/posture/engine'
import type { Frame } from '@renderer/posture/types'
import { useAppStore } from '@renderer/state/store'
import { CameraOpenError, listCameras, openCamera, stopStream } from './camera'
import { FrameLoop } from './frame-loop'
import { createLandmarker, recreateAsCpu } from './landmarker'

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

  private session: CalibrationSession | null = null
  private countdownTimer: ReturnType<typeof setInterval> | null = null

  private starting = false
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
    const [settings, appStatus] = await Promise.all([
      window.sitsense.getSettings(),
      window.sitsense.getAppStatus()
    ])
    this.settings = settings
    this.engine = new PostureEngine(settings.calibration, toEngineSettings(settings))
    useAppStore.setState({ settings, pause: appStatus.pause, appVersion: appStatus.version })

    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.video.autoplay = true
    this.video.style.display = 'none'
    document.body.appendChild(this.video)

    window.sitsense.onSettingsChanged((next) => this.applySettings(next))
    window.sitsense.onPauseChanged((pause) => {
      useAppStore.setState({ pause })
      if (pause.paused) this.stopCapture()
      else void this.start()
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
      this.stream = await openCamera(this.settings.cameraDeviceId)
      const track = this.stream.getVideoTracks()[0]
      if (track) track.onended = () => this.scheduleRetry()
      this.video.srcObject = this.stream
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
        this.firstInferenceOk = false
        if (this.settings.resolvedDelegate !== created.delegate) {
          void window.sitsense.setSettings({ resolvedDelegate: created.delegate })
        }
      }

      const fps = PRESET_FPS[this.settings.performancePreset]
      this.loop = new FrameLoop(this.video, fps, () => this.processFrame())
      this.loop.start()
      this.retryDelay = RETRY_BASE_MS
      this.fpsWindowStart = performance.now()
      this.frameCount = 0
      this.updateStatus({ running: true, delegate: this.delegate, targetFps: fps, cameraError: null })
    } catch (err) {
      const kind = err instanceof CameraOpenError ? err.kind : 'in-use'
      this.updateStatus({ running: false, cameraError: kind })
      this.scheduleRetry()
    } finally {
      this.starting = false
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
    useAppStore.setState({ overlay: null })
    this.updateStatus({ running: false, measuredFps: 0 })
  }

  async restart(): Promise<void> {
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
    useAppStore.setState((s) => ({ calibration: { ...s.calibration, phase: 'capturing', progress: 0 } }))
  }

  cancelCalibration(): void {
    this.cancelCountdown()
    this.session = null
    useAppStore.setState((s) => ({
      calibration: { ...s.calibration, phase: 'idle', progress: 0, banner: null }
    }))
  }

  private cancelCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = null
  }

  private finishCalibration(): void {
    if (!this.session) return
    const result = this.session.finish(Date.now(), this.settings?.cameraDeviceId ?? null)
    this.session = null
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
    const t = performance.now()

    let frame: Frame = null
    try {
      const result = this.landmarker.detectForVideo(this.video, t)
      frame = (result.landmarks?.[0] as Frame) ?? null
      this.firstInferenceOk = true
    } catch (err) {
      if (!this.firstInferenceOk && this.delegate === 'GPU') {
        // some GPU failures only surface at the first inference
        console.warn('[detection] first GPU inference failed, recreating as CPU:', err)
        this.landmarker = await recreateAsCpu(this.landmarker)
        this.delegate = 'CPU'
        void window.sitsense.setSettings({ resolvedDelegate: 'CPU' })
        this.updateStatus({ delegate: 'CPU' })
        return
      }
      console.error('[detection] inference failed:', err)
      return
    }

    useAppStore.setState({ overlay: frame ? [...frame] : null })
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
      // delegate preference changed: rebuild the landmarker on next start
      this.landmarker?.close()
      this.landmarker = null
      this.delegate = null
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
