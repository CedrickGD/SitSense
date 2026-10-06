// The detection controller's setup lifecycle, driven with fakes: no MediaPipe, no camera, no
// Electron. The landmarker returns simulated poses (posture/__tests__/sim.ts), the frame loop
// is driven by hand, and window.sitsense is a recording stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalibrationBaseline } from '@shared/posture'
import { DEFAULT_SETTINGS, PRESET_FPS, type Settings } from '@shared/settings'
import type { PoseFrame } from '@renderer/posture/types'
import { runSetup } from '@renderer/posture/__tests__/harness'
import { GOOD_SEATED, PoseSim, type CameraParams, type PostureParams } from '@renderer/posture/__tests__/sim'

const fakes = vi.hoisted(() => ({
  loops: [] as Array<{ fps: number; onFrame: () => void | Promise<void>; stopped: boolean }>,
  frame: null as PoseFrame | null,
  openCamera: vi.fn()
}))

vi.mock('../camera', async () => {
  const actual = await vi.importActual<typeof import('../camera')>('../camera')
  return { ...actual, openCamera: fakes.openCamera, listCameras: vi.fn(async () => []), stopStream: vi.fn() }
})
vi.mock('../landmarker', () => ({
  webglAvailable: () => true,
  createLandmarker: vi.fn(async () => ({
    landmarker: {
      detectForVideo: () => ({
        landmarks: fakes.frame ? [fakes.frame.image] : [],
        worldLandmarks: fakes.frame?.world ? [fakes.frame.world] : [],
        close: () => undefined
      }),
      setOptions: async () => undefined,
      close: () => undefined
    },
    delegate: 'GPU',
    gpuFailed: false
  })),
  createFaceLandmarker: vi.fn(),
  faceMeshTopology: () => null,
  recreateAsCpu: vi.fn()
}))
vi.mock('../frame-loop', () => ({
  FrameLoop: class {
    fps: number
    onFrame: () => void | Promise<void>
    stopped = false
    constructor(_video: unknown, fps: number, onFrame: () => void | Promise<void>) {
      this.fps = fps
      this.onFrame = onFrame
      fakes.loops.push(this)
    }
    start(): void {}
    stop(): void {
      this.stopped = true
    }
    setFps(fps: number): void {
      this.fps = fps
    }
  }
}))
vi.mock('@renderer/ai/review-image', () => ({ makeSketch: () => 'img', makeSnapshot: () => 'img' }))

const SIDE_CAM: CameraParams = { azimuth: 80, elevation: 10, distance: 1.2, roll: 0, hfov: 65, aspect: 16 / 9 }
const FRONT_CAM: CameraParams = { azimuth: 0, elevation: 15, distance: 1.1, roll: 0, hfov: 70, aspect: 16 / 9 }
class NoKnees extends PoseSim {
  render(q: PostureParams): PoseFrame {
    const fr = super.render(q)
    return { ...fr, image: fr.image.map((l, i) => (i === 25 || i === 26 ? { ...l, visibility: 0.1 } : l)) }
  }
}
const GOOD = GOOD_SEATED[0].p

type Handler = (v: unknown) => void

