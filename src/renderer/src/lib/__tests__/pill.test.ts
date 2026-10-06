import { describe, expect, it } from 'vitest'
import { monitoringPillState } from '../hooks'

const base = { paused: false, cameraError: null, detectorError: null, calibrated: true, mismatch: false } as const

describe('monitoringPillState', () => {
  it('says monitoring only when set up for the camera in use', () => {
    expect(monitoringPillState(base)).toBe('monitoring')
    // a baseline saved with another camera is not applied: nothing is judged, no nudges
    expect(monitoringPillState({ ...base, mismatch: true })).toBe('mismatch')
  })

  it('keeps the priority paused > camera > not set up > new camera', () => {
    expect(monitoringPillState({ ...base, mismatch: true, paused: true })).toBe('paused')
    expect(monitoringPillState({ ...base, mismatch: true, cameraError: 'in-use' })).toBe('camera')
    expect(monitoringPillState({ ...base, mismatch: true, calibrated: false })).toBe('setup')
  })

  it('treats a pose model that failed to load as camera trouble', () => {
    expect(monitoringPillState({ ...base, detectorError: 'model' })).toBe('camera')
    // a transient inference hiccup is retried in place
    expect(monitoringPillState({ ...base, detectorError: 'inference' })).toBe('monitoring')
  })
})
