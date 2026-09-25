import { describe, expect, it } from 'vitest'
import type { CalibrationBaseline } from '@shared/posture'
import { selectBaselineFromOtherCamera, type AppState } from '../store'

const state = (baseline: Partial<CalibrationBaseline> | null, activeCameraId: string | null, label?: string): AppState =>
  ({
    settings: { calibration: baseline },
    activeCameraId,
    cameras: activeCameraId && label ? [{ deviceId: activeCameraId, label }] : []
  }) as unknown as AppState

describe('selectBaselineFromOtherCamera', () => {
  it('is quiet for the camera the baseline was captured with', () => {
    expect(selectBaselineFromOtherCamera(state({ cameraDeviceId: 'a' }, 'a', 'Logitech C920'))).toBe(false)
  })

  it('flags a different camera', () => {
    expect(selectBaselineFromOtherCamera(state({ cameraDeviceId: 'a', cameraLabel: 'Logitech C920' }, 'b', 'Integrated Camera'))).toBe(true)
    expect(selectBaselineFromOtherCamera(state({ cameraDeviceId: 'a' }, 'b', 'Integrated Camera'))).toBe(true)
  })

  it('treats a new id with the same name as the same camera (moved USB port)', () => {
    expect(selectBaselineFromOtherCamera(state({ cameraDeviceId: 'a', cameraLabel: 'Logitech C920' }, 'b', 'Logitech C920'))).toBe(false)
  })

  it('stays quiet without a baseline or an open camera', () => {
    expect(selectBaselineFromOtherCamera(state(null, 'a', 'x'))).toBe(false)
    expect(selectBaselineFromOtherCamera(state({ cameraDeviceId: 'a' }, null))).toBe(false)
  })
})
