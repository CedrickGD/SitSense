import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../../shared/settings'

const h = vi.hoisted(() => ({ dir: '', failReads: [] as string[] }))

vi.mock('electron', () => ({ app: { getPath: () => h.dir } }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const code = h.failReads.shift()
    if (code) throw Object.assign(new Error(`${code}: resource busy or locked`), { code })
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

import { getSettings, getSettingsLoadIssue, loadSettings, saveNow, settingsLoadedFromDisk, updateSettings } from '../settings-store'

const file = (): string => join(h.dir, 'settings.json')
const backups = (): string[] => readdirSync(h.dir).filter((f) => f.startsWith('settings.json.corrupt-'))
const onDisk = (): string => realFs.readFileSync(file(), 'utf8')

describe('settings-store load/save', () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(() => {
    h.dir = mkdtempSync(join(tmpdir(), 'sitsense-settings-'))
    h.failReads.length = 0
    err.mockClear()
  })
  afterEach(() => {
    saveNow() // clears any debounce timer
    rmSync(h.dir, { recursive: true, force: true })
  })

  it('first run (no file): defaults, no issue, and saving creates the file', () => {
    const s = loadSettings()
    expect(s).toEqual(DEFAULT_SETTINGS)
    expect(settingsLoadedFromDisk()).toBe(false)
    expect(getSettingsLoadIssue()).toBeNull()
    saveNow()
    expect(JSON.parse(onDisk())).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(`${file()}.tmp`)).toBe(false)
    expect(err).not.toHaveBeenCalled()
  })

  it('loads a valid file', () => {
    writeFileSync(file(), JSON.stringify({ onboarded: true, settingsVersion: SETTINGS_VERSION }))
    expect(loadSettings().onboarded).toBe(true)
    expect(settingsLoadedFromDisk()).toBe(true)
    expect(getSettingsLoadIssue()).toBeNull()
  })

  it.each([
    ['a trailing comma', '{"onboarded": true,}'],
    ['a truncated file', '{"onboarded": tr'],
    ['an empty file', ''],
    ['a JSON array', '[1,2]'],
    ['JSON null', 'null']
  ])('keeps a backup of %s before anything is saved', (_n, content) => {
    writeFileSync(file(), content)
    const s = loadSettings()
    expect(s).toEqual(DEFAULT_SETTINGS)
    expect(settingsLoadedFromDisk()).toBe(false)
    const issue = getSettingsLoadIssue()
    expect(issue?.kind).toBe('corrupt')
    const [backup] = backups()
    expect(backup).toBeDefined()
    expect(issue).toMatchObject({ backup: join(h.dir, backup) })
    expect(realFs.readFileSync(join(h.dir, backup), 'utf8')).toBe(content)
    expect(err).toHaveBeenCalled()

    // the app keeps working and saving; the backup is never touched
    updateSettings({ onboarded: true })
    saveNow()
    expect(JSON.parse(onDisk()).onboarded).toBe(true)
    expect(realFs.readFileSync(join(h.dir, backup), 'utf8')).toBe(content)
  })

  it('retries a transient read error once and then loads the real file', () => {
    writeFileSync(file(), JSON.stringify({ onboarded: true }))
    h.failReads.push('EBUSY')
    expect(loadSettings().onboarded).toBe(true)
    expect(settingsLoadedFromDisk()).toBe(true)
    expect(getSettingsLoadIssue()).toBeNull()
    expect(h.failReads).toHaveLength(0)
  })

  it.each(['EBUSY', 'EPERM'])('never overwrites a file that stays unreadable (%s)', (code) => {
    const original = JSON.stringify({ onboarded: true, general: { launchOnStartup: false } })
    writeFileSync(file(), original)
    h.failReads.push(code, code)
    const s = loadSettings()
    expect(s).toEqual(DEFAULT_SETTINGS)
    expect(settingsLoadedFromDisk()).toBe(false)
    expect(getSettingsLoadIssue()).toMatchObject({ kind: 'unreadable', code })

    updateSettings({ resolvedDelegate: 'GPU' })
    saveNow()
    saveNow()
    expect(onDisk()).toBe(original)
    expect(backups()).toEqual([])
    // in-memory changes still apply for this session
    expect(getSettings().resolvedDelegate).toBe('GPU')
  })

  it('resumes saving once the unreadable file is gone', () => {
    writeFileSync(file(), '{}')
    h.failReads.push('EPERM', 'EPERM')
    loadSettings()
    rmSync(file())
    updateSettings({ onboarded: true })
    saveNow()
    expect(JSON.parse(onDisk()).onboarded).toBe(true)
  })

  it('loads a hand edit saved with a UTF-8 BOM instead of treating it as corrupt', () => {
    writeFileSync(file(), '\uFEFF' + JSON.stringify({ onboarded: true }))
    expect(loadSettings().onboarded).toBe(true)
    expect(settingsLoadedFromDisk()).toBe(true)
    expect(getSettingsLoadIssue()).toBeNull()
    expect(backups()).toEqual([])
  })

  it('a file written by a defaults session after a corrupt load is not authoritative while the backup exists', () => {
    // launch 1: corrupt file is quarantined, defaults load, quit writes defaults
    writeFileSync(file(), '{"ai": {"connections": [{"id": "c1"}]},')
    loadSettings()
    expect(settingsLoadedFromDisk()).toBe(false)
    saveNow()
    // launch 2: the defaults file parses cleanly, but the backup still holds the
    // real connections, so key pruning (gated on this flag) must not run
    loadSettings()
    expect(getSettingsLoadIssue()).toBeNull()
    expect(settingsLoadedFromDisk()).toBe(false)
    // once the user restores or deletes the backup, a clean load counts again
    for (const b of backups()) rmSync(join(h.dir, b))
    loadSettings()
    expect(settingsLoadedFromDisk()).toBe(true)
  })

  it('a later clean load clears the previous issue', () => {
    writeFileSync(file(), '{oops')
    loadSettings()
    expect(getSettingsLoadIssue()?.kind).toBe('corrupt')
    writeFileSync(file(), '{}')
    loadSettings()
    expect(getSettingsLoadIssue()).toBeNull()
  })
})

