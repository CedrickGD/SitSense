// Dev-only: renders the body-wireframe previews (meshPreview.ts) in a hidden
// Electron window and writes them as PNGs.
//   node src/renderer/src/overlay/__dev__/run-mesh-preview.mjs <out-dir>
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../../..')
const outDir = resolve(process.argv[2] ?? join(root, 'out', 'mesh-preview'))
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'mesh-preview-'))

await build({
  entryPoints: [join(here, 'meshPreview.ts')],
  bundle: true,
  format: 'iife',
  outfile: join(work, 'preview.js'),
  alias: { '@renderer': join(root, 'src/renderer/src'), '@shared': join(root, 'src/shared') },
  logLevel: 'warning'
})
writeFileSync(join(work, 'index.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><script src="preview.js"></script>')
writeFileSync(
  join(work, 'main.cjs'),
  `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const out = ${JSON.stringify(outDir)}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { offscreen: false } })
  win.webContents.on('console-message', (_e, _l, msg) => console.log(msg))
  await win.loadFile(path.join(__dirname, 'index.html'))
  try {
    const shots = await win.webContents.executeJavaScript('window.renderMeshPreviews()')
    for (const s of shots) {
      fs.writeFileSync(path.join(out, s.name + '.png'), Buffer.from(s.dataUrl.split(',')[1], 'base64'))
      console.log('wrote', s.name + '.png')
    }
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  app.quit()
})
`
)
const electron = createRequire(import.meta.url)('electron')
const r = spawnSync(electron, [join(work, 'main.cjs'), `--user-data-dir=${join(work, 'profile')}`], { stdio: 'inherit' })
process.exit(r.status ?? 1)
