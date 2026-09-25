// Build-time asset provisioning. Runs on postinstall (and via `npm run fetch-assets`).
// 1. Copies the MediaPipe WASM runtime out of node_modules into renderer/public
//    (must keep original filenames — FilesetResolver resolves them by name).
// 2. Downloads the pose and face landmarker models once if absent, pinned by
//    SHA-256 so a tampered or truncated download never ships.
// The packaged app never touches the network; these are dev-machine steps only.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const MODELS = [
  {
    name: 'pose_landmarker_lite.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
    why: 'The app cannot detect posture without it.'
  },
  {
    // only drives the face part of the preview's body mesh — never posture
    name: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    why: 'The mesh preview falls back to a coarser face without it.'
  }
]

const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const wasmDest = join(root, 'src/renderer/public/mediapipe/wasm')
const modelDir = join(root, 'src/renderer/public/models')

// FilesetResolver picks the SIMD build, or the no-SIMD one on CPUs without
// SSE4.1 (V8 has no Wasm SIMD there). The ES-module variant is never loaded
// (forVisionTasks is called without useModule) — 12 MB of dead weight.
const WASM_FILES = ['', '_nosimd'].flatMap((v) => [`vision_wasm${v}_internal.js`, `vision_wasm${v}_internal.wasm`])
const UNUSED_WASM = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let ok = true

if (WASM_FILES.every((f) => existsSync(join(wasmSrc, f)))) {
  mkdirSync(wasmDest, { recursive: true })
  for (const f of WASM_FILES) copyFileSync(join(wasmSrc, f), join(wasmDest, f))
  for (const f of UNUSED_WASM) rmSync(join(wasmDest, f), { force: true })
  console.log(`[fetch-assets] wasm runtime copied -> ${wasmDest}`)
} else {
  ok = false
  console.warn('[fetch-assets] @mediapipe/tasks-vision not installed yet — run `npm run fetch-assets` after install')
}

for (const model of MODELS) {
  const dest = join(modelDir, model.name)
  if (existsSync(dest)) {
    if (sha256(readFileSync(dest)) === model.sha256) {
      console.log(`[fetch-assets] ${model.name} already present`)
      continue
    }
    console.warn(`[fetch-assets] ${model.name} doesn't match its pinned hash — downloading it again`)
  }
  try {
    console.log(`[fetch-assets] downloading ${model.name} ...`)
    const res = await fetch(model.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const got = sha256(buf)
    if (got !== model.sha256) throw new Error(`checksum mismatch (got ${got})`)
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
