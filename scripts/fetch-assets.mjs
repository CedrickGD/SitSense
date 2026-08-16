// Build-time asset provisioning. Runs on postinstall (and via `npm run fetch-assets`).
// 1. Copies the MediaPipe WASM fileset out of node_modules into renderer/public
//    (must keep original filenames — FilesetResolver resolves them by name).
// 2. Downloads the pose_landmarker_lite model once if absent.
// The packaged app never touches the network; these are dev-machine steps only.
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const wasmDest = join(root, 'src/renderer/public/mediapipe/wasm')
const modelDest = join(root, 'src/renderer/public/models/pose_landmarker_lite.task')

let ok = true

if (existsSync(wasmSrc)) {
  mkdirSync(wasmDest, { recursive: true })
  cpSync(wasmSrc, wasmDest, { recursive: true })
  console.log(`[fetch-assets] wasm fileset copied -> ${wasmDest}`)
} else {
  ok = false
  console.warn('[fetch-assets] @mediapipe/tasks-vision not installed yet — run `npm run fetch-assets` after install')
}

if (existsSync(modelDest) && statSync(modelDest).size > 1_000_000) {
  console.log('[fetch-assets] pose model already present')
} else {
  try {
    console.log('[fetch-assets] downloading pose_landmarker_lite.task ...')
    const res = await fetch(MODEL_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1_000_000) throw new Error(`suspiciously small download (${buf.length} bytes)`)
    mkdirSync(dirname(modelDest), { recursive: true })
    writeFileSync(modelDest, buf)
    console.log(`[fetch-assets] model saved (${(buf.length / 1e6).toFixed(1)} MB) -> ${modelDest}`)
  } catch (err) {
    ok = false
    console.warn(`[fetch-assets] model download failed (${err.message}).`)
    console.warn('[fetch-assets] The app cannot detect posture without it. Re-run: npm run fetch-assets')
  }
}

process.exit(ok ? 0 : 0) // never fail the install; warnings above tell the dev what to do
