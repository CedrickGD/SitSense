import { beforeEach, describe, expect, it, vi } from 'vitest'

const { app } = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => 'C:\\Users\\u\\AppData\\Roaming\\sitsense'),
    setPath: vi.fn()
  }
}))
vi.mock('electron', () => ({ app }))

describe('dev-profile', () => {
  beforeEach(() => {
    vi.resetModules()
    app.setPath.mockClear()
  })

  it('moves an unpackaged run to its own userData folder', async () => {
    app.isPackaged = false
    await import('../dev-profile')
    expect(app.setPath).toHaveBeenCalledWith('userData', 'C:\\Users\\u\\AppData\\Roaming\\sitsense-dev')
  })

  it('leaves the packaged app on its real profile', async () => {
    app.isPackaged = true
    await import('../dev-profile')
    expect(app.setPath).not.toHaveBeenCalled()
  })

  it('is idempotent', async () => {
    const { devUserDataPath } = await import('../dev-profile')
    expect(devUserDataPath('X\\sitsense-dev')).toBe('X\\sitsense-dev')
  })
})
