import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../settings'

describe('overlay settings', () => {
  it('defaults to the posture-colored alignment lines', () => {
    expect(mergeSettings({}).overlay).toEqual({ style: 'skeleton', color: 'posture', customColor: '#44d7f0', meshIntensity: 0.4 })
  })

  it('moves v1 files off the old mesh default once, keeping their color', () => {
    const v1 = mergeSettings({ overlay: { style: 'mesh', color: 'cyan', customColor: '#44d7f0' } })
    expect(v1.overlay).toEqual({ style: 'skeleton', color: 'cyan', customColor: '#44d7f0', meshIntensity: 0.4 })
    const v2 = mergeSettings({ settingsVersion: 2, overlay: { style: 'mesh', color: 'cyan', customColor: '#44d7f0' } })
    expect(v2.overlay.style).toBe('mesh')
  })

  it('keeps valid choices', () => {
    const s = mergeSettings({ overlay: { style: 'hologram', color: 'violet', customColor: '#12ab9F' } })
    expect(s.overlay).toEqual({ style: 'hologram', color: 'violet', customColor: '#12ab9F', meshIntensity: 0.4 })
    expect(mergeSettings({ overlay: { color: 'custom' } }).overlay.color).toBe('custom')
  })

  it('falls back field by field on stale or garbage values', () => {
    const s = mergeSettings({ overlay: { style: 'neon', color: 'toString', customColor: 'red' } })
    expect(s.overlay).toEqual(DEFAULT_SETTINGS.overlay)
    expect(mergeSettings({ overlay: { color: 'lime', customColor: 42 } }).overlay).toEqual({
      ...DEFAULT_SETTINGS.overlay,
      color: 'lime'
    })
  })

  it('fills the overlay group in for settings files written before it existed', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<typeof DEFAULT_SETTINGS>
    delete legacy.overlay
    expect(mergeSettings(legacy).overlay).toEqual(DEFAULT_SETTINGS.overlay)
  })
})

describe('calibration migration', () => {
  it('drops v1 (frontal-camera) baselines so setup runs again', () => {
    expect(mergeSettings({ calibration: { capturedAt: 1, U0: 0.15, sSh0: 0.15 } }).calibration).toBeNull()
  })

  it('keeps a v2 baseline', () => {
    const b = {
      version: 2,
      capturedAt: 1,
      cameraDeviceId: null,
      up: [0, -1, 0],
      upSource: 'camera',
      forward: [0, 0, -1],
      view: { kind: 'front', yawDeg: 0, elevationDeg: 0 },
      verified: true,
      neckFwd: 10,
      neckLat: 0,
      headPitch: 15,
      headRollRel: 0,
      shoulderTilt: 0,
      trunkFwd: null,
      trunkLat: null,
      torsoLen: null,
      neckH: 0.12,
      ppm: 1.5,
      anchor: [0, 0.1, 0.7]
    }
    expect(mergeSettings({ calibration: b }).calibration).toEqual(b)
  })
})

describe('ai settings', () => {
  it('is off by default and sends only a sketch', () => {
    expect(mergeSettings({}).ai).toEqual({ enabled: false, share: 'sketch', useInSetup: true, connections: [] })
  })

  it('drops malformed connections and unknown providers', () => {
    const s = mergeSettings({
      ai: {
        enabled: true,
        share: 'everything',
        connections: [
          { id: 'a', kind: 'gemini', label: 'G', model: 'gemini-x', enabled: true },
          { id: 'a', kind: 'openai', model: 'dup id' },
          { id: 'b', kind: 'skynet', model: 'x' },
          'garbage',
          { kind: 'openai', model: 'no id' }
        ]
      }
    })
    expect(s.ai.enabled).toBe(true)
    expect(s.ai.share).toBe('sketch')
    expect(s.ai.connections.map((c) => c.id)).toEqual(['a'])
  })
})

