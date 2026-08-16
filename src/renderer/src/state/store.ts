import { create } from 'zustand'
import type { AppRoute, PauseState } from '@shared/ipc'
import type { DetectionStatus, PostureSnapshot, TodayStats } from '@shared/posture'
import type { Settings } from '@shared/settings'
import type { PlacementCheck } from '@renderer/posture/calibration'
import type { Landmark } from '@renderer/posture/types'

export type CaptureBanner = 'hold' | null

export interface CalibrationUiState {
  phase: 'idle' | 'positioning' | 'countdown' | 'capturing' | 'done' | 'failed'
  placement: PlacementCheck | null
  /** 0..1 during capture */
  progress: number
  countdownValue: number
  failReason: 'not-enough-frames' | 'unstable' | null
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
  today: TodayStats | null
  appVersion: string

  setRoute: (r: AppRoute) => void
  patchSettings: (patch: unknown) => Promise<void>
}

export const useAppStore = create<AppState>((set) => ({
  settings: null,
  snapshot: null,
  detection: { running: false, delegate: null, targetFps: 10, measuredFps: 0, cameraError: null },
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
  today: null,
  appVersion: '',

  setRoute: (route) => set({ route }),
  patchSettings: async (patch) => {
    const settings = await window.sitsense.setSettings(patch)
    set({ settings })
  }
}))
