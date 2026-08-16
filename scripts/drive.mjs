// Dev-only driver: launches the BUILT app (out/main/index.js → app:// protocol,
// the packaged-offline code path) under Playwright and walks the main screens.
// Usage: node scripts/drive.mjs <screenshot-dir>
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron } from 'playwright'

const shotDir = process.argv[2] ?? 'screenshots'
mkdirSync(shotDir, { recursive: true })
const shot = (page, name) => page.screenshot({ path: join(shotDir, name) })

const app = await _electron.launch({ args: ['out/main/index.js'] })
const page = await app.firstWindow()

const consoleLines = []
page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`))

await page.waitForSelector('#root', { timeout: 15000 })
await page.waitForTimeout(4000) // camera + landmarker init
await shot(page, '01-first-launch.png')

const nav = page.locator('nav')

// nav rail: dashboard
await nav.getByRole('button', { name: 'Dashboard' }).click()
await page.waitForTimeout(1500)
await shot(page, '02-dashboard.png')

// settings
await nav.getByRole('button', { name: 'Settings' }).click()
await page.waitForTimeout(800)
await shot(page, '03-settings.png')

// fire a real Windows toast
const testButton = page.getByRole('button', { name: 'Send test' })
if (await testButton.count()) {
  await testButton.click()
  await page.waitForTimeout(1200)
}

// calibration wizard
await nav.getByRole('button', { name: 'Calibrate' }).click()
await page.waitForTimeout(2000)
await shot(page, '04-wizard.png')

const status = await page.evaluate(() => ({
  hasApi: typeof window.sitsense === 'object',
  bodyText: document.body.innerText.slice(0, 600)
}))

console.log('=== driver result ===')
console.log(JSON.stringify(status, null, 2))
console.log('=== console output ===')
console.log(consoleLines.join('\n') || '(no console messages)')

await app.close()
