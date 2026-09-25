import { create } from 'zustand'
import type { AppRoute, PauseState } from '@shared/ipc'
import type { DetectionStatus, PostureSnapshot, TodayStats } from '@shared/posture'
import type { Settings } from '@shared/settings'
import type { BodyMesh } from '@renderer/overlay/bodyMesh'
import type { CalibrationFailure, PlacementCheck } from '@renderer/posture/calibration'
import type { Landmark } from '@renderer/posture/types'

export type CaptureBanner = 'hold' | null

export interface CalibrationUiState {
  phase: 'idle' | 'positioning' | 'countdown' | 'capturing' | 'done' | 'failed'
  placement: PlacementCheck | null
  /** 0..1 during capture */
  progress: number
  countdownValue: number
  failReason: CalibrationFailure | null
  banner: CaptureBanner
}

export interface AppState {
  settings: Settings | null
  snapshot: PostureSnapshot | null
  detection: DetectionStatus
  pause: PauseState
  cameras: { deviceId: string; label: string }[]
  route: AppRoute
  calibration: CalibrationUiState
  /** latest landmarks for the preview overlay (null = no pose) */
  overlay: Landmark[] | null
  /** body wireframe for the mesh/hologram preview styles (null = no person or not requested) */
  mesh: BodyMesh | null
  /** segmentation isn't available on this machine — mesh styles fall back to the skeleton */
  meshUnavailable: boolean
  /** main window shown and not minimized */
  windowVisible: boolean
  /** deviceId of the camera actually open (null = none / unknown) */
  activeCameraId: string | null
  today: TodayStats | null
  appVersion: string

  setRoute: (r: AppRoute) => void
  patchSettings: (patch: unknown) => Promise<void>
}

export const useAppStore = create<AppState>((set) => ({
  settings: null,
  snapshot: null,
  detection: { running: false, delegate: null, targetFps: 10, measuredFps: 0, cameraError: null, modelError: false },
  pause: { paused: false, resumeAt: null },
  cameras: [],
  route: 'dashboard',
  calibration: {
    phase: 'idle',
    placement: null,
    progress: 0,
    countdownValue: 0,
    failReason: null,
    banner: null
  },
  overlay: null,
  mesh: null,
  meshUnavailable: false,
  windowVisible: true,
  activeCameraId: null,
  today: null,
  appVersion: '',

  setRoute: (route) => set({ route }),
  patchSettings: async (patch) => {
    const settings = await window.sitsense.setSettings(patch)
    set({ settings })
  }
}))

/**
 * The baseline came from a different camera than the one in use. Ids change
 * when a webcam moves to another USB port, so a matching name counts as the
 * same camera.
 */
export function selectBaselineFromOtherCamera(s: AppState): boolean {
  const baseline = s.settings?.calibration
  if (!baseline?.cameraDeviceId || !s.activeCameraId || baseline.cameraDeviceId === s.activeCameraId) return false
  const activeLabel = s.cameras.find((c) => c.deviceId === s.activeCameraId)?.label
  return !(baseline.cameraLabel && activeLabel && baseline.cameraLabel === activeLabel)
}
