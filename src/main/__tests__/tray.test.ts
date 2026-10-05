import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostureSnapshot } from '../../shared/posture'

const { trays } = vi.hoisted(() => ({ trays: [] as Array<{ tooltip: string; image: unknown; menu: unknown }> }))

vi.mock('electron', () => {
  class Tray {
    tooltip = ''
    image: unknown
    menu: unknown = null
    constructor(image: unknown) {
      this.image = image
      trays.push(this)
    }
    on(): void {}
    setImage(img: unknown): void {
      this.image = img
    }
    setToolTip(t: string): void {
      this.tooltip = t
    }
    setContextMenu(m: unknown): void {
      this.menu = m
    }
    destroy(): void {}
  }
  return {
    Tray,
    Menu: { buildFromTemplate: (t: unknown) => t },
    nativeImage: {
      createFromPath: (p: string) => ({ path: p }),
      createEmpty: () => ({ path: '' })
    }
  }
})
vi.mock('../resources', () => ({ resourcesDir: () => 'res' }))
vi.mock('../notifications', () => ({ stageLabel: (s: number) => `stage ${s}` }))

import { __resetPauseForTests, setPause } from '../pause'
import { createTray, destroyTray, refreshTray, trayPostureUpdate } from '../tray'

const goodSnapshot = {
  presence: 'present',
  issues: {},
  worstStage: 0,
  calibrated: true,
  recalibrationSuggested: false,
  ts: 0
} as unknown as PostureSnapshot

const noop = (): void => {}
const tooltip = (): string => trays[trays.length - 1].tooltip

describe('tray', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetPauseForTests()
    trays.length = 0
    createTray({
      onOpen: noop,
      onPause: noop,
      onResume: noop,
      onRecalibrate: noop,
      onSettings: noop,
      onQuit: noop
    })
  })
  afterEach(() => {
    destroyTray()
    __resetPauseForTests()
    vi.useRealTimers()
  })

  it('shows live posture', () => {
    trayPostureUpdate(goodSnapshot)
    expect(tooltip()).toBe('SitSense — good posture')
  })

  it('does not show pre-pause posture after resuming (regression)', () => {
    trayPostureUpdate(goodSnapshot)
    setPause(true, null)
    expect(tooltip()).toBe('SitSense — paused')
    setPause(false)
    expect(tooltip()).toBe('SitSense — not detecting')
    // the next real update from the renderer brings it back
    trayPostureUpdate(goodSnapshot)
    expect(tooltip()).toBe('SitSense — good posture')
  })

  it('stops listening for pause changes once destroyed', () => {
    destroyTray()
    expect(() => setPause(true, null)).not.toThrow()
  })

  it('offers "Restart to update" only while an update is ready', () => {
    destroyTray()
    trays.length = 0
    let ready: string | null = null
    const installs: number[] = []
    createTray({
      onOpen: noop,
      onPause: noop,
      onResume: noop,
      onRecalibrate: noop,
      onSettings: noop,
      onQuit: noop,
      updateReady: () => ready,
      onInstallUpdate: () => installs.push(1)
    })
    type Item = { label?: string; click?: () => void }
    const items = (): Item[] => trays[trays.length - 1].menu as Item[]
    expect(items().some((i) => i.label === 'Restart to update')).toBe(false)
    ready = '0.3.0'
    refreshTray()
    const item = items().find((i) => i.label === 'Restart to update')
    expect(item).toBeDefined()
    expect(tooltip()).toContain('update 0.3.0 ready')
    item!.click!()
    expect(installs).toEqual([1])
    ready = null
    refreshTray()
    expect(items().some((i) => i.label === 'Restart to update')).toBe(false)
  })
})
