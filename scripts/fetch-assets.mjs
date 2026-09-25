// Build-time asset provisioning. Runs on postinstall (and via `npm run fetch-assets`).
// 1. Copies the MediaPipe WASM fileset out of node_modules into renderer/public
//    (must keep original filenames — FilesetResolver resolves them by name).
// 2. Downloads the pose and face landmarker models once if absent.
// The packaged app never touches the network; these are dev-machine steps only.
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const MODELS = [
  {
    name: 'pose_landmarker_lite.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    why: 'The app cannot detect posture without it.'
  },
  {
    // only drives the face part of the preview's body mesh — never posture
    name: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    why: 'The mesh preview falls back to a coarser face without it.'
  }
]

const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const wasmDest = join(root, 'src/renderer/public/mediapipe/wasm')
const modelDir = join(root, 'src/renderer/public/models')

let ok = true

if (existsSync(wasmSrc)) {
  mkdirSync(wasmDest, { recursive: true })
  cpSync(wasmSrc, wasmDest, { recursive: true })
  console.log(`[fetch-assets] wasm fileset copied -> ${wasmDest}`)
} else {
  ok = false
  console.warn('[fetch-assets] @mediapipe/tasks-vision not installed yet — run `npm run fetch-assets` after install')
}

for (const model of MODELS) {
  const dest = join(modelDir, model.name)
  if (existsSync(dest) && statSync(dest).size > 1_000_000) {
    console.log(`[fetch-assets] ${model.name} already present`)
    continue
  }
  try {
    console.log(`[fetch-assets] downloading ${model.name} ...`)
    const res = await fetch(model.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1_000_000) throw new Error(`suspiciously small download (${buf.length} bytes)`)
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(dest, buf)
    console.log(`[fetch-assets] model saved (${(buf.length / 1e6).toFixed(1)} MB) -> ${dest}`)
  } catch (err) {
    ok = false
    console.warn(`[fetch-assets] ${model.name} download failed (${err.message}).`)
    console.warn(`[fetch-assets] ${model.why} Re-run: npm run fetch-assets`)
  }
}

// postinstall stays lenient (warnings only), but `--strict` (used by the dist
// scripts) fails hard — an installer without wasm/model would ship a dead app
process.exit(ok || !process.argv.includes('--strict') ? 0 : 1)
