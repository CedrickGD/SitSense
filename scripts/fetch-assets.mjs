// Build-time asset provisioning. Runs on postinstall (and via `npm run fetch-assets`).
// 1. Copies the MediaPipe WASM fileset out of node_modules into renderer/public
//    (must keep original filenames — FilesetResolver resolves them by name).
// 2. Downloads the pose and face landmarker models once if absent.
// The packaged app never touches the network; these are dev-machine steps only.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// FilesetResolver.forVisionTasks(base) (no useModule flag) only ever loads the
// classic-script variants: vision_wasm_internal (SIMD) or, on CPUs without
// SIMD, vision_wasm_nosimd_internal. The ES-module variant
// (vision_wasm_module_internal, ~12 MB) is never loaded — don't ship it.
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm'
]

if (existsSync(wasmSrc)) {
  mkdirSync(wasmDest, { recursive: true })
  // drop anything a previous (copy-everything) run left behind
  for (const name of readdirSync(wasmDest)) {
    if (!WASM_FILES.includes(name)) rmSync(join(wasmDest, name), { recursive: true, force: true })
  }
  for (const name of WASM_FILES) {
    const from = join(wasmSrc, name)
    if (existsSync(from)) {
      cpSync(from, join(wasmDest, name))
    } else {
      ok = false
      console.warn(`[fetch-assets] ${name} missing from @mediapipe/tasks-vision — wasm fileset incomplete`)
    }
  }
  console.log(`[fetch-assets] wasm fileset copied (${WASM_FILES.length} files) -> ${wasmDest}`)
} else {
  ok = false
  console.warn('[fetch-assets] @mediapipe/tasks-vision not installed yet — run `npm run fetch-assets` after install')
}

// A .task model is a zip bundle: the local-file header (PK\3\4) sits at the
// start and the 22-byte end-of-central-directory record (PK\5\6) within the
// last 22 + 65535 (max comment) bytes, ending exactly at end of file, with the
// central directory it points to lying before it. A truncated download still
// starts with PK\3\4 but fails the EOCD test; an HTML error page fails both.
// Either would ship a model the packaged, offline app could never recover
// from. scripts/verify-package.mjs applies the same rule to the packaged copy.
const ZIP_LOCAL = Buffer.from('PK\x03\x04', 'latin1')
const ZIP_EOCD = Buffer.from('PK\x05\x06', 'latin1')
function hasZipEnd(buf) {
  const from = Math.max(0, buf.length - 65557)
  for (let p = buf.lastIndexOf(ZIP_EOCD); p >= from; p = p > 0 ? buf.lastIndexOf(ZIP_EOCD, p - 1) : -1) {
    if (p + 22 > buf.length) continue
    const cdSize = buf.readUInt32LE(p + 12)
    const cdOffset = buf.readUInt32LE(p + 16)
    if (p + 22 + buf.readUInt16LE(p + 20) === buf.length && cdOffset + cdSize <= p) return true
  }
  return false
}
const isTaskBundle = (buf) => buf.length > 1_000_000 && buf.subarray(0, 64).indexOf(ZIP_LOCAL) >= 0 && hasZipEnd(buf)

for (const model of MODELS) {
  const dest = join(modelDir, model.name)
  if (existsSync(dest) && statSync(dest).size > 1_000_000 && isTaskBundle(readFileSync(dest))) {
    console.log(`[fetch-assets] ${model.name} already present`)
    continue
  }
  try {
    console.log(`[fetch-assets] downloading ${model.name} ...`)
    const res = await fetch(model.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1_000_000) throw new Error(`suspiciously small download (${buf.length} bytes)`)
    if (!isTaskBundle(buf)) throw new Error('download is not a complete .task (zip) bundle (missing zip header or end-of-central-directory)')
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
