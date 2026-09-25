import { app, session } from 'electron'

/** The Vite dev server a development build loads from; packaged builds: none, ever. */
export function devServerUrl(): URL | null {
  const raw = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  if (!raw) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * "Nothing leaves this machine", enforced in the main process as well as by
 * the page CSP:
 * - Chromium downloads Hunspell dictionaries from Google on startup unless
 *   spellchecking is given no languages (the app has no text input anyway).
 * - Every http(s)/ws(s) request is cancelled — including MediaPipe's usage
 *   telemetry, which it POSTs every minute — except the dev server in
 *   development. The app itself is served over app:// and needs no network.
 */
export function lockDownNetwork(): void {
  const ses = session.defaultSession
  try {
    ses.setSpellCheckerLanguages([])
  } catch {
    // not supported on this platform — nothing to download there either
  }
  const dev = devServerUrl()
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    let allowed = false
    if (dev) {
      try {
        allowed = new URL(details.url).host === dev.host
      } catch {
        allowed = false
      }
    }
    if (!allowed) console.warn('[privacy] blocked outbound request:', details.url)
    callback({ cancel: !allowed })
  })
}
