import { describe, expect, it } from 'vitest'
import type { UpdateState, UpdateStatus } from '@shared/update'
import { updateCheckLine } from '../meta'
import { UPDATE_PRIVACY_NOTE, shortVersion, updateCardView } from '../update-view'

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
const status = (state: UpdateState, extra: Partial<UpdateStatus> = {}): UpdateStatus => ({
  currentVersion: '0.2.0',
  mode: 'installed',
  state,
  lastCheckedAt: null,
  ...extra
})

describe('update card', () => {
  it('idle: offers a check and says when it happens by itself', () => {
    const v = updateCardView(status({ kind: 'idle' }), true, NOW)
    expect(v.title).toBe('Not checked yet')
    expect(v.action).toEqual({ kind: 'check', label: 'Check for updates' })
    expect(updateCardView(status({ kind: 'idle' }), false, NOW).sub).toBe('Automatic checks are off.')
  })

  it('checking: a spinner and a busy button', () => {
    const v = updateCardView(status({ kind: 'checking' }), true, NOW)
    expect(v.icon).toBe('spinner')
    expect(v.action).toMatchObject({ kind: 'check', loading: true })
  })

  it('up to date: names the version and when it was checked', () => {
    const v = updateCardView(status({ kind: 'up-to-date' }, { lastCheckedAt: NOW - 5 * 60_000 }), true, NOW)
    expect(v.title).toBe('You’re up to date')
    expect(v.sub).toBe('SitSense 0.2.0 is the latest version. Checked 5 min ago.')
    expect(v.tone).toBe('sage')
  })

  it('available (portable): Download opens the release page', () => {
    const v = updateCardView(status({ kind: 'available', version: '0.3.0', notes: null, portable: true }, { mode: 'portable' }), true, NOW)
    expect(v.title).toBe('Version 0.3.0 is available')
    expect(v.sub).toBe('You have 0.2.0.')
    expect(v.action).toEqual({ kind: 'download', label: 'Download', external: true })
  })

  it('available (installed): downloads in the app; shows release notes', () => {
    const v = updateCardView(status({ kind: 'available', version: '0.3.0', notes: 'Better nudges', portable: false }), true, NOW)
    expect(v.sub).toBe('Better nudges')
    expect(v.action).toEqual({ kind: 'download', label: 'Download update', external: false })
  })

  it('downloading: progress', () => {
    const v = updateCardView(status({ kind: 'downloading', version: '0.3.0', percent: 42 }), true, NOW)
    expect(v.progress).toBe(42)
    expect(v.title).toBe('Downloading version 0.3.0')
  })

  it('ready: Restart to update', () => {
    const v = updateCardView(status({ kind: 'ready', version: '0.3.0' }), true, NOW)
    expect(v.title).toBe('Version 0.3.0 is ready')
    expect(v.action).toEqual({ kind: 'install', label: 'Restart to update' })
  })

  it('error: the friendly message and Try again', () => {
    const v = updateCardView(status({ kind: 'error', message: 'Couldn’t reach GitHub.' }), true, NOW)
    expect(v.tone).toBe('coral')
    expect(v.sub).toBe('Couldn’t reach GitHub.')
    expect(v.action).toEqual({ kind: 'check', label: 'Try again' })
  })

  it('dev build and unknown status: the button is disabled', () => {
    expect(updateCardView(status({ kind: 'idle' }, { mode: 'dev' }), true, NOW).action).toMatchObject({ disabled: true })
    expect(updateCardView(null, true, NOW).action).toMatchObject({ disabled: true })
  })

  it('copy', () => {
    expect(UPDATE_PRIVACY_NOTE).toBe('Asks GitHub for the latest version — no posture data is sent.')
    expect(shortVersion('0.2.0')).toBe('v0.2.0')
    expect(shortVersion('')).toBe('')
    expect(updateCheckLine(true)).toMatch(/every 6 hours/)
    expect(updateCheckLine(false)).toMatch(/only when you press/)
  })
})
