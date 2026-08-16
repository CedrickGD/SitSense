// Generates the tray ICOs (resources/tray/*.ico) and the app icon (build/icon.ico)
// with zero dependencies: shapes are rasterized via signed-distance fields and
// wrapped as PNG-compressed ICO entries (supported since Vista).
// The 3-segment "spine" glyph encodes posture state by SHAPE as well as color,
// so the tray stays readable for colorblind users. See docs/specs/ui.md §6.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// ---------- palette ----------
const INK = [0x17, 0x15, 0x12]
const BADGE = [0x25, 0x21, 0x19]
const HAIRLINE = [0x4a, 0x44, 0x3a]
const SAGE = [0x93, 0xc9, 0xa2]
const AMBER = [0xe5, 0xb9, 0x6b]
const CORAL = [0xe0, 0x65, 0x5c]
const SLATE = [0x8f, 0xa3, 0xb8]
const FAINT = [0x8a, 0x83, 0x76]
const TEXT = [0xed, 0xe7, 0xdc]

// ---------- tiny PNG encoder ----------
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
function encodeIco(images /* [{size, png}] */) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

// ---------- SDF rasterizer ----------
const clamp01 = (v) => Math.max(0, Math.min(1, v))
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1))
  const dx = px - (ax + abx * t)
  const dy = py - (ay + aby * t)
  return Math.hypot(dx, dy)
}
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

// shape: {kind:'capsule'|'capsuleOutline'|'roundRect'|'roundRectOutline', color, alpha?, ...geometry}
function raster(size, shapes) {
  const img = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size
      const py = (y + 0.5) / size
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (const s of shapes) {
        let d
        if (s.kind === 'capsule' || s.kind === 'capsuleOutline') {
          d = segDist(px, py, s.ax, s.ay, s.bx, s.by) - s.r
          if (s.kind === 'capsuleOutline') d = Math.abs(d + s.stroke / 2) - s.stroke / 2
        } else {
          d = roundRectDist(px, py, s.cx, s.cy, s.hw, s.hh, s.rr)
          if (s.kind === 'roundRectOutline') d = Math.abs(d + s.stroke / 2) - s.stroke / 2
        }
        const aa = 0.7 / size
        const cov = clamp01(0.5 - d / aa) * (s.alpha ?? 1)
        if (cov <= 0) continue
        const [sr, sg, sb] = s.color
        // source-over compositing
        r = sr * cov + r * (1 - cov)
        g = sg * cov + g * (1 - cov)
        b = sb * cov + b * (1 - cov)
        a = cov + a * (1 - cov)
      }
      const i = (y * size + x) * 4
      img[i] = r
      img[i + 1] = g
      img[i + 2] = b
      img[i + 3] = a * 255
    }
  }
  return img
}

// ---------- spine glyph geometry ----------
// three vertical capsules; xs = center offsets per segment (top → bottom)
function spineShapes(xs, color, { outline = false, segR = 0.085, segLen = 0.1 } = {}) {
  const ys = [0.3, 0.52, 0.74]
  return ys.map((cy, i) => {
    const cx = xs[i]
    const base = { ax: cx, ay: cy - segLen / 2, bx: cx, by: cy - segLen / 2 + segLen, r: segR, color }
    return outline ? { kind: 'capsuleOutline', ...base, stroke: 0.05 } : { kind: 'capsule', ...base }
  })
}

const badge = (bg = BADGE) => [
  { kind: 'roundRect', cx: 0.5, cy: 0.5, hw: 0.44, hh: 0.44, rr: 0.24, color: bg },
  { kind: 'roundRectOutline', cx: 0.5, cy: 0.5, hw: 0.44, hh: 0.44, rr: 0.24, stroke: 0.045, color: HAIRLINE, alpha: 0.9 }
]

const STRAIGHT = [0.5, 0.5, 0.5]
const CURVED = [0.575, 0.49, 0.445]
const STRONG = [0.635, 0.47, 0.405]

const TRAY_STATES = {
  'tray-good': [...badge(), ...spineShapes(STRAIGHT, SAGE)],
  'tray-warn': [...badge(), ...spineShapes(CURVED, AMBER)],
  'tray-bad': [...badge(), ...spineShapes(STRONG, CORAL)],
  'tray-paused': [
    ...badge(),
    ...spineShapes(STRAIGHT, SLATE),
    // pause bars, bottom-right, on a small dark plate for contrast
    { kind: 'roundRect', cx: 0.76, cy: 0.76, hw: 0.17, hh: 0.17, rr: 0.08, color: INK },
    { kind: 'capsule', ax: 0.7, ay: 0.68, bx: 0.7, by: 0.84, r: 0.035, color: TEXT },
    { kind: 'capsule', ax: 0.82, ay: 0.68, bx: 0.82, by: 0.84, r: 0.035, color: TEXT }
  ],
  'tray-away': [...badge(), ...spineShapes(STRAIGHT, FAINT, { outline: true })]
}

const TRAY_SIZES = [16, 20, 24, 32, 48]
const trayDir = join(root, 'resources/tray')
mkdirSync(trayDir, { recursive: true })
for (const [name, shapes] of Object.entries(TRAY_STATES)) {
  const ico = encodeIco(TRAY_SIZES.map((size) => ({ size, png: encodePng(raster(size, shapes), size, size) })))
  writeFileSync(join(trayDir, `${name}.ico`), ico)
  console.log(`[gen-icons] ${name}.ico (${ico.length} bytes)`)
}

// app icon: ink rounded square, sage spine, larger presence
const appShapes = [
  { kind: 'roundRect', cx: 0.5, cy: 0.5, hw: 0.46, hh: 0.46, rr: 0.2, color: INK },
  { kind: 'roundRectOutline', cx: 0.5, cy: 0.5, hw: 0.46, hh: 0.46, rr: 0.2, stroke: 0.02, color: HAIRLINE },
  ...spineShapes(STRAIGHT, SAGE, { segR: 0.095, segLen: 0.12 })
]
const APP_SIZES = [16, 24, 32, 48, 64, 128, 256]
mkdirSync(join(root, 'build'), { recursive: true })
const appIco = encodeIco(APP_SIZES.map((size) => ({ size, png: encodePng(raster(size, appShapes), size, size) })))
writeFileSync(join(root, 'build/icon.ico'), appIco)
console.log(`[gen-icons] build/icon.ico (${appIco.length} bytes)`)
