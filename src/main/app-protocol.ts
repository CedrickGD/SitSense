import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'

/**
 * The packaged renderer is served over app://renderer/ instead of file://.
 * MediaPipe loads its wasm binary and the pose model via fetch(), which
 * Chromium rejects for file: URLs — a privileged standard scheme fixes that
 * and keeps the app fully offline. See docs/specs/architecture.md §3.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** Call after app.whenReady(). */
export function handleAppProtocol(): void {
  const rendererRoot = normalize(join(__dirname, '../renderer'))
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || pathname === '') pathname = '/index.html'
    const file = normalize(join(rendererRoot, pathname))
    if (file !== rendererRoot && !file.startsWith(rendererRoot + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}
