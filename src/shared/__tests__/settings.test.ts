import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../settings'

describe('overlay settings', () => {
  it('defaults to the posture-colored mesh', () => {
    expect(mergeSettings({}).overlay).toEqual({ style: 'mesh', color: 'posture', customColor: '#44d7f0' })
  })

  it('keeps valid choices', () => {
    const s = mergeSettings({ overlay: { style: 'hologram', color: 'violet', customColor: '#12ab9F' } })
    expect(s.overlay).toEqual({ style: 'hologram', color: 'violet', customColor: '#12ab9F' })
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
