// Pure helpers for window.ts (no electron import, so they are unit-testable).

/** Packaged renderer origin (see app-protocol.ts). */
export const APP_ORIGIN = 'app://renderer'

/**
 * scheme://host[:port] of a URL. WHATWG URL reports origin 'null' for
 * non-special schemes like app:, so it is assembled by hand.
 */
function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** True for our own renderer: app://renderer, or the dev server origin in dev. */
export function isTrustedRendererUrl(url: string | undefined | null, devUrl?: string): boolean {
  if (!url) return false
  const origin = originOf(url)
  if (!origin) return false
  if (origin === APP_ORIGIN) return true
  if (devUrl) return origin === originOf(devUrl)
  return false
}

/** Only plain https links may be handed to the OS shell (no file:, ms-*, custom protocol handlers). */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

export const CRASH_WINDOW_MS = 5 * 60_000
export const MIN_RELOAD_DELAY_MS = 1_000
export const MAX_RELOAD_DELAY_MS = 60_000

/**
 * Exponential backoff for reloading a crashed renderer: 1 s, 2 s, 4 s … capped
 * at 60 s, based on how many crashes happened within the last 5 minutes. It
 * never gives up — a posture monitor that silently stays dead is the worst case.
 * Returns the delay and the pruned crash history (including this crash).
 */
export function nextReloadDelay(
  crashTimes: readonly number[],
  now: number
): { delayMs: number; history: number[] } {
  const history = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS)
  history.push(now)
  const delayMs = Math.min(MAX_RELOAD_DELAY_MS, MIN_RELOAD_DELAY_MS * 2 ** (history.length - 1))
  return { delayMs, history }
}

export const DEFAULT_WINDOW = { width: 1200, height: 800 } as const
export const MIN_WINDOW = { width: 780, height: 580 } as const

/**
 * The first-open window size: 1200×800, shrunk to ~92 % of the work area on small
 * screens (a 1366×768 laptop gets ~1256×670), never below the minimum size.
 */
export function initialWindowSize(workArea: { width: number; height: number } | null | undefined): { width: number; height: number } {
  const fit = (want: number, avail: number | undefined, min: number): number => {
    if (typeof avail !== 'number' || !Number.isFinite(avail) || avail <= 0) return want
    return Math.max(min, Math.min(want, Math.floor(avail * 0.92)))
  }
  return {
    width: fit(DEFAULT_WINDOW.width, workArea?.width, MIN_WINDOW.width),
    height: fit(DEFAULT_WINDOW.height, workArea?.height, MIN_WINDOW.height)
  }
}
