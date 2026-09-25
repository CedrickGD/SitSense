import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ISSUES, type PostureSnapshot, type StatMinute } from '../../shared/posture'
import { readJson, writeJsonAtomic } from '../json-file'
import { upsertMinute } from '../minute-log'
import { isDetectionStatus, isPauseRequest, isPostureAlert, isPostureSnapshot } from '../validate'

const snapshot = (): PostureSnapshot => ({
  presence: 'active',
  worstStage: 1,
  calibrated: true,
  recalibrationSuggested: false,
  ts: 1,
  issues: Object.fromEntries(
    ISSUES.map((id) => [id, { issue: id, stage: id === 'sink' ? 1 : 0, activeForMs: id === 'sink' ? 5000 : null, metric: 0 }])
  ) as PostureSnapshot['issues']
})

describe('IPC payload validation', () => {
  it('accepts what the renderer really sends', () => {
    expect(isPostureSnapshot(snapshot())).toBe(true)
    expect(isPostureAlert({ issue: 'lean', stage: 2, kind: 'initial', durationMs: 12_000, direction: 'left' })).toBe(true)
    expect(isDetectionStatus({ running: true, delegate: 'GPU', targetFps: 10, measuredFps: 9, cameraError: null })).toBe(true)
    expect(isPauseRequest(true, 15)).toBe(true)
    expect(isPauseRequest(true, null)).toBe(true)
    expect(isPauseRequest(false, undefined)).toBe(true)
  })

  it('rejects malformed snapshots that would crash main-process timers', () => {
    expect(isPostureSnapshot({ ...snapshot(), issues: {} })).toBe(false)
    expect(isPostureSnapshot({ ...snapshot(), worstStage: 7 })).toBe(false)
    expect(isPostureSnapshot({ ...snapshot(), presence: 'gone' })).toBe(false)
    expect(isPostureSnapshot(null)).toBe(false)
    const bad = snapshot()
    ;(bad.issues.sink as { activeForMs: unknown }).activeForMs = 'long'
    expect(isPostureSnapshot(bad)).toBe(false)
  })

  it('rejects odd alerts and pause requests', () => {
    expect(isPostureAlert({ issue: 'nap', stage: 2, kind: 'initial', durationMs: 1 })).toBe(false)
    expect(isPostureAlert({ issue: 'sink', stage: 2, kind: 'initial', durationMs: Infinity })).toBe(false)
    expect(isPostureAlert({ issue: 'sink', stage: 2, kind: 'initial', durationMs: 1, direction: 'up' })).toBe(false)
    expect(isPauseRequest('yes', 15)).toBe(false)
    expect(isPauseRequest(true, 50_000)).toBe(false) // setTimeout would clamp to 1 ms
    expect(isPauseRequest(true, 0.5)).toBe(false)
    expect(isDetectionStatus({ running: true, delegate: 'TPU', cameraError: null })).toBe(false)
  })
})

describe('upsertMinute', () => {
  const m = (min: number, s: StatMinute['s'] = 'good'): StatMinute => ({ m: min, s })

  it('appends in order and replaces a repeated minute', () => {
    const list = [m(1), m(2)]
    upsertMinute(list, m(3))
    upsertMinute(list, m(3, 'away'))
    expect(list).toEqual([m(1), m(2), m(3, 'away')])
  })

  it('keeps the log strictly increasing when the clock steps back', () => {
    const list = [m(10), m(20), m(30)]
    upsertMinute(list, m(15, 'away'))
    upsertMinute(list, m(20, 'paused'))
    expect(list.map((x) => x.m)).toEqual([10, 15, 20, 30])
    expect(list[2].s).toBe('paused')
  })
})

describe('crash-safe JSON files', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'sitsense-json-'))

  it('round-trips and keeps the previous version as .bak', () => {
    const d = dir()
    const file = join(d, 'settings.json')
    writeJsonAtomic(file, { v: 1 }, { backup: true })
    writeJsonAtomic(file, { v: 2 }, { backup: true })
    expect(readJson(file)).toEqual({ v: 2 })
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ v: 1 })
    expect(readdirSync(d).some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('returns null for a missing file', () => {
    expect(readJson(join(dir(), 'nope.json'))).toBeNull()
  })

  it('sets a corrupt file aside and falls back to the backup instead of losing it', () => {
    const d = dir()
    const file = join(d, 'settings.json')
    writeJsonAtomic(file, { v: 1 }, { backup: true })
    writeJsonAtomic(file, { v: 2 }, { backup: true })
    writeFileSync(file, '{"v": 3,') // hand edit gone wrong / torn write
    expect(readJson(file)).toEqual({ v: 1 })
    const corrupt = readdirSync(d).find((f) => f.startsWith('settings.json.corrupt-'))
    expect(corrupt).toBeDefined()
    expect(readFileSync(join(d, corrupt!), 'utf8')).toBe('{"v": 3,')
  })
})
