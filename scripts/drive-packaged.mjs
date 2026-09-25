// Verifies the PACKAGED build (asar, app.isPackaged=true): MediaPipe must load
// offline via app:// and the tray icons must resolve from app.asar.unpacked.
// The shipped binary's fuses disable --inspect, so Playwright's _electron
// can't attach; the renderer is driven over Chromium's DevTools port instead.
// Usage: node scripts/drive-packaged.mjs <screenshot-dir> [path-to-exe] [extra app switches…]
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const shotDir = process.argv[2] ?? 'screenshots'
const exe = process.argv[3] ?? 'dist/win-unpacked/SitSense.exe'
const extraArgs = process.argv.slice(4)
const PORT = 9333
mkdirSync(shotDir, { recursive: true })

const app = spawn(exe, [`--remote-debugging-port=${PORT}`, ...extraArgs], { stdio: 'inherit' })

let browser
for (let i = 0; i < 60 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 500))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => undefined)
}
if (!browser) {
  app.kill()
  throw new Error('the packaged app never opened its DevTools port')
}
const context = browser.contexts()[0]
const page = context.pages()[0] ?? (await context.waitForEvent('page'))
const lines = []
page.on('console', (msg) => lines.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', (err) => lines.push(`[pageerror] ${err.message}`))

await page.waitForSelector('#root', { timeout: 15000 })
await page.waitForTimeout(5000)
await page.screenshot({ path: join(shotDir, 'packaged.png') })

console.log('=== console ===')
console.log(lines.join('\n') || '(none)')
await browser.close().catch(() => undefined)
app.kill()