/** A fresh controller (module singleton) wired to fakes. */
async function boot(opts: { paused?: boolean; settings?: Partial<Settings> } = {}) {
  const handlers: Record<string, Handler> = {}
  const on = (name: string) => (cb: Handler) => {
    handlers[name] = cb
    return () => undefined
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, performancePreset: 'efficient', ...opts.settings }
  const track = { onended: null as null | (() => void), onmute: null, onunmute: null, muted: false }
  const stream = { getVideoTracks: () => [track] }
  const bridge = {
    getSettings: async () => settings,
    getAppStatus: async () => ({
      version: 't',
      pause: { paused: !!opts.paused, resumeAt: null },
      packaged: false,
      windowVisible: true,
      sitting: null
    }),
    onWindowVisibility: on('visibility'),
    onSettingsChanged: on('settings'),
    onPauseChanged: on('pause'),
    onNavigate: on('navigate'),
    onRequestCalibration: on('calibration'),
    onSystemResumed: on('resumed'),
    sendDetectionStatus: vi.fn(),
    sendAlert: vi.fn(),
    sendPostureUpdate: vi.fn(),
    setSettings: vi.fn(async () => settings),
    setPause: vi.fn(async () => undefined),
    aiReviewPosture: vi.fn(),
    aiCancelReview: vi.fn(async () => undefined)
  }
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    style: {},
    srcObject: null,
    play: async () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  vi.stubGlobal('window', { sitsense: bridge })
  vi.stubGlobal('document', { createElement: () => video, body: { appendChild: () => undefined } })
  vi.stubGlobal('navigator', { mediaDevices: { addEventListener: () => undefined } })
  fakes.openCamera.mockReset()
  fakes.openCamera.mockResolvedValue({ stream, deviceId: 'cam-1', label: 'Cam', fellBack: false })
  fakes.loops.length = 0
  fakes.frame = null

  const { detectionController } = await import('../controller')
  const { useAppStore } = await import('@renderer/state/store')
  const setupUi = await import('../setup-ui')
  const copy = await import('@renderer/screens/setup/copy')
  await detectionController.init()
  const ctrl = detectionController as unknown as Record<string, unknown>
  /** one processed frame of `frame` (null = nobody in view), ~66 ms after the last */
  const tick = async (frame: PoseFrame | null): Promise<void> => {
    fakes.frame = frame
    vi.advanceTimersByTime(66)
    const loop = fakes.loops[fakes.loops.length - 1]
    if (loop && !loop.stopped) await loop.onFrame()
  }
  return { detectionController, ctrl, useAppStore, setupUi, copy, bridge, handlers, track, tick }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('setup after a pause ends (finding: stale "Monitoring is paused")', () => {
  it('resuming clears the suspension even when the camera then fails to start', async () => {
    const { detectionController, useAppStore, copy, handlers } = await boot({ paused: true })
    detectionController.startSetup()
    expect(useAppStore.getState().setup.suspended).toBe('paused')
    const { CameraOpenError } = await import('../camera')
    fakes.openCamera.mockRejectedValue(new CameraOpenError('in-use'))
    handlers.pause({ paused: false, resumeAt: null })
    useAppStore.setState({ pause: { paused: false, resumeAt: null } })
    await flush()
    const s = useAppStore.getState()
    expect(s.detection.cameraError).toBe('in-use')
    expect(s.setup.suspended).toBeNull()
    const blocked = copy.blockedCopy(s.setup, { paused: s.pause.paused, cameraError: true, detectorError: null })
    expect(blocked?.text).toBe("SitSense can't see your camera right now.")
  })
})

describe('hiding the window during setup (finding: invisible setup, no nudges)', () => {
  it('drops the coaching session and lets nudges through while hidden; coaching restarts when shown', async () => {
    const { detectionController, ctrl, useAppStore, bridge, handlers, tick } = await boot()
    await flush()
    expect(fakes.loops.length).toBe(1)
    const engine = ctrl.engine as { processFrame: (...a: unknown[]) => { snapshot: unknown; alerts: unknown[] } }
    const real = engine.processFrame.bind(engine)
    engine.processFrame = (...a: unknown[]) => ({ ...real(...a), alerts: [{ issue: 'sink' }] })
    const sim = new PoseSim(SIDE_CAM, { seed: 2 })

    detectionController.startSetup()
    detectionController.beginSetupCoaching()
    expect(ctrl.session).not.toBeNull()
    expect(fakes.loops[0].fps).toBe(PRESET_FPS.balanced) // raised for setup
    await tick(sim.render(GOOD))
    expect(bridge.sendAlert).not.toHaveBeenCalled() // the user is looking at setup

    handlers.visibility(false) // closed to the tray
    expect(ctrl.session).toBeNull()
    expect(fakes.loops[0].fps).toBe(PRESET_FPS.efficient)
    expect(useAppStore.getState().setup.phase).toBe('idle')
    await tick(sim.render(GOOD))
    expect(bridge.sendAlert).toHaveBeenCalledTimes(1)
    expect(ctrl.session).toBeNull() // no session starts while hidden

    handlers.visibility(true)
    expect(ctrl.session).not.toBeNull()
    expect(useAppStore.getState().setup.phase).toBe('searching')
    await tick(sim.render(GOOD))
    expect(bridge.sendAlert).toHaveBeenCalledTimes(1)
  })
})

describe("abandoned AI reviews free main's review slot", () => {
  const conn = { id: 'a', kind: 'gemini', label: 'Gemini', baseUrl: null, model: 'm', enabled: true, hasKey: true, keyHint: null, lastTest: null } as const
  const ai = { ...DEFAULT_SETTINGS.ai, enabled: true, connections: [conn] }

  it('dismissing a pending Ask AI check cancels that request in main', async () => {
    const { detectionController, bridge, tick } = await boot({ settings: { ai } })
    await flush()
    bridge.aiReviewPosture.mockReturnValue(new Promise(() => undefined)) // never answers
    const sim = new PoseSim(SIDE_CAM, { seed: 4 })
    for (let i = 0; i < 15; i++) await tick(sim.render(GOOD))
    void detectionController.askAi()
    await flush()
    expect(bridge.aiReviewPosture).toHaveBeenCalledTimes(1)
    const sent = bridge.aiReviewPosture.mock.calls[0][0] as { requestId?: string }
    expect(sent.requestId).toMatch(/^check-[A-Za-z0-9_-]+$/)
    detectionController.dismissAiCheck()
    expect(bridge.aiCancelReview).toHaveBeenCalledWith(sent.requestId)
    // nothing pending any more: a second dismiss cancels nothing
    detectionController.dismissAiCheck()
    expect(bridge.aiCancelReview).toHaveBeenCalledTimes(1)
  })

  it('a finished check leaves nothing to cancel', async () => {
    const { detectionController, bridge, tick } = await boot({ settings: { ai } })
    await flush()
    bridge.aiReviewPosture.mockResolvedValue({ ok: false, message: 'nope' })
    const sim = new PoseSim(SIDE_CAM, { seed: 4 })
    for (let i = 0; i < 15; i++) await tick(sim.render(GOOD))
    await detectionController.askAi()
    detectionController.dismissAiCheck()
    expect(bridge.aiCancelReview).not.toHaveBeenCalled()
  })
})

describe('step 1 camera check', () => {
  it('goes idle when the camera is released (finding: stale "I can see you")', async () => {
    const { detectionController, setupUi, track, tick } = await boot()
    await flush()
    detectionController.startSetup()
    const sim = new PoseSim(SIDE_CAM, { seed: 3 })
    for (let i = 0; i < 20; i++) await tick(sim.render(GOOD))
    expect(setupUi.useSetupProbe.getState()).toMatchObject({ inView: true, ready: true })
    track.onended?.() // unplugged; a retry is scheduled, no camera error
    expect(setupUi.useSetupProbe.getState()).toEqual(setupUi.IDLE_PROBE)
  })

  it("is not measured with the saved baseline's gravity or hip setting (finding: redo setup)", async () => {
    // the last setup could not use the hips (trunkFwd null); the camera now sees them
    const saved = runSetup(new PoseSim(SIDE_CAM, { seed: 9 }), GOOD).state.baseline!
    const calibration: CalibrationBaseline = { ...saved, trunkFwd: null, cameraDeviceId: 'cam-1' }
    const { detectionController, setupUi, ctrl, tick } = await boot({ settings: { calibration } })
    await flush()
    expect(ctrl.appliedBaselineKey).not.toBe('null') // the baseline is applied to the engine
    detectionController.startSetup()
    const sim = new NoKnees(FRONT_CAM, { seed: 3 })
    for (let i = 0; i < 30; i++) await tick(sim.render(GOOD))
    expect(setupUi.useSetupProbe.getState()).toMatchObject({ inView: true, hips: 'seen', backCheckable: false, view: 'front' })
  })
})
