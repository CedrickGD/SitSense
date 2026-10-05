// Verifies the PACKAGED build (asar, app.isPackaged=true): MediaPipe must load
// offline via app:// and the tray icons must resolve from app.asar.unpacked.
// Usage: node scripts/drive-packaged.mjs [screenshot-dir]
// Screenshots contain the live webcam preview, so they default to a temp dir
// outside the repo (never commit them).
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'

const shotDir = process.argv[2] ?? join(tmpdir(), 'sitsense-screenshots')
mkdirSync(shotDir, { recursive: true })
console.log(`[drive-packaged] screenshots -> ${shotDir}`)

const app = await _electron.launch({
  executablePath: 'dist/win-unpacked/SitSense.exe',
  args: []
})
const page = await app.firstWindow()
const lines = []
page.on('console', (msg) => lines.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', (err) => lines.push(`[pageerror] ${err.message}`))

await page.waitForSelector('#root', { timeout: 15000 })
await page.waitForTimeout(5000)
await page.screenshot({ path: join(shotDir, 'packaged.png') })

console.log('=== console ===')
console.log(lines.join('\n') || '(none)')
await app.close()
