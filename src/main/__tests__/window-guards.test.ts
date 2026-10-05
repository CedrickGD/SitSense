import { describe, expect, it } from 'vitest'
import {
  CRASH_WINDOW_MS,
  MIN_WINDOW,
  initialWindowSize,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  MAX_RELOAD_DELAY_MS,
  nextReloadDelay
} from '../window-guards'

describe('isTrustedRendererUrl', () => {
  it('accepts the packaged app:// renderer', () => {
    expect(isTrustedRendererUrl('app://renderer/index.html')).toBe(true)
    expect(isTrustedRendererUrl('app://renderer/')).toBe(true)
  })

  it('accepts the dev server origin only when one is configured', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/#/settings', 'http://localhost:5173/')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/')).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
  })

  it('rejects foreign origins and junk', () => {
    expect(isTrustedRendererUrl('https://evil.example/')).toBe(false)
    expect(isTrustedRendererUrl('app://other/index.html')).toBe(false)
    expect(isTrustedRendererUrl('file:///C:/Windows/win.ini')).toBe(false)
    expect(isTrustedRendererUrl('not a url')).toBe(false)
    expect(isTrustedRendererUrl(undefined)).toBe(false)
    expect(isTrustedRendererUrl('')).toBe(false)
  })
})

describe('isSafeExternalUrl', () => {
  it('only lets https through to the OS shell', () => {
    expect(isSafeExternalUrl('https://github.com/CedrickGD/SitSense')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(false)
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isSafeExternalUrl('ms-settings:privacy-webcam')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('garbage')).toBe(false)
  })
})

describe('nextReloadDelay', () => {
  it('backs off exponentially within the crash window', () => {
    let history: number[] = []
    const delays: number[] = []
    for (let i = 0; i < 9; i++) {
      const r = nextReloadDelay(history, 1_000_000 + i * 1000)
      history = r.history
      delays.push(r.delayMs)
    }
    expect(delays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 32000])
    expect(delays.slice(6)).toEqual([MAX_RELOAD_DELAY_MS, MAX_RELOAD_DELAY_MS, MAX_RELOAD_DELAY_MS])
  })

  it('resets once the renderer has stayed up past the window', () => {
    const r1 = nextReloadDelay([0, 1000, 2000], 3000)
    expect(r1.delayMs).toBe(8000)
    const r2 = nextReloadDelay(r1.history, 3000 + CRASH_WINDOW_MS + 1)
    expect(r2.delayMs).toBe(1000)
    expect(r2.history).toHaveLength(1)
  })
})

describe('initialWindowSize', () => {
  it('opens at 1200x800 when the screen has room', () => {
    expect(initialWindowSize({ width: 1920, height: 1040 })).toEqual({ width: 1200, height: 800 })
  })

  it('shrinks to fit a small work area, never below the minimum', () => {
    expect(initialWindowSize({ width: 1366, height: 728 })).toEqual({ width: 1200, height: 669 })
    expect(initialWindowSize({ width: 1024, height: 600 })).toEqual({ width: 942, height: MIN_WINDOW.height })
    expect(initialWindowSize({ width: 640, height: 480 })).toEqual(MIN_WINDOW)
  })

  it('falls back to the default for a missing or bogus work area', () => {
    expect(initialWindowSize(null)).toEqual({ width: 1200, height: 800 })
    expect(initialWindowSize({ width: NaN, height: 0 })).toEqual({ width: 1200, height: 800 })
  })
})
