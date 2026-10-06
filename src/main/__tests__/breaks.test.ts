import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostureSnapshot } from '../../shared/posture'

const h = vi.hoisted(() => ({
  shown: [] as { title: string; body: string }[],
  settings: {
    breaks: { enabled: true, intervalMinutes: 20 },
    notifications: { sound: false },
    calibration: null as unknown
  },
  breaks: 0
}))

vi.mock('electron', () => ({
  Notification: class {
    static isSupported = (): boolean => true
    constructor(private readonly o: { title: string; body: string }) {}
    on(): void {}
    close(): void {}
    show(): void {
      h.shown.push({ title: this.o.title, body: this.o.body })
    }
  }
}))
vi.mock('../settings-store', () => ({ getSettings: () => h.settings }))
vi.mock('../stats', () => ({ getBreaksToday: () => h.breaks, statsRecordBreak: () => h.breaks++ }))
vi.mock('../window', () => ({ sendToRenderer: () => {}, showMainWindow: () => {} }))
vi.mock('../resources', () => ({ resourcesDir: () => 'Z:/nonexistent' }))

import { BREAK_MIN_MS } from '../break-tracker'

const sitting: PostureSnapshot = {
  presence: 'active',
  issues: {} as never,
  worstStage: 0,
  calibrated: false,
  recalibrationSuggested: false,
  ts: 0
}

type BreaksModule = typeof import('../breaks')

async function freshBreaks(): Promise<BreaksModule> {
  vi.resetModules()
  const m = await import('../breaks')
  m.initBreaks()
  return m
}

/** sit at the desk for `minutes`, with a fresh snapshot every 5 s like the renderer sends */
function sit(m: BreaksModule, minutes: number): void {
  for (let t = 0; t < minutes * 60_000; t += 5_000) {
    m.breaksPostureUpdate({ ...sitting, ts: Date.now() })
    vi.advanceTimersByTime(5_000)
  }
}

describe('stand-up reminders (main/breaks.ts)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.shown = []
    h.breaks = 0
    h.settings.calibration = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the toast names the same break length the tracker needs', async () => {
    const { reminderCopy } = await import('../breaks')
    const body = reminderCopy(50).body
    expect(body).toContain('50 min')
    expect(body).toContain(`${BREAK_MIN_MS / 60_000} minutes`)
    expect(body).not.toMatch(/2-minute/)
  })

  it('no reminder, stretch or break before posture setup (ui-v3 §6)', async () => {
    const m = await freshBreaks()
    sit(m, 25)
    expect(h.shown).toEqual([])
    expect(m.getSittingState().sittingSince).toBeNull()
    vi.advanceTimersByTime(10 * 60_000)
    expect(h.breaks).toBe(0)
    m.stopBreaks()
  })

  it('reminds after setup even when the snapshot is uncalibrated (camera switched)', async () => {
    h.settings.calibration = { version: 2 }
    const m = await freshBreaks()
    sit(m, 21)
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0].title).toBe('Time to stand up')
    m.stopBreaks()
  })

  it('saving the baseline takes effect at once, not on the next tick', async () => {
    const m = await freshBreaks()
    m.breaksPostureUpdate({ ...sitting, ts: Date.now() })
    expect(m.getSittingState().sittingSince).toBeNull()
    h.settings.calibration = { version: 2 }
    m.breaksSettingsChanged()
    expect(m.getSittingState().sittingSince).toBe(Date.now())
    m.stopBreaks()
  })
})
