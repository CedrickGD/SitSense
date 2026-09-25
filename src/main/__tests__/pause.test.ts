import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'sitsense-pause-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

type PauseModule = typeof import('../pause')
let pause: PauseModule

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-25T09:00:00Z'))
  vi.resetModules()
  pause = await import('../pause')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pause and the lock screen', () => {
  it('locking pauses and unlocking resumes', () => {
    pause.pauseForLock()
    expect(pause.getPauseState().paused).toBe(true)
    pause.resumeAfterUnlock()
    expect(pause.getPauseState().paused).toBe(false)
  })

  it('unlocking keeps a pause the user chose', () => {
    pause.setPause(true, null)
    pause.pauseForLock()
    pause.resumeAfterUnlock()
    expect(pause.getPauseState()).toEqual({ paused: true, resumeAt: null })
  })

  it('a timed pause running out behind the lock screen leaves the camera off until unlock', () => {
    pause.setPause(true, 30)
    pause.pauseForLock()
    vi.advanceTimersByTime(31 * 60_000) // the resume timer fires while locked
    expect(pause.getPauseState()).toEqual({ paused: true, resumeAt: null })
    pause.resumeAfterUnlock()
    expect(pause.getPauseState().paused).toBe(false)
  })

  it('a timed pause still ends on time when the session is unlocked', () => {
    pause.setPause(true, 15)
    vi.advanceTimersByTime(15 * 60_000 + 1)
    expect(pause.getPauseState().paused).toBe(false)
  })
})