describe('mesh intensity', () => {
  it('defaults to 0.4', () => {
    expect(DEFAULT_SETTINGS.overlay.meshIntensity).toBe(0.4)
    expect(mergeSettings({ settingsVersion: 2, overlay: { style: 'mesh' } }).overlay.meshIntensity).toBe(0.4)
  })

  it('keeps values in 0.15–1 and clamps the rest', () => {
    expect(mergeSettings({ overlay: { meshIntensity: 0.15 } }).overlay.meshIntensity).toBe(0.15)
    expect(mergeSettings({ overlay: { meshIntensity: 0.73 } }).overlay.meshIntensity).toBe(0.73)
    expect(mergeSettings({ overlay: { meshIntensity: 1 } }).overlay.meshIntensity).toBe(1)
    expect(mergeSettings({ overlay: { meshIntensity: 0 } }).overlay.meshIntensity).toBe(0.15)
    expect(mergeSettings({ overlay: { meshIntensity: -3 } }).overlay.meshIntensity).toBe(0.15)
    expect(mergeSettings({ overlay: { meshIntensity: 7 } }).overlay.meshIntensity).toBe(1)
  })

  it.each([['a string', '0.8'], ['NaN', NaN], ['Infinity', Infinity], ['null', null], ['an object', {}]])('falls back to the default for %s', (_n, v) => {
    expect(mergeSettings({ overlay: { meshIntensity: v } }).overlay.meshIntensity).toBe(0.4)
  })
})

describe('break reminders', () => {
  it('are on by default, every 50 minutes', () => {
    expect(mergeSettings({}).breaks).toEqual({ enabled: true, intervalMinutes: 50 })
  })

  it('fills the group in for files written before it existed', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<typeof DEFAULT_SETTINGS>
    delete legacy.breaks
    expect(mergeSettings(legacy).breaks).toEqual(DEFAULT_SETTINGS.breaks)
  })

  it('keeps valid values and clamps the interval to 20–120 whole minutes', () => {
    expect(mergeSettings({ breaks: { enabled: false, intervalMinutes: 30 } }).breaks).toEqual({ enabled: false, intervalMinutes: 30 })
    expect(mergeSettings({ breaks: { intervalMinutes: 5 } }).breaks.intervalMinutes).toBe(20)
    expect(mergeSettings({ breaks: { intervalMinutes: 500 } }).breaks.intervalMinutes).toBe(120)
    expect(mergeSettings({ breaks: { intervalMinutes: 44.6 } }).breaks.intervalMinutes).toBe(45)
  })

  it('falls back field by field on garbage', () => {
    expect(mergeSettings({ breaks: { enabled: 'yes', intervalMinutes: '30' } }).breaks).toEqual({ enabled: true, intervalMinutes: 50 })
    expect(mergeSettings({ breaks: 'often' }).breaks).toEqual({ enabled: true, intervalMinutes: 50 })
    expect(mergeSettings({ breaks: [1, 2] }).breaks).toEqual({ enabled: true, intervalMinutes: 50 })
    expect(mergeSettings({ breaks: null }).breaks).toEqual({ enabled: true, intervalMinutes: 50 })
  })
})

describe('update checks', () => {
  it('are on by default', () => {
    expect(DEFAULT_SETTINGS.updates).toEqual({ autoCheck: true })
    expect(mergeSettings({}).updates).toEqual({ autoCheck: true })
  })

  it('fills the group in for files written before it existed', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<typeof DEFAULT_SETTINGS>
    delete legacy.updates
    expect(mergeSettings(legacy).updates).toEqual({ autoCheck: true })
  })

  it('keeps a boolean', () => {
    expect(mergeSettings({ updates: { autoCheck: false } }).updates).toEqual({ autoCheck: false })
    expect(mergeSettings({ updates: { autoCheck: true } }).updates).toEqual({ autoCheck: true })
  })

  it.each([
    ['a string', { autoCheck: 'no' }],
    ['a number', { autoCheck: 0 }],
    ['null', { autoCheck: null }],
    ['a scalar group', 'off'],
    ['an array group', [false]],
    ['a null group', null]
  ])('falls back to the default for %s', (_n, updates) => {
    expect(mergeSettings({ updates }).updates).toEqual({ autoCheck: true })
  })

  it('drops unknown keys in the group', () => {
    expect(mergeSettings({ updates: { autoCheck: false, channel: 'beta', url: 'https://evil.example' } }).updates).toEqual({ autoCheck: false })
  })
})
