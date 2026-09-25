import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Crash-safe JSON persistence for userData files.
 *
 * Writes go to a temp file that is fsynced before the rename, so a power cut
 * can't leave a half-written or NUL-filled file behind. With `backup`, the
 * previous good version is kept as `<file>.bak`.
 */
export function writeJsonAtomic(file: string, value: unknown, options: { backup?: boolean } = {}): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (options.backup && existsSync(file)) copyFileSync(file, `${file}.bak`)
  renameSync(tmp, file)
}

/**
 * Reads a JSON file, falling back to `<file>.bak`. Returns null when there is
 * nothing usable. A file that exists but doesn't parse is renamed to
 * `<file>.corrupt-<time>` instead of being silently overwritten by the next
 * save, so a hand edit gone wrong (or a crash) never destroys the only copy.
 */
export function readJson(file: string): unknown {
  for (const candidate of [file, `${file}.bak`]) {
    let text: string
    try {
      text = readFileSync(candidate, 'utf8')
    } catch {
      continue // missing or unreadable — try the next candidate
    }
    try {
      return JSON.parse(text)
    } catch (err) {
      console.error(`[storage] ${candidate} is not valid JSON:`, err)
      if (candidate === file) {
        try {
          renameSync(file, `${file}.corrupt-${Date.now()}`)
        } catch {
          // best effort — the fallback below still applies
        }
      }
    }
  }
  return null
}
