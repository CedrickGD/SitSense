import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings'
import { ISSUES } from '@shared/posture'
import { SETTINGS_CATEGORIES } from '@renderer/state/store'
import {
  CATEGORY_META,
  categoryIntro,
  categoryNavMode,
  historyLine,
  isAtDefaults,
  keysLine,
  meshPercent,
  notifyFrom,
  previewStyleOf,
  resetPatch,
  SENSITIVITY_HINTS,
  SENSITIVITY_NAMES,
  SENSITIVITY_STEPS,
  sensitivityIndex,
  stagesFrom,
  storedStyleFor,
  TOAST_PREVIEW
} from '../meta'

describe('categories', () => {
  it('has copy for every category in list order', () => {
    for (const c of SETTINGS_CATEGORIES) {
      expect(CATEGORY_META[c].title).toBeTruthy()
      expect(CATEGORY_META[c].description).toBeTruthy()
    }
    expect(categoryIntro('about', '1.2.3')).toBe('SitSense, version 1.2.3.')
    expect(categoryIntro('about', '')).toBe('SitSense, version —.')
    expect(categoryIntro('camera', '1')).toBe('Which camera SitSense uses and how the preview looks.')
  })
  it('keeps a side list only while the cards beside it still get two columns (§6.1)', () => {
    // available width = the Settings column; list (260 / 200) + 32 chrome + 600 grid
    expect(categoryNavMode(1200)).toBe('full')
    expect(categoryNavMode(892)).toBe('full')
    expect(categoryNavMode(891)).toBe('compact')
    expect(categoryNavMode(832)).toBe('compact')
    expect(categoryNavMode(831)).toBe('chips')
    // the old window-width bug: ~730 px of room drew a 260 px list and a 1-column grid
    expect(categoryNavMode(730)).toBe('chips')
    expect(categoryNavMode(0)).toBe('chips')
  })
  it('never gives a wider space fewer grid columns than a narrower one', () => {
    const cols = (w: number): number => {
      const mode = categoryNavMode(w)
      const list = mode === 'full' ? 260 + 32 : mode === 'compact' ? 200 + 32 : 0
      return w - list >= 600 ? 2 : 1
    }
    for (let w = 400; w < 1600; w++) expect(cols(w + 1)).toBeGreaterThanOrEqual(cols(w))
  })
})

describe('overlay style', () => {
  it('shows the legacy hologram as Mesh and keeps the dim backdrop when re-picking Mesh', () => {
    expect(previewStyleOf('hologram')).toBe('mesh')
    expect(previewStyleOf('skeleton')).toBe('skeleton')
    expect(storedStyleFor('mesh', 'hologram')).toBe('hologram')
    expect(storedStyleFor('mesh', 'skeleton')).toBe('mesh')
    expect(storedStyleFor('off', 'hologram')).toBe('off')
    expect(storedStyleFor('skeleton', 'mesh')).toBe('skeleton')
  })
  it('formats mesh strength as a clamped percent', () => {
    expect(meshPercent(0.45)).toBe('45%')
    expect(meshPercent(1)).toBe('100%')
    expect(meshPercent(0.05)).toBe('15%')
    expect(meshPercent(Number.NaN)).toBe('40%')
  })
})

describe('sensitivity', () => {
  it('snaps to the nearest of five named steps', () => {
    expect(SENSITIVITY_NAMES).toHaveLength(SENSITIVITY_STEPS.length)
    expect(SENSITIVITY_HINTS).toHaveLength(SENSITIVITY_STEPS.length)
    expect(sensitivityIndex(1)).toBe(2)
    expect(sensitivityIndex(0.5)).toBe(0)
    expect(sensitivityIndex(2)).toBe(4)
    expect(sensitivityIndex(1.3)).toBe(3)
    expect(sensitivityIndex(0.7)).toBe(1)
  })
})

describe('nudge thresholds', () => {
  it('reads contiguous stages as "from stage k" and round-trips', () => {
    expect(notifyFrom([true, true, true])).toBe(1)
    expect(notifyFrom([false, true, true])).toBe(2)
    expect(notifyFrom([false, false, true])).toBe(3)
    expect(notifyFrom([false, false, false])).toBe('none')
    expect(notifyFrom([true, false, true])).toBe('custom')
    for (const k of [1, 2, 3] as const) expect(notifyFrom(stagesFrom(k))).toBe(k)
  })
  it('has a preview phrasing for every issue × stage', () => {
    for (const i of ISSUES)
      for (const st of [1, 2, 3] as const) {
        expect(TOAST_PREVIEW[i][st].title).toBeTruthy()
        expect(TOAST_PREVIEW[i][st].body).toBeTruthy()
        expect(TOAST_PREVIEW[i][st].title).not.toMatch(/\{/)
      }
  })
})

describe('reset all settings', () => {
  it('restores defaults but keeps the saved posture and AI connections', () => {
    const patch = resetPatch()
    expect(patch).not.toHaveProperty('calibration')
    expect(patch).not.toHaveProperty('onboarded')
    expect((patch.ai as Record<string, unknown>).connections).toBeUndefined()
    expect(patch.overlay).toEqual(DEFAULT_SETTINGS.overlay)
  })
  it('knows when nothing would change', () => {
    const s = mergeSettings({})
    expect(isAtDefaults(s)).toBe(true)
    expect(isAtDefaults(mergeSettings({ overlay: { meshIntensity: 0.8 } }))).toBe(false)
    expect(isAtDefaults(mergeSettings({ ai: { enabled: true } }))).toBe(false)
    expect(isAtDefaults(mergeSettings({ updates: { autoCheck: false } }))).toBe(false)
    expect(resetPatch().updates).toEqual({ autoCheck: true })
    // a saved posture or onboarding isn't something a reset touches
    expect(isAtDefaults({ ...s, onboarded: true })).toBe(true)
  })
})

describe('data lines', () => {
  it('counts keys and history days', () => {
    expect(keysLine([])).toBe('No keys saved')
    expect(keysLine([{ hasKey: true }, { hasKey: false }])).toBe('1 key, encrypted with Windows')
    expect(keysLine([{ hasKey: true }, { hasKey: true }])).toBe('2 keys, encrypted with Windows')
    expect(historyLine(null)).toBe('—')
    expect(historyLine(0)).toBe('Nothing yet')
    expect(historyLine(1)).toBe('1 day')
    expect(historyLine(12)).toBe('12 days')
  })
})
