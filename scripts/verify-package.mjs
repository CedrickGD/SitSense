// Verifies that a BUILT package is self-contained: it runs on a stock Windows
// 10/11 machine with nothing installed separately and without network access.
// See docs/specs/packaging.md for what each check guarantees.
//
// Usage:
//   node scripts/verify-package.mjs [--app dist/win-unpacked] [--dist dist]
//                                   [--shots <dir>] [--skip-smoke] [--json]
//   npm run verify:package
//
// Exit code 1 when any check FAILs (WARN does not fail the run).
//
// Safety: the smoke tests launch the packaged exe with a throwaway
// --user-data-dir (never the real %APPDATA%\SitSense profile), close every
// instance they start, and restore the HKCU autostart value should the app's
// boot-time reconcile touch it.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expectedDistributables, planRelease } from './lib/distributables.mjs'
import { UPDATE_HOSTS, UPDATER_NETWORK_PACKAGES, checkAppUpdateYml, checkPackedModules, networkApiSites, packageOfPath, parseUpdateYml, updaterWiring } from './lib/update-scan.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const appDir = resolve(root, opt('--app', 'dist/win-unpacked'))
const distDir = resolve(root, opt('--dist', 'dist'))
const shotDir = resolve(opt('--shots', join(tmpdir(), 'sitsense-verify-shots')))
const skipSmoke = argv.includes('--skip-smoke')
const asJson = argv.includes('--json')

const results = []
function check(id, title) {
  const r = { id, title, status: 'PASS', evidence: [], problems: [], warnings: [] }
  results.push(r)
  return {
    ok: (msg) => r.evidence.push(msg),
    fail: (msg) => {
      r.problems.push(msg)
      r.status = 'FAIL'
    },
    warn: (msg) => {
      r.warnings.push(msg)
      if (r.status === 'PASS') r.status = 'WARN'
    },
    r
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len)
  const n = readSync(fd, b, 0, len, pos)
  return b.subarray(0, n)
}

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

/** Search a (possibly huge) file for an ASCII needle, chunked. Returns the match + `after` bytes. */
function grepFile(path, needle, after = 120) {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const chunk = 8 * 1024 * 1024
    const nb = Buffer.isBuffer(needle) ? needle : Buffer.from(needle, 'latin1')
    for (let pos = 0; pos < size; pos += chunk - nb.length - after) {
      const b = readAt(fd, pos, chunk)
      const i = b.indexOf(nb)
      if (i >= 0) return b.subarray(i, Math.min(b.length, i + nb.length + after)).toString('latin1')
      if (b.length < chunk) break
    }
    return null
  } finally {
    closeSync(fd)
  }
}

// ───────────────────────────── 1. PE imports ─────────────────────────────

/** Parses the PE headers, import table and delay-import table of an exe/dll/node. */
function parsePe(path) {
  const fd = openSync(path, 'r')
  try {
    const dos = readAt(fd, 0, 64)
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ)')
    const peOff = dos.readUInt32LE(0x3c)
    const coff = readAt(fd, peOff, 24)
    if (coff.readUInt32LE(0) !== 0x4550) throw new Error('not a PE file (no PE\\0\\0)')
    const machine = coff.readUInt16LE(4)
    const nsec = coff.readUInt16LE(6)
    const optSize = coff.readUInt16LE(20)
    const o = readAt(fd, peOff + 24, optSize)
    const pe32p = o.readUInt16LE(0) === 0x20b
    const imageBase = pe32p ? Number(o.readBigUInt64LE(24)) : o.readUInt32LE(28)
    const osVersion = `${o.readUInt16LE(40)}.${o.readUInt16LE(42)}`
    const subsystemVersion = `${o.readUInt16LE(48)}.${o.readUInt16LE(50)}`
    const ddOff = pe32p ? 112 : 96
    const nDD = o.readUInt32LE(ddOff - 4)
    const dd = (i) => (i < nDD ? { rva: o.readUInt32LE(ddOff + i * 8), size: o.readUInt32LE(ddOff + i * 8 + 4) } : { rva: 0, size: 0 })
    const st = readAt(fd, peOff + 24 + optSize, nsec * 40)
    const secs = []
    for (let i = 0; i < nsec; i++) {
      const s = i * 40
      secs.push({ va: st.readUInt32LE(s + 12), vsize: st.readUInt32LE(s + 8), rawSize: st.readUInt32LE(s + 16), raw: st.readUInt32LE(s + 20) })
    }
    const off = (rva) => {
      for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw
      return -1
    }
    const cstr = (rva) => {
      const p = off(rva)
      if (p < 0) return `<bad rva 0x${rva.toString(16)}>`
      const b = readAt(fd, p, 260)
      const z = b.indexOf(0)
      return b.subarray(0, z < 0 ? b.length : z).toString('latin1')
    }
    const imports = []
    const delay = []
    const imp = dd(1)
    if (imp.rva) {
      for (let p = off(imp.rva); p >= 0; p += 20) {
        const d = readAt(fd, p, 20)
        if (d.length < 20 || d.every((x) => x === 0)) break
        imports.push(cstr(d.readUInt32LE(12)))
      }
    }
    const dl = dd(13)
    if (dl.rva) {
      for (let p = off(dl.rva); p >= 0; p += 32) {
        const d = readAt(fd, p, 32)
        if (d.length < 32 || d.every((x) => x === 0)) break
        let nameRva = d.readUInt32LE(4)
        if (!(d.readUInt32LE(0) & 1)) nameRva -= imageBase // pre-VC7 delay descriptors hold VAs
        delay.push(cstr(nameRva))
      }
    }
    return { machine, pe32p, osVersion, subsystemVersion, imports, delay }
  } finally {
    closeSync(fd)
  }
}

// DLLs that ship with every Windows 10/11 desktop SKU (System32). api-ms-win-* /
// ext-ms-win-* API sets are resolved by the OS loader (api-ms-win-crt-* is the
// Universal CRT, in-box since Windows 10) and are accepted by prefix.
const INBOX = new Set(
  `advapi32 avrt bcrypt bcryptprimitives bthprops.cpl cfgmgr32 comctl32 comdlg32 credui crypt32 cryptbase
  d2d1 d3d11 d3d12 d3d9 dbghelp dcomp dhcpcsvc dnsapi dpapi dsound dwmapi dwrite dxgi dxva2 esent gdi32 hid
  imm32 iphlpapi kernel32 kernelbase ksuser mmdevapi msimg32 mswsock msvcrt ncrypt netapi32 normaliz ntdll
  ole32 oleacc oleaut32 pdh powrprof propsys psapi rpcrt4 secur32 sensapi setupapi shcore shell32 shlwapi
  sspicli ucrtbase urlmon user32 userenv usp10 uxtheme version wevtapi windowscodecs winhttp wininet winmm
  winspool.drv winsta wintrust winusb wldap32 ws2_32 wtsapi32 xinput1_4 uiautomationcore ninput dxcore
  mf mfplat mfreadwrite evr`
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => (n.includes('.') ? n : `${n}.dll`))
)
// Media Foundation is absent on Windows N/KN editions unless the Media Feature Pack is installed.
const MEDIA_FEATURE_PACK = new Set(['mf.dll', 'mfplat.dll', 'mfreadwrite.dll', 'evr.dll'])
// Never OS-provided: Visual C++ / .NET / DirectX SDK redistributables.
const REDIST = /^(vcruntime\d+(_\d+)?d?|msvcp\d+(_\w+)?d?|msvcr\d+d?|ucrtbased|concrt\d+|vcomp\d+|vccorlib\d+|mfc\d+\w*|atl\d+|mscoree|clr|coreclr|hostfxr|d3dx9_\d+|d3dx1[01]_\d+|d3dcompiler_4[0-6]|xinput1_[123]|xaudio2_[0-7]|xapofx1_\d|openal32|msvcirt)\.dll$/i
const CRT = /^(vcruntime|msvcp|msvcr|ucrtbase|api-ms-win-crt-)/i

function checkPeImports() {
  const c = check('pe-imports', 'PE import scan (no VC++/.NET/DirectX redistributables needed)')
  const exe = join(appDir, 'SitSense.exe')
  if (!existsSync(exe)) return c.fail(`${exe} not found — build first (npm run dist)`)
  const pes = walk(appDir).filter((p) => ['.exe', '.dll', '.node'].includes(extname(p).toLowerCase()))
  const shipped = new Set(readdirSync(appDir).filter((n) => n.toLowerCase().endsWith('.dll')).map((n) => n.toLowerCase()))
  const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const mfUsers = []
  for (const p of pes) {
    const rel = relative(appDir, p)
    let pe
    try {
      pe = parsePe(p)
    } catch (e) {
      c.fail(`${rel}: ${e.message}`)
      continue
    }
    const local = new Set([...shipped, ...readdirSync(dirname(p)).map((n) => n.toLowerCase())])
    const arch = { 0x8664: 'x64', 0x14c: 'x86', 0xaa64: 'arm64' }[pe.machine] ?? `0x${pe.machine.toString(16)}`
    const bad = []
    for (const [kind, list] of [['import', pe.imports], ['delay', pe.delay]]) {
      for (const dll of list) {
        const n = dll.toLowerCase()
        if (REDIST.test(n)) bad.push(`${dll} (${kind}) is a redistributable, not part of Windows`)
        else if (local.has(n) || /^(api|ext)-ms-win-/.test(n)) continue
        else if (INBOX.has(n)) {
          // a STATIC import of Media Foundation stops the exe from starting at all on
          // Windows N/KN without the Media Feature Pack; only a delay-load is safe
          if (MEDIA_FEATURE_PACK.has(n) && kind === 'import') bad.push(`${dll} statically imported — the exe would not start on Windows N/KN without the Media Feature Pack (must be delay-loaded)`)
          else if (MEDIA_FEATURE_PACK.has(n)) mfUsers.push(`${rel}:${dll}`)
        } else {
          const here = existsSync(join(sys32, dll)) ? 'present in this machine\'s System32' : 'NOT in System32'
          bad.push(`${dll} (${kind}) is neither shipped nor a known in-box Windows DLL (${here})`)
        }
      }
    }
    const crt = [...pe.imports, ...pe.delay].filter((d) => CRT.test(d))
    const crtNote = crt.length === 0 ? 'no CRT imports (CRT linked statically)' : `CRT via ${[...new Set(crt.map((d) => (/^api-ms-win-crt-/i.test(d) ? 'UCRT api-sets (in-box Win10+)' : d)))].join(', ')}`
    if (bad.length) bad.forEach((b) => c.fail(`${rel}: ${b}`))
    else c.ok(`${rel} [${arch}, subsystem ${pe.subsystemVersion}] ${pe.imports.length} imports + ${pe.delay.length} delay-loads all OS/in-folder; ${crtNote}`)
    if (rel === 'SitSense.exe') {
      if (crt.length) c.fail('SitSense.exe imports a CRT DLL — Electron is expected to link the CRT statically')
      else c.ok('PROOF static CRT: SitSense.exe imports no vcruntime*/msvcp*/ucrtbase/api-ms-win-crt-* (Chromium /MT build)')
      if (pe.machine !== 0x8664) c.warn(`SitSense.exe is ${arch}, not x64`)
    }
  }
  if (mfUsers.length) {
    c.ok(`Media Foundation is delay-loaded only (${mfUsers.join(', ')}; a static import would FAIL): the exe starts on Windows N/KN without the Media Feature Pack and Chromium falls back to DirectShow capture. DLLs Chromium loads with LoadLibrary at run time (e.g. MFCaptureEngine.dll, mfsensorgroup.dll) are invisible to an import scan`)
  }
}

// ───────────────────────────── asar ─────────────────────────────

function openAsar(path) {
  const fd = openSync(path, 'r')
  const head = readAt(fd, 0, 16)
  const headerSize = head.readUInt32LE(4)
  const jsonLen = head.readUInt32LE(12)
  const header = JSON.parse(readAt(fd, 16, jsonLen).toString('utf8'))
  const base = 8 + headerSize
  const files = new Map()
  const rec = (node, prefix) => {
    for (const [k, v] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${k}` : k
      if (v.files) rec(v, p)
      else files.set(p, v)
    }
  }
  rec(header, '')
  const unpackedDir = `${path}.unpacked`
  return {
    files,
    has: (p) => files.has(p),
    read(p) {
      const e = files.get(p)
      if (!e) return null
      if (e.unpacked) return readFileSync(join(unpackedDir, ...p.split('/')))
      return readAt(fd, base + Number(e.offset), e.size)
    },
    close: () => closeSync(fd)
  }
}

const isTextAsset = (p) => /\.(m?js|cjs|html|css|json)$/i.test(p)

// A .task model is a zip bundle: local-file header (PK\3\4) at the start AND the
// 22-byte end-of-central-directory record (PK\5\6) within the last 22 + 65535
// bytes, ending exactly at end of file, its central directory lying before it.
// A truncated download still starts with PK\3\4 but fails the EOCD test. Same
// rule as scripts/fetch-assets.mjs.
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
function taskBundleProblem(buf) {
  if (buf.length < 1_000_000) return `only ${buf.length} B`
  if (buf.subarray(0, 64).indexOf(ZIP_LOCAL) < 0) return 'no zip local-file header (PK\\3\\4) — not a zip'
  if (!hasZipEnd(buf)) return 'no complete zip end-of-central-directory (PK\\5\\6) at end of file — truncated'
  return null
}

// ───────────────────────────── 2. bundle contents ─────────────────────────────

function checkBundle(asar) {
  const c = check('bundle', 'Bundle contents (renderer, MediaPipe wasm + models, fonts, tray/toast resources)')
  const pkg = JSON.parse(asar.read('package.json')?.toString() ?? '{}')
  const main = posix.normalize((pkg.main ?? '').replace(/^\.\//, ''))
  if (!asar.has(main)) return c.fail(`package.json main "${pkg.main}" missing from app.asar`)
  c.ok(`app.asar: ${asar.files.size} files; main ${main}`)
  const mainSrc = asar.read(main).toString()

  // every runtime require() must resolve inside the package: a Node built-in, electron,
  // or a production dependency packed into app.asar/node_modules (electron-updater)
  const prodDeps = new Set(Object.keys(pkg.dependencies ?? {}))
  const builtins = new Set([...builtinModules, 'electron'])
  for (const f of [...asar.files.keys()].filter((p) => /^out\/(main|preload)\/.*\.(c|m)?js$/.test(p))) {
    const src = asar.read(f).toString()
    const reqs = new Set([...src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)|\bfrom\s*["']([^"'.][^"']*)["']|\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3]))
    for (const r of reqs) {
      const bare = r.replace(/^node:/, '').split('/')[0]
      if (r.startsWith('.') || builtins.has(r) || builtins.has(bare) || r.startsWith('node:')) continue
      const pkgName = r.startsWith('@') ? r.split('/').slice(0, 2).join('/') : r.split('/')[0]
      if (!prodDeps.has(pkgName)) c.fail(`${f}: require('${r}') is not a production dependency in package.json — bundle it or add it to "dependencies"`)
      else if (asar.has(`node_modules/${pkgName}/package.json`)) c.ok(`${f}: require('${r}') packed in app.asar/node_modules (production dependency)`)
      else c.fail(`${f}: require('${r}') is NOT in the package — it would only work on a machine with node_modules`)
    }
  }
  const native = [...asar.files.entries()].filter(([p]) => p.endsWith('.node'))
  for (const [p, e] of native) (e.unpacked ? c.ok : c.fail)(`native addon ${p} ${e.unpacked ? 'is unpacked' : 'is inside the asar (cannot be loaded)'}`)
  c.ok(`main/preload require only Node built-ins, electron and the production dependencies (${[...prodDeps].join(', ') || 'none'}); ${native.length} native addons`)
  // node_modules = exactly the production dependency closure, at versions that satisfy each range
  let semver = null
  try {
    semver = createRequire(join(root, 'package.json'))('semver')
  } catch {
    /* range check skipped */
  }
  const satisfies = (v, r) => {
    try {
      return semver ? semver.satisfies(v, r) : null
    } catch {
      return null
    }
  }
  const packed = checkPackedModules(asar.files.keys(), (d) => {
    try {
      return JSON.parse(asar.read(`${d}/package.json`)?.toString() ?? 'null')
    } catch {
      return null
    }
  }, pkg.dependencies, satisfies)
  packed.ok.forEach((m) => c.ok(m))
  packed.fail.forEach((m) => c.fail(m))

  // preload referenced by main
  for (const m of mainSrc.matchAll(/["'`]([^"'`]*preload\/index\.(?:c|m)?js)["'`]/g)) {
    const p = posix.normalize(posix.join(posix.dirname(main), m[1].replace(/^\.\.?\//, (s) => s)))
    const cand = [p, `out/preload/${basename(m[1])}`].find((x) => asar.has(x))
    ;(cand ? c.ok : c.fail)(`preload ${m[1]} ${cand ? `→ ${cand}` : 'missing'}`)
  }

  // renderer: index.html → scripts/styles → css url()s (fonts)
  const html = 'out/renderer/index.html'
  if (!asar.has(html)) return c.fail(`${html} missing`)
  const htmlSrc = asar.read(html).toString()
  const rdir = 'out/renderer'
  const refs = [...htmlSrc.matchAll(/\b(?:src|href)=["']([^"'#?]+)["']/g)].map((m) => m[1]).filter((u) => !/^[a-z]+:/i.test(u))
  const cssFiles = []
  for (const u of refs) {
    const p = posix.normalize(posix.join(rdir, u.replace(/^\//, '')))
    if (asar.has(p)) {
      c.ok(`index.html → ${p} (${asar.files.get(p).size} B)`)
      if (p.endsWith('.css')) cssFiles.push(p)
    } else c.fail(`index.html references ${u} but ${p} is missing`)
  }
  const fonts = new Set()
  for (const css of cssFiles) {
    const src = asar.read(css).toString()
    for (const m of src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const u = m[1]
      if (/^(data|blob):/i.test(u)) continue
      if (/^[a-z]+:\/\//i.test(u)) {
        c.fail(`${css} loads a remote url(${u})`)
        continue
      }
      const p = posix.normalize(posix.join(posix.dirname(css), u.split(/[?#]/)[0]))
      if (asar.has(p)) fonts.add(p)
      else c.fail(`${css} references ${u} but ${p} is missing`)
    }
    const families = [...new Set([...src.matchAll(/@font-face\s*\{[^}]*?font-family:\s*([^;}]+)/g)].map((m) => m[1].replace(/["']/g, '').trim()))]
    if (families.length) c.ok(`${css}: @font-face families bundled locally: ${families.join(', ')}`)
  }
  c.ok(`${fonts.size} font files referenced by CSS, all present in the asar`)

  // MediaPipe: WASM base + model paths, as the renderer bundle references them
  const rjs = [...asar.files.keys()].filter((p) => p.startsWith(`${rdir}/assets/`) && p.endsWith('.js'))
  const rsrc = rjs.map((p) => asar.read(p).toString()).join('\n')
  const wasmBases = [...new Set([...rsrc.matchAll(/["'`]((?:\.?\/)?[\w./-]*mediapipe\/wasm)\/?["'`]/g)].map((m) => m[1]))]
  const models = [...new Set([...rsrc.matchAll(/["'`]((?:\.?\/)?[\w./-]*\.task)["'`]/g)].map((m) => m[1]))]
  if (!wasmBases.length) c.fail('renderer bundle has no "…mediapipe/wasm" fileset base — cannot verify the wasm location')
  if (!models.length) c.fail('renderer bundle references no .task model')
  const wasmNames = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']
  for (const b of wasmBases) {
    for (const n of wasmNames) {
      const p = posix.normalize(posix.join(rdir, b.replace(/^\.?\//, ''), n))
      const buf = asar.has(p) ? asar.read(p) : null
      if (!buf) c.fail(`${p} missing (FilesetResolver.forVisionTasks('${b}') loads it)`)
      else if (n.endsWith('.wasm') && buf.readUInt32LE(0) !== 0x6d736100) c.fail(`${p} is not a wasm binary`)
      else c.ok(`${p} (${(buf.length / 1e6).toFixed(1)} MB)${n.includes('nosimd') ? ' — fallback for CPUs without WASM SIMD' : ''}`)
    }
    const mod = posix.join(rdir, b, 'vision_wasm_module_internal.js')
    if (!asar.has(mod)) c.ok(`vision_wasm_module_internal.* intentionally not shipped (only loaded with forVisionTasks(base, useModule=true); the smoke test confirms it is never requested)`)
  }
  for (const m of models) {
    const p = posix.normalize(posix.join(rdir, m.replace(/^\.?\//, '')))
    const buf = asar.has(p) ? asar.read(p) : null
    const problem = buf && taskBundleProblem(buf)
    if (!buf) c.fail(`model ${p} missing (renderer loads '${m}')`)
    else if (problem) c.fail(`model ${p} is not a valid .task bundle: ${problem}`)
    else c.ok(`model ${p} (${(buf.length / 1e6).toFixed(1)} MB, valid .task zip: local header + end-of-central-directory)`)
  }

  // resources/ (tray ICOs, toast PNGs) must be real files on disk next to the asar
  const srcRes = join(root, 'resources')
  const unpacked = join(appDir, 'resources', 'app.asar.unpacked', 'resources')
  const srcFiles = walk(srcRes).map((p) => relative(srcRes, p).split('\\').join('/'))
  for (const f of srcFiles) {
    const disk = join(unpacked, ...f.split('/'))
    if (!existsSync(disk)) c.fail(`resources/${f} missing from app.asar.unpacked (tray/toast needs a real path)`)
    else if (statSync(disk).size !== statSync(join(srcRes, ...f.split('/'))).size) c.warn(`resources/${f} differs from the repo copy (stale build?)`)
  }
  const shippedRes = walk(unpacked).map((p) => relative(unpacked, p).split('\\').join('/'))
  c.ok(`app.asar.unpacked/resources: ${shippedRes.filter((f) => f.endsWith('.ico')).length} tray ICOs, ${shippedRes.filter((f) => f.endsWith('.png')).length} toast PNGs (repo has ${srcFiles.length} resource files)`)
  for (const m of new Set([...mainSrc.matchAll(/["'`]([\w-]+\.(?:ico|png))["'`]/g)].map((x) => x[1]))) {
    if (!shippedRes.some((f) => f.endsWith(`/${m}`) || f === m)) c.fail(`main references ${m} but it is not in app.asar.unpacked/resources`)
  }
}

// ───────────────────────────── 3. no runtime downloads ─────────────────────────────

// The update feed (electron-builder.yml publish; src/shared/update.ts UPDATE_REPO).
const UPDATE_OWNER = 'CedrickGD'
const UPDATE_REPO = 'SitSense'

// URL hosts that appear in the bundle but are never fetched at runtime by the
// packaged app (namespaces, doc links in comments/error strings, placeholders).
const INERT_HOSTS = /^(www\.w3\.org|react\.dev|reactjs\.org|kripken\.github\.io|unicode\.org|en\.wikipedia\.org|www\.ietf\.org|tools\.ietf\.org|pubs\.opengroup\.org|developer\.mozilla\.org|webkit\.org|bugzil\.la|www\.khronos\.org|server\.com|(.*\.)?example\.(com|org)|fb\.me|tailwindcss\.com|ffmpeg\.org)$/
// User-configured cloud AI providers: called from MAIN only, only after the user adds a key.
const AI_HOSTS = /^(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|openrouter\.ai|localhost|127\.0\.0\.1|\[::1\])$/
// MediaPipe's usage logger (renderer) — must be blocked by the CSP.
const TELEMETRY_HOSTS = /^odml\.pa\.googleapis\.com$/
// Asset CDNs: any of these in the package means something is downloaded at runtime.
const CDN_HOSTS = /(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|storage\.googleapis\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|tfhub\.dev|kaggle\.com)$/

// The only CSP sources the packaged renderer may list: keywords, hashes/nonces and
// schemes that never leave the machine. Same allow-list as assertProductionCsp()
// in electron.vite.config.ts.
const CSP_LOCAL_SOURCE =
  /^('self'|'none'|'unsafe-inline'|'unsafe-eval'|'wasm-unsafe-eval'|'unsafe-hashes'|'strict-dynamic'|'report-sample'|'inline-speculation-rules'|'nonce-[^']+'|'sha(256|384|512)-[^']+'|blob:|data:|mediastream:|filesystem:|app:(\/\/renderer(\/[^\s]*)?)?)$/i
// Directives whose values are not source lists.
const CSP_NON_SOURCE = new Set(['sandbox', 'report-to', 'trusted-types', 'require-trusted-types-for', 'upgrade-insecure-requests', 'block-all-mixed-content', 'plugin-types', 'webrtc'])

function parseCsp(html) {
  const tag = html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0]
  const m = tag?.match(/\bcontent=(?:"([^"]*)"|'([^']*)')/i)
  if (!m) return null
  const d = {}
  for (const part of (m[1] ?? m[2]).split(';')) {
    const [k, ...v] = part.trim().split(/\s+/)
    if (k) d[k.toLowerCase()] = v
  }
  return d
}

function checkNoDownloads(asar) {
  const c = check('no-downloads', 'No runtime downloads (URL scan + renderer CSP) — only the user-triggered or scheduled update check')
  // the updater's feed: resources/app-update.yml (written by the nsis target; a --dir build has none)
  const updateYmlPath = join(appDir, 'resources', 'app-update.yml')
  const updateYml = existsSync(updateYmlPath) ? readFileSync(updateYmlPath, 'utf8') : null
  const feed = updateYml ? checkAppUpdateYml(updateYml, UPDATE_OWNER, UPDATE_REPO) : null
  const byHost = new Map()
  for (const p of asar.files.keys()) {
    if (!isTextAsset(p)) continue
    const src = asar.read(p).toString('utf8')
    for (const m of src.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+|\[[0-9a-f:]+\])(?::\d+)?/g)) {
      const host = m[1].toLowerCase().replace(/\.$/, '')
      if (!/[a-z0-9]/.test(host)) continue // "https://." inside a validation message
      if (!byHost.has(host)) byHost.set(host, new Set())
      byHost.get(host).add(p)
    }
  }
  // file list per host, node_modules files summarised per package
  const where = (h) => {
    const own = []
    const pkgs = new Map()
    for (const f of byHost.get(h)) {
      const pkgName = packageOfPath(f)
      if (pkgName) pkgs.set(pkgName, (pkgs.get(pkgName) ?? 0) + 1)
      else own.push(f)
    }
    return [...own, ...[...pkgs].map(([n, k]) => `node_modules/${n} (${k} file${k > 1 ? 's' : ''})`)].join(', ')
  }
  // packed packages that contain no network API at all (main-network check, 3b): a URL in
  // them (license headers, doc comments, package.json homepage) can never be fetched
  const netPkgs = new Set()
  for (const p of asar.files.keys()) {
    if (p.startsWith('node_modules/') && /\.(c|m)?js$/.test(p) && networkApiSites(asar.read(p).toString()).length) netPkgs.add(packageOfPath(p))
  }
  const inertPkgHosts = []
  for (const [host, files] of [...byHost.entries()].sort()) {
    const inRenderer = [...files].some((f) => f.startsWith('out/renderer/'))
    const inPackages = [...files].map(packageOfPath)
    const onlyNodeModules = inPackages.every(Boolean)
    if (CDN_HOSTS.test(host)) c.fail(`${host} (asset CDN) referenced in ${where(host)} — packaged app must not download assets`)
    else if (TELEMETRY_HOSTS.test(host)) c.ok(`${host}: MediaPipe usage logger in ${where(host)} — blocked by CSP connect-src (verified below)`)
    else if (UPDATE_HOSTS.test(host)) c.ok(`${host}: GitHub Releases (update feed / installer download) — reached only by electron-updater in main, for an update check; elsewhere doc links (${where(host)})`)
    else if (onlyNodeModules && inPackages.every((n) => !netPkgs.has(n))) inertPkgHosts.push(host)
    else if (onlyNodeModules && inPackages.every((n) => !netPkgs.has(n) || UPDATER_NETWORK_PACKAGES.includes(n))) {
      c.ok(`${host}: in electron-updater's code for another update provider or a doc link — never contacted: the feed is app-update.yml's github provider (${where(host)})`)
    } else if (AI_HOSTS.test(host)) c.ok(`${host}: user-configured AI provider endpoint (${where(host)})${inRenderer ? ' — renderer copy is display/preset text; the renderer CSP forbids fetching it, calls go through main' : ''}`)
    else if (INERT_HOSTS.test(host)) continue
    else c.warn(`${host}: unclassified URL host in ${where(host)} — review whether it is fetched at runtime`)
  }
  if (inertPkgHosts.length) c.ok(`${inertPkgHosts.length} URL hosts only in packed packages without any network API (license headers, doc comments, package.json links): ${inertPkgHosts.join(', ')}`)
  const inert = [...byHost.keys()].filter((h) => INERT_HOSTS.test(h))
  c.ok(`${inert.length} inert URL hosts ignored (XML namespaces, doc links in comments/error text, placeholders): ${inert.join(', ')}`)

  const html = asar.read('out/renderer/index.html')?.toString() ?? ''
  const csp = parseCsp(html)
  if (!csp) return c.fail('packaged index.html has no Content-Security-Policy meta tag')
  const connect = csp['connect-src'] ?? csp['default-src'] ?? []
  const def = csp['default-src'] ?? []
  // without default-src, every directive that is left out (object-src, frame-src, …) is unrestricted
  if (!csp['default-src']) c.fail('CSP has no default-src — every directive it does not list would allow any origin')
  // EVERY directive with a source list (an explicit frame-src/child-src/object-src/
  // manifest-src https: loads remote content just as well); allow-list, not deny-list
  const sourceDirs = Object.keys(csp).filter((d) => !CSP_NON_SOURCE.has(d))
  let nonLocal = 0
  for (const dir of sourceDirs) {
    const remote = csp[dir].filter((t) => !CSP_LOCAL_SOURCE.test(t))
    nonLocal += remote.length
    if (remote.length) c.fail(`CSP ${dir} allows non-local sources: ${remote.join(' ')}`)
  }
  if (!nonLocal) c.ok(`CSP: all ${sourceDirs.length} source-list directives (${sourceDirs.join(', ')}) list only 'self'/keywords/blob:/data:/mediastream:/app: — no scheme, host or wildcard that leaves the machine`)
  // dev-only sources (electron.vite.config.ts adds them at serve time only; its build step refuses them)
  const devOnly = connect.filter((t) => /^(wss?|https?):/i.test(t))
  if (devOnly.length) {
    c.fail(`CSP connect-src "${connect.join(' ')}" contains ${devOnly.join(' ')} — a WebSocket/HTTP connection to any host would be allowed. ws: is the Vite dev-server HMR socket and must not ship (stale build? rebuild with the current electron.vite.config.ts)`)
  } else c.ok(`CSP connect-src "${connect.join(' ')}" allows no ws:/wss:/http:/https: and no remote host — the renderer cannot open any network connection`)
  const scriptSrc = csp['script-src'] ?? def
  if (scriptSrc.includes("'unsafe-inline'")) c.fail(`CSP script-src "${scriptSrc.join(' ')}" contains 'unsafe-inline' — only the Vite dev server's React Refresh preamble needs it (stale build?)`)
  else if (csp['script-src-elem']?.includes("'unsafe-inline'")) c.fail(`CSP script-src-elem "${csp['script-src-elem'].join(' ')}" contains 'unsafe-inline'`)
  else c.ok(`CSP script-src "${scriptSrc.join(' ')}" runs no inline script`)
  const mainSrc = asar.read('out/main/index.js')?.toString() ?? ''
  if (/onHeadersReceived/.test(mainSrc)) c.ok('main also sets response headers (onHeadersReceived) — review for CSP overrides')
  // the updater (src/main/updater.ts) is the one sanctioned runtime download: GitHub Releases only
  if (/electron-updater/.test(mainSrc)) {
    if (!updateYml) c.warn(`main uses electron-updater but ${updateYmlPath} is missing (a --dir build: only the nsis target writes it) — this build would report "can't update itself"`)
    else if (feed.fail.length) feed.fail.forEach((m) => c.fail(`resources/app-update.yml: ${m}`))
    else c.ok(`updater feed (resources/app-update.yml): GitHub Releases of ${feed.config.owner}/${feed.config.repo} only — checked 30 s after start and every 6 h while settings.updates.autoCheck is on, or on "Check for updates"`)
  } else c.ok('no auto-updater in main')
}

// ─────────────────── 3b. main/preload network APIs (static) ───────────────────
//
// Chromium's network switches (used by the smoke tests) do NOT reach Node's own
// networking in main, and a runtime counter can only be installed after launch.
// So prove statically, on the bundled code that ships, that main/preload can
// only reach the network through the AI module:
//   - no http/https/http2/net/tls/dgram/undici/ws module is required at all
//   - no WebSocket / EventSource / XMLHttpRequest
//   - electron net.fetch only with a pathToFileURL(...) argument (app:// handler)
//   - no other .fetch(/net.request( member call
//   - the bare global `fetch` appears only as the value of the `fetch:` property
//     of the object passed to createAiService(...) (a plain forwarding arrow, the
//     bare identifier or the shorthand) — not anywhere else, even inside initAi
//   - loadURL only of the app:// renderer (or the dev-server URL from
//     ELECTRON_RENDERER_URL); no downloadURL / resolveHost / preconnect
// …and through the updater (scripts/lib/update-scan.mjs):
//   - electron-updater loaded once; its binding only as the `updater:` value of the
//     object passed to createUpdateService(...); no Squirrel autoUpdater, no feed override
//   - in node_modules, network APIs only in electron-updater / builder-util-runtime
// Rollup emits every top-level function declaration at column 0, which is how a
// call site is attributed to its enclosing function in the report.

function topLevelFunctionAt(src, i) {
  const decls = [...src.slice(0, i).matchAll(/^(?:async\s+)?function\*?\s+([\w$]+)/gm)]
  const d = decls.pop()
  if (!d) return null
  const end = src.indexOf('\n}', d.index)
  if (end >= 0 && end < i) return null // i is past that function's closing brace → module top level
  return { name: d[1], body: src.slice(d.index, end < 0 ? src.length : end + 2) }
}

/** Index of the bracket closing the one at `open` (skips strings, templates, comments). -1 if unbalanced. */
function matchingClose(src, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const stack = [pairs[src[open]]]
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++
    } else if (ch === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i)
    else if (ch === '/' && src[i + 1] === '*') i = src.indexOf('*/', i + 2) < 0 ? src.length : src.indexOf('*/', i + 2) + 1
    else if (pairs[ch]) stack.push(pairs[ch])
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return -1
      if (!stack.length) return i
    }
  }
  return -1
}

/** Argument text of the call whose `(` is at `open`. */
function callArgs(src, open) {
  const close = matchingClose(src, open)
  return close < 0 ? null : { start: open + 1, end: close, text: src.slice(open + 1, close) }
}

// The ONE sanctioned global-fetch reference in main: the value of the `fetch:`
// property in the object passed to createAiService(...). Accepted values: a plain
// forwarding arrow `(a, b) => fetch(a, b)`, `fetch`, `globalThis.fetch`, or the
// shorthand `{ fetch }`. Anything else (a warm-up call elsewhere in initAi, a
// fetch inside another property, …) is not exempt.
const AI_FETCH_PROP =
  /(?<![\w$.])fetch\s*:\s*(?:(?:async\s*)?\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*(?:globalThis\.)?fetch\(\s*\1\s*(?:,\s*\2\s*)?\)|(?:globalThis\.)?fetch)(?=\s*[,}])|(?<=[{,]\s*)fetch(?=\s*[,}])/g
function aiFetchSpans(src) {
  const spans = []
  for (const m of src.matchAll(/(?<![\w$.]|function\s+)createAiService\s*\(/g)) {
    const args = callArgs(src, m.index + m[0].length - 1)
    if (!args) continue
    // only properties of the top-level object literal argument
    const objOpen = args.text.search(/\S/)
    if (args.text[objOpen] !== '{') continue
    const objClose = matchingClose(src, args.start + objOpen)
    for (const p of src.slice(args.start + objOpen, objClose + 1).matchAll(AI_FETCH_PROP)) {
      const at = args.start + objOpen + p.index
      // the property must sit at depth 1 of that object, not inside a nested value
      if (objClose > 0 && depthAt(src, args.start + objOpen, at) === 1) spans.push([at, at + p[0].length])
    }
  }
  return spans
}
/** Bracket depth of `at` relative to the bracket at `from` (1 = directly inside it). */
function depthAt(src, from, at) {
  let depth = 0
  for (let i = from; i < at; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < at && src[i] !== ch; i++) if (src[i] === '\\') i++
    } else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
  }
  return depth
}

/** Is the loadURL argument provably app:// (or the dev-server URL, set only by electron-vite dev)? */
function loadUrlArgIsLocal(src, arg) {
  let a = arg.trim()
  const fallback = a.match(/^([\w$]+)\s*(?:\?\?|\|\|)\s*([\s\S]+)$/)
  if (fallback) {
    // `dev ?? …` where dev comes (directly or via a helper) from ELECTRON_RENDERER_URL
    const init = src.match(new RegExp(`(?:const|let|var)\\s+${fallback[1].replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`))?.[1] ?? ''
    const helper = init.match(/^([\w$]+)\(\s*\)$/)?.[1]
    const helperSrc = helper ? (src.match(new RegExp(`(?:const|let|var|function)\\s+${helper.replace(/\$/g, '\\$')}\\b[^\\n]*`))?.[0] ?? '') : ''
    if (!/ELECTRON_RENDERER_URL/.test(init) && !/ELECTRON_RENDERER_URL/.test(helperSrc)) return false
    a = fallback[2].trim()
  }
  const origin = src.match(/(?:const|let|var)\s+APP_ORIGIN\s*=\s*["'`]([^"'`]*)["'`]/)?.[1] ?? ''
  if (/^(["'])app:\/\/[^"'\\]*\1$/i.test(a) || /^`app:\/\/[^`$\\]*`$/i.test(a)) return true // a constant app:// literal
  return /^app:\/\//i.test(origin) && /^(?:APP_ORIGIN|`\$\{APP_ORIGIN\}[^`$\\]*`)$/.test(a)
}

function checkMainNetwork(asar) {
  const c = check('main-network', 'Main/preload network APIs only in the AI module and the updater (static scan of the packaged out/main, out/preload and node_modules)')
  const files = [...asar.files.keys()].filter((p) => /^out\/(main|preload)\/.*\.(c|m)?js$/.test(p))
  if (!files.length) return c.fail('no out/main or out/preload JS in app.asar')
  let aiSites = 0
  for (const f of files) {
    const src = asar.read(f).toString()
    const at = (i) => `${f}:${src.slice(0, i).split('\n').length}`
    const snippet = (i) => src.slice(i, src.indexOf('\n', i)).trim().slice(0, 120)
    for (const m of src.matchAll(/\b(?:require\(\s*|from\s*|import\(\s*)["'](?:node:)?(https?|http2|net|tls|dgram|undici|ws)["']/g)) {
      c.fail(`${at(m.index)} loads the "${m[1]}" module — main/preload must not open sockets/HTTP outside the AI module's fetch`)
    }
    for (const m of src.matchAll(/(?<![\w$.])(WebSocket|EventSource|XMLHttpRequest|ClientRequest)(?![\w$])/g)) {
      c.fail(`${at(m.index)} uses ${m[1]}: ${snippet(m.index)}`)
    }
    for (const m of src.matchAll(/\.(fetch|request)\s*\(/g)) {
      if (/(?:^|[^\w$.])(?:globalThis|global|self)$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue // the global fetch — attributed below
      const isNet = /(?:^|[^\w$])(?:[\w$]+\.)?net$/.test(src.slice(Math.max(0, m.index - 40), m.index))
      if (isNet && m[1] === 'fetch' && /^\.fetch\s*\(\s*[\w$.]*pathToFileURL\(/.test(src.slice(m.index, m.index + 80))) {
        c.ok(`${at(m.index)} electron net.fetch of a local file URL (app:// protocol handler): ${snippet(m.index)}`)
      } else if (isNet || m[1] === 'fetch') {
        c.fail(`${at(m.index)} network call outside the AI module: ${snippet(m.index)}`)
      }
    }
    const aiSpans = aiFetchSpans(src)
    for (const m of src.matchAll(/(?<![\w$.'"`])(?:globalThis\.|global\.|self\.)?fetch(?![\w$])(?!\s*:)/g)) {
      const fn = topLevelFunctionAt(src, m.index)
      const where = fn ? `in ${fn.name}()` : 'at module top level'
      if (aiSpans.some(([s, e]) => m.index >= s && m.index < e)) {
        aiSites++
        c.ok(`${at(m.index)} global fetch is the \`fetch:\` value passed to createAiService() ${where}: ${snippet(m.index)}`)
      } else c.fail(`${at(m.index)} global fetch referenced outside the \`fetch:\` property passed to createAiService() (${where}): ${snippet(m.index)}`)
    }
    // Chromium-side network from main: navigation, downloads, DNS, preconnect.
    // The offline switches would block these at run time, but nothing would REPORT
    // a boot-time one (it happens before the runtime counters exist and outside the
    // renderer's request recorder), so they are checked here.
    for (const m of src.matchAll(/\.(loadURL|downloadURL|resolveHost|preconnect|createInterruptedDownload)\s*\(/g)) {
      const args = callArgs(src, m.index + m[0].length - 1)
      if (m[1] === 'loadURL' && args && loadUrlArgIsLocal(src, args.text)) {
        c.ok(`${at(m.index)} loadURL of the app:// renderer (or the electron-vite dev-server URL, which only \`electron-vite dev\` sets): ${snippet(m.index)}`)
      } else c.fail(`${at(m.index)} ${m[1]}() ${m[1] === 'loadURL' ? 'of a URL not provably app://' : 'reaches the network'}: ${snippet(m.index)}`)
    }
  }
  if (!aiSites) c.warn('no global fetch handed to createAiService() found — AI module wiring renamed? (not a self-containment problem)')
  c.ok(`scanned ${files.join(', ')}: Node networking is reachable only through the fetch injected into the AI service, which is called only after the user adds a provider key`)

  // ── the second sanctioned path: the updater (src/main/updater-init.ts → updater.ts) ──
  // out/main: electron-updater loaded once, used only as the `updater:` value passed to
  // createUpdateService(); no Squirrel autoUpdater; no runtime feed override.
  let wired = false
  for (const f of files) {
    const w = updaterWiring(asar.read(f).toString())
    w.ok.forEach((m) => c.ok(`${f}: ${m}`))
    w.fail.forEach((m) => c.fail(`${f}: ${m}`))
    if (w.binding) wired = true
  }
  // node_modules: network APIs only in electron-updater's own HTTP stack
  const nmFiles = [...asar.files.keys()].filter((p) => p.startsWith('node_modules/') && /\.(c|m)?js$/.test(p))
  const sitesByPkg = new Map()
  for (const p of nmFiles) {
    const sites = networkApiSites(asar.read(p).toString())
    if (!sites.length) continue
    const pkgName = packageOfPath(p)
    if (UPDATER_NETWORK_PACKAGES.includes(pkgName)) {
      if (!sitesByPkg.has(pkgName)) sitesByPkg.set(pkgName, new Set())
      sites.forEach((s) => sitesByPkg.get(pkgName).add(`${p.replace(`node_modules/${pkgName}/`, '')} ${s.what}`))
    } else sites.forEach((s) => c.fail(`${p} ${s.what} — only ${UPDATER_NETWORK_PACKAGES.join(' / ')} may reach the network`))
  }
  for (const [pkgName, sites] of sitesByPkg) c.ok(`${pkgName} (updater, allowed): ${[...sites].slice(0, 8).join('; ')}${sites.size > 8 ? ` … (${sites.size} sites)` : ''}`)
  if (wired) c.ok(`${nmFiles.length} packed node_modules JS files scanned: network APIs only in ${UPDATER_NETWORK_PACKAGES.join(' / ')}, reachable from main only through createUpdateService()`)
  else if (nmFiles.length) c.fail(`node_modules JS is packed but main does not use electron-updater (${nmFiles.length} files)`)
}

// ───────────────────────────── 4/5. offline smoke test ─────────────────────────────

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
const AUTOSTART_NAME = 'com.cedrickgd.sitsense'

function regGet(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', AUTOSTART_NAME], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const m = out.match(new RegExp(`${AUTOSTART_NAME.replace(/\./g, '\\.')}\\s+(REG_\\w+)\\s+(.*)`))
    return m ? { type: m[1], data: m[2].trim() } : null
  } catch {
    return null
  }
}
function regRestore(key, before) {
  const now = regGet(key)
  if (JSON.stringify(now) === JSON.stringify(before)) return false
  if (before) execFileSync('reg', ['add', key, '/v', AUTOSTART_NAME, '/t', before.type, '/d', before.data, '/f'], { stdio: 'ignore' })
  else execFileSync('reg', ['delete', key, '/v', AUTOSTART_NAME, '/f'], { stdio: 'ignore' })
  return true
}

/** Rejects when `p` has not settled after `ms` — no Playwright call may hang the run. */
function within(p, ms, what) {
  let t
  return Promise.race([p, new Promise((_, reject) => (t = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(t))
}

const NO_NETWORK = ['--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>']
const FAKE_CAMERA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

/**
 * opts.seed           partial settings.json written into the temp profile before launch
 * opts.expectDelegate 'CPU' → require MediaPipe's XNNPACK (CPU) delegate to be the one running
 * opts.limitation     a known, documented limitation: problems are reported as WARN, not FAIL
 * opts.updateCheck    press "Check for updates" (IPC) while offline: it must end in a quiet,
 *                     friendly error — no dialog, no crash, only GitHub update hosts contacted
 */
async function smoke(id, title, extraArgs, shotName, opts = {}) {
  const { seed = null, expectDelegate = null, limitation = null, updateCheck = false } = opts
  const c = check(id, title)
  const exe = join(appDir, 'SitSense.exe')
  if (!existsSync(exe)) return c.fail(`${exe} not found`)
  const { _electron } = await import(pathToFileURL(join(root, 'node_modules', 'playwright', 'index.mjs')).href)
  const userData = mkdtempSync(join(tmpdir(), 'sitsense-verify-'))
  if (seed) {
    writeFileSync(join(userData, 'settings.json'), JSON.stringify(seed))
    c.ok(`seeded temp settings.json: ${JSON.stringify(seed)}`)
  }
  const reg = { run: regGet(RUN_KEY), approved: regGet(APPROVED_KEY) }
  const args = [`--user-data-dir=${userData}`, ...FAKE_CAMERA, ...NO_NETWORK, ...extraArgs]
  c.ok(`launch: SitSense.exe ${args.join(' ')}`)

  const appRequests = []
  const remoteRequests = [] // every renderer request whose URL is not app:/data:/blob:/devtools:
  const sockets = []
  const consoleLines = []
  let app
  try {
    app = await _electron.launch({ executablePath: exe, args, timeout: 30000 })
    // record renderer traffic: every request, not just failed ones, so a remote
    // request that SUCCEEDED (block not working) is caught as well. The window has
    // already loaded by now — the page is reloaded below once all recorders are on.
    const ctx = app.context()
    ctx.on('request', (r) => {
      if (r.url().startsWith('app://')) appRequests.push(r)
      else if (!/^(data|blob|devtools|chrome-extension):/i.test(r.url())) remoteRequests.push(r)
    })
    const ud = await within(app.evaluate(({ app: a }) => a.getPath('userData')), 15000, 'main (userData)')
    if (resolve(ud).toLowerCase() !== resolve(userData).toLowerCase()) {
      c.fail(`userData is ${ud}, not the temp profile — aborting to protect the real profile`)
      return
    }
    c.ok(`userData = temp profile ${ud}; app.isPackaged = ${await within(app.evaluate(({ app: a }) => a.isPackaged), 15000, 'main (isPackaged)')}`)

    // positive proof that the offline switches really block Chromium's network stack
    // (renderer + electron.net): without it "no remote request was seen" proves nothing
    const probe = await Promise.race([
      app.evaluate(({ net }) => net.fetch('https://example.com/').then((r) => `LEAK: HTTP ${r.status}`, (e) => String(e?.message ?? e))),
      new Promise((r) => setTimeout(() => r('timeout after 15 s'), 15000))
    ])
    if (/ERR_/.test(probe)) c.ok(`network block proven: main electron.net.fetch('https://example.com/') → ${probe}`)
    else c.fail(`offline switches do not block Chromium's network stack: electron.net.fetch('https://example.com/') → ${probe}`)

    // count main-process network calls from here on (Node's fetch/http(s) ignore
    // Chromium's switches; anything earlier is covered by the static main-network check)
    // and record what the renderer's detection loop reports to main over IPC
    const hooks = await app.evaluate(({ dialog, ipcMain, net }) => {
      const g = globalThis
      const log = (g.__verifyFetches = [])
      // any message box / error box main shows (e.g. an unhandled updater error) is a FAIL
      const dialogs = (g.__verifyDialogs = [])
      for (const k of ['showErrorBox', 'showMessageBox', 'showMessageBoxSync']) {
        const orig = dialog[k]
        if (typeof orig !== 'function') continue
        dialog[k] = function (...a) {
          const texts = a.filter((x) => typeof x === 'string' || (x && typeof x === 'object' && 'message' in x)).map((x) => (typeof x === 'string' ? x : x.message))
          dialogs.push(`${k}: ${texts.join(' | ').slice(0, 200)}`)
          return orig.apply(this, a)
        }
      }
      const installed = []
      const urlOf = (x) => String(x?.url ?? x?.href ?? (x && typeof x === 'object' ? `${x.protocol ?? ''}//${x.hostname ?? x.host ?? ''}${x.path ?? ''}` : x))
      const wrap = (obj, key, label, skip = () => false) => {
        try {
          const orig = obj?.[key]
          if (typeof orig !== 'function') return
          obj[key] = function (...a) {
            const u = urlOf(a[0])
            if (!skip(u)) log.push(`${label} ${u}`)
            return orig.apply(this, a)
          }
          installed.push(label)
        } catch {
          /* not writable */
        }
      }
      wrap(g, 'fetch', 'fetch')
      const builtin = (n) => (typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule(n) : null)
      for (const n of ['http', 'https']) {
        const m = builtin(n)
        wrap(m, 'request', `${n}.request`)
        wrap(m, 'get', `${n}.get`)
      }
      // the app:// handler net.fetch()es local file: URLs (net.fetch is built on
      // net.request, so both see them) — only count the rest
      const isFile = (u) => /^file:/i.test(u)
      wrap(net, 'fetch', 'electron.net.fetch', isFile)
      wrap(net, 'request', 'electron.net.request', isFile)
      installed.push('dialog boxes')
      g.__verifyIpc = { counts: {}, lastStatus: null }
      const emit = ipcMain.emit
      ipcMain.emit = function (channel, ...rest) {
        const ipc = g.__verifyIpc
        ipc.counts[channel] = (ipc.counts[channel] ?? 0) + 1
        if (channel === 'detection:status') {
          try {
            ipc.lastStatus = JSON.parse(JSON.stringify(rest[1]))
          } catch {
            /* not serialisable */
          }
        }
        return emit.call(this, channel, ...rest)
      }
      return installed
    })
    c.ok(`main network counters installed after launch: ${hooks.join(', ')}`)
    const page = await app.firstWindow({ timeout: 30000 })
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`))
    page.on('websocket', (ws) => sockets.push(ws.url()))
    // _electron.launch() resolves only after the window exists and has already
    // loaded index.html + the entry chunk: everything the page did before this
    // point (requests, console errors, CSP violations, sockets) was not seen. Now
    // that every recorder is attached, reload so the whole page load — from the
    // document request on — happens under observation.
    const reloadFrom = appRequests.length
    const consoleFrom = consoleLines.length
    await page.reload({ waitUntil: 'load', timeout: 30000 })
    const reloaded = appRequests.slice(reloadFrom).map((r) => r.url())
    const docSeen = reloaded.some((u) => /^app:\/\/renderer\/(index\.html)?$/.test(u))
    const entrySeen = reloaded.some((u) => /^app:\/\/renderer\/assets\/[^/]+\.js$/.test(u))
    if (docSeen && entrySeen) c.ok(`page reloaded with all recorders attached: ${reloaded.length} app:// requests from the document on (index.html, entry ${reloaded.find((u) => /\/assets\/[^/]+\.js$/.test(u)).replace('app://renderer/', '')}, …); ${consoleFrom} console lines from before the reload kept`)
    else c.fail(`reload did not re-request ${docSeen ? '' : 'index.html '}${entrySeen ? '' : 'the entry JS '}under observation (saw: ${reloaded.slice(0, 5).join(', ') || 'nothing'}) — early page loads would go unrecorded`)
    // app:// loads of the discarded first page (some aborted by the reload) say
    // nothing about the package; status checks below use the observed load only.
    // remoteRequests keeps everything: a remote request from either page FAILs.
    appRequests.splice(0, reloadFrom)
    await page.waitForSelector('#root', { timeout: 20000 })
    const url = page.url()
    ;(url.startsWith('app://renderer') ? c.ok : c.fail)(`window URL ${url}`)
    const hasApi = await within(page.evaluate(() => typeof window.sitsense === 'object' && window.sitsense !== null), 15000, 'renderer (window.sitsense)')
    ;(hasApi ? c.ok : c.fail)(`window.sitsense ${hasApi ? 'exposed by preload' : 'MISSING'}`)

    // wait for the pose model to be fetched and the camera to deliver frames
    const deadline = Date.now() + 45000
    let cam = null
    let poseOk = false
    while (Date.now() < deadline) {
      poseOk = appRequests.some((r) => r.url().endsWith('/pose_landmarker_lite.task'))
      cam = await within(
        page.evaluate(() => {
          const vids = [...document.querySelectorAll('video')]
          return vids.map((v) => {
            const t = v.srcObject && typeof v.srcObject.getVideoTracks === 'function' ? v.srcObject.getVideoTracks()[0] : null
            return { w: v.videoWidth, h: v.videoHeight, track: t ? `${t.label}:${t.readyState}` : null, time: v.currentTime }
          })
        }),
        10000,
        'renderer (video probe)'
      ).catch(() => [])
      const graph = consoleLines.some((l) => /Graph successfully started running|XNNPACK delegate|GL version/i.test(l))
      if (poseOk && graph && cam.some((v) => v.w > 0)) break
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(3000) // let a few inferences run
    // which WebGL (if any) the renderer got — decides MediaPipe's GPU vs CPU delegate
    const gl = await within(page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('webgl2')
      if (!ctx) return null
      const ext = ctx.getExtension('WEBGL_debug_renderer_info')
      return ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER)
    }), 15000, 'renderer (WebGL probe)')
    c.ok(`renderer WebGL2: ${gl ?? 'unavailable'}`)
    // MediaPipe always needs a GL context for frame input; XNNPACK appears only when the CPU delegate runs inference
    const usedCpu = consoleLines.some((l) => /XNNPACK delegate for CPU/i.test(l))
    const usedGpu = !usedCpu && consoleLines.some((l) => /GL version/i.test(l))
    c.ok(`MediaPipe delegate in use: ${usedGpu ? 'GPU (WebGL2)' : usedCpu ? 'CPU (XNNPACK/WASM)' : 'unknown'}`)
    if (expectDelegate === 'CPU' && !usedCpu) c.fail('expected the CPU (XNNPACK) delegate to run — no XNNPACK log seen')
    if (/swiftshader/i.test(gl ?? '')) c.ok('WebGL is backed by the bundled SwiftShader (vk_swiftshader.dll) — no GPU driver involved')
    mkdirSync(shotDir, { recursive: true })
    const shot = join(shotDir, shotName)
    await page.screenshot({ path: shot })
    c.ok(`screenshot ${shot}`)

    // camera (fake device)
    const live = (cam ?? []).filter((v) => v.w > 0)
    if (live.length) c.ok(`camera stream running: ${live.map((v) => `${v.w}x${v.h} ${v.track ?? ''} t=${v.time.toFixed(1)}s`).join('; ')}`)
    else c.fail(`no <video> with frames (videos: ${JSON.stringify(cam)})`)

    // app:// asset loads
    const statuses = await Promise.all(
      appRequests.map(async (r) => {
        // a request that never completes (aborted, streaming) must not hang the run
        const resp = await within(r.response(), 5000, 'response').catch(() => null)
        return { url: r.url(), status: resp ? resp.status() : 'no-response' }
      })
    )
    // a load the outgoing page started just as the reload navigated is aborted
    // without a response; when the same URL also loaded with 200, it is that race,
    // not a broken asset
    const served = new Set(statuses.filter((s) => s.status === 200).map((s) => s.url))
    const raced = statuses.filter((s) => s.status === 'no-response' && served.has(s.url))
    if (raced.length) c.ok(`aborted duplicate load(s) around the reload, also served with 200: ${raced.map((s) => s.url.replace('app://renderer/', '')).join(', ')}`)
    const bad = statuses.filter((s) => s.status !== 200 && !raced.includes(s))
    const mp = statuses.filter((s) => /mediapipe|models\//.test(s.url))
    if (mp.length) c.ok(`MediaPipe assets served from app://: ${mp.map((s) => `${s.url.replace('app://renderer/', '')}=${s.status}`).join(', ')}`)
    if (!poseOk) c.fail('pose_landmarker_lite.task was never requested — the landmarker did not start')
    if (statuses.some((s) => /module_internal/.test(s.url))) c.fail('vision_wasm_module_internal was requested but is not shipped')
    bad.forEach((s) => c.fail(`app:// request ${s.url} → ${s.status}`))

    // landmarker init evidence (MediaPipe logs via console)
    const mpLogs = consoleLines.filter((l) => /Graph successfully started|XNNPACK|GL version|delegate|landmarker|OpenGL|WebGL/i.test(l))
    mpLogs.slice(0, 6).forEach((l) => c.ok(`console: ${l.split('\n')[0].slice(0, 200)}`))
    // informational: the hard evidence that inference runs is detection:status below
    if (!consoleLines.some((l) => /Graph successfully started running/i.test(l))) c.warn('MediaPipe never logged "Graph successfully started running" (log text changed, or the graph did not start — see detection:status)')
    const errs = consoleLines.filter((l) => /^\[(error|pageerror)\]/.test(l) || /\[detection\]|\[landmarker\]/.test(l))
    const fatal = errs.filter((l) => !/odml\.pa\.googleapis\.com|Content Security Policy.*connect-src|INFO: Created TensorFlow Lite XNNPACK/i.test(l))
    const counted = new Map()
    for (const l of fatal) counted.set(l.split('\n')[0], (counted.get(l.split('\n')[0]) ?? 0) + 1)
    for (const [l, n] of counted) {
      const msg = `console${n > 1 ? ` (×${n})` : ''}: ${l.slice(0, 300)}`
      if (/GPU delegate failed|first GPU inference failed/.test(l)) c.ok(`expected fallback — ${msg}`)
      else c.fail(msg)
    }
    // what the detection loop told main (tray/alerts are driven by this)
    const ipc = await within(app.evaluate(() => globalThis.__verifyIpc), 15000, 'main (IPC log)')
    const st = ipc?.lastStatus
    c.ok(`renderer→main IPC: ${Object.entries(ipc?.counts ?? {}).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`)
    if (st) {
      c.ok(`last detection:status ${JSON.stringify(st).slice(0, 300)}`)
      if (st.running !== true) c.fail('detection:status reports the detector is not running')
      if (expectDelegate && st.delegate && st.delegate !== expectDelegate) c.fail(`detection:status delegate ${st.delegate}, expected ${expectDelegate}`)
      for (const k of ['cameraError', 'detectorError', 'modelError', 'error']) if (st[k]) c.fail(`detection:status ${k} = ${JSON.stringify(st[k])}`)
    } else c.warn('no detection:status IPC seen (channel renamed?) — relying on console/network evidence')
    const detectorText = await within(page.evaluate(() => document.body.innerText), 15000, 'renderer (body text)')
    const errText = detectorText.match(/(couldn.t (load|start)|failed to load|model (failed|error)|camera (blocked|unavailable|error)|detector error|detection stopped)[^\n]{0,80}/i)
    if (errText) c.fail(`UI shows an error: "${errText[0]}"`)
    else c.ok('UI shows no detector/model/camera error')
    if (updateCheck) {
      // "Check for updates" offline: the updater must settle on a quiet, friendly error
      const before = await within(page.evaluate(() => window.sitsense.updateGetState()), 15000, 'renderer (update state)')
      c.ok(`update status at launch: mode ${before?.mode}, state ${JSON.stringify(before?.state)}`)
      const after = await within(page.evaluate(async () => {
        let s = await window.sitsense.updateCheck()
        for (let i = 0; i < 60 && s.state.kind === 'checking'; i++) {
          await new Promise((r) => setTimeout(r, 500))
          s = await window.sitsense.updateGetState()
        }
        return s
      }), 45000, 'renderer (update check)').catch((e) => ({ crashed: String(e?.message ?? e) }))
      if (after?.crashed) c.fail(`offline update check did not settle: ${after.crashed}`)
      else if (before?.mode === 'dev') c.fail('update status says mode "dev" in a packaged build — the updater is not wired')
      else if (after?.state?.kind === 'error' && /reach GitHub/i.test(after.state.message)) c.ok(`offline "Check for updates" → quiet friendly error: "${after.state.message}"`)
      else if (after?.state?.kind === 'error' && /can.t update itself/i.test(after.state.message)) c.warn(`offline "Check for updates" → "${after.state.message}" (no resources/app-update.yml: a --dir build)`)
      else c.fail(`offline "Check for updates" ended in ${JSON.stringify(after?.state)} — expected the offline error`)
      const alive = await within(page.evaluate(() => typeof window.sitsense.getAppStatus === 'function'), 10000, 'renderer (after update check)').catch(() => false)
      ;(alive ? c.ok : c.fail)(`app ${alive ? 'still running' : 'NOT responding'} after the offline update check`)
    }
    const dialogs = await within(app.evaluate(async () => (globalThis.__verifyDialogs ?? []).slice()), 15000, 'main (dialog log)')
    if (dialogs.length) dialogs.forEach((d) => c.fail(`main showed a dialog: ${d}`))
    else c.ok('main showed no message/error box')
    const mainCalls = await within(app.evaluate(async () => (globalThis.__verifyFetches ?? []).slice()), 15000, 'main (network log)')
    // the updater (electron-updater → electron.net.request) may ask GitHub; the offline
    // switches block it (proven above). Anything else from main FAILs.
    const hostOf = (u) => {
      try {
        return new URL(u.replace(/^\S+\s+/, '')).hostname
      } catch {
        return ''
      }
    }
    const updaterCalls = mainCalls.filter((u) => /^electron\.net\.request /.test(u) && UPDATE_HOSTS.test(hostOf(u)))
    const otherCalls = mainCalls.filter((u) => !updaterCalls.includes(u))
    updaterCalls.forEach((u) => c.ok(`main: updater request to GitHub (blocked offline): ${u}`))
    otherCalls.forEach((u) => c.fail(`main process network call: ${u}`))
    if (!mainCalls.length) c.ok('main process made no fetch / http(s).request / electron.net call to a non-file URL after launch')
    else if (!otherCalls.length) c.ok('main process network calls after launch: only the updater asking GitHub Releases')
    if (updateCheck && !updaterCalls.length) c.warn('the update check made no request to GitHub (no app-update.yml, or the updater is inactive)')

    // network: the renderer may only load app:// / data: / blob:. Every other request
    // FAILs whether or not it succeeded — except one the page's own CSP refused before
    // it reached the network (that refusal happens on an online machine too).
    await page.waitForTimeout(500) // let in-flight requests settle so failure() is known
    for (const r of remoteRequests) {
      const err = r.failure()?.errorText ?? ''
      const resp = err ? null : await Promise.race([r.response().catch(() => null), new Promise((res) => setTimeout(() => res(null), 2000))])
      const outcome = err || (resp ? `HTTP ${resp.status()} — REACHED THE NETWORK` : 'no response yet')
      if (/ERR_BLOCKED_BY_CSP/i.test(err)) c.ok(`renderer request refused by the CSP before the network: ${r.url()} (${err})`)
      else c.fail(`renderer requested a non-app:// URL: ${r.url()} → ${outcome}`)
    }
    sockets.forEach((u) => c.fail(`renderer opened a WebSocket: ${u}`))
    if (!remoteRequests.length && !sockets.length) c.ok('renderer made no request to any non-app:/data:/blob: URL and opened no WebSocket')
    const blocked = consoleLines.filter((l) => /Content Security Policy/i.test(l))
    blocked.slice(0, 3).forEach((l) => c.ok(`CSP blocked: ${l.slice(0, 200)}`))
  } catch (e) {
    c.fail(`smoke test crashed: ${e.message}`)
    if (consoleLines.length) c.fail(`console tail: ${consoleLines.slice(-8).join(' | ')}`)
  } finally {
    if (limitation && c.r.problems.length) {
      c.r.warnings.push(`KNOWN LIMITATION: ${limitation}`, ...c.r.problems)
      c.r.problems = []
      c.r.status = 'WARN'
    }
    if (app) {
      const proc = app.process()
      await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))])
      if (proc.exitCode === null) {
        try {
          execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          /* already gone */
        }
      }
    }
    // boot reconcile may call setLoginItemSettings — put the user's autostart back exactly as it was
    if (regRestore(RUN_KEY, reg.run)) c.warn(`app modified ${RUN_KEY}\\${AUTOSTART_NAME}; restored the previous value`)
    if (regRestore(APPROVED_KEY, reg.approved)) c.warn(`app modified ${APPROVED_KEY}\\${AUTOSTART_NAME}; restored the previous value`)
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(userData, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }
}

// ───────────────────────────── 6. distributables ─────────────────────────────

function checkDistributables() {
  const c = check('distributables', 'Portable exe + NSIS installer (no install/admin, OS floor)')
  const files = existsSync(distDir) ? readdirSync(distDir) : []
  // dist/ keeps older builds side by side: pick THIS version's exes by their exact
  // electron-builder artifact names, never by the first file matching a pattern
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const expected = expectedDistributables(yml, version)
  const latestPath = join(distDir, 'latest.yml')
  const latest = existsSync(latestPath) ? parseUpdateYml(readFileSync(latestPath, 'utf8')) : null
  const plan = planRelease({ files, version, expected, latest })
  for (const [label, f] of plan.missing) c.fail(`no ${label} exe ${f} for ${version} in ${distDir} — run npm run dist`)
  if (plan.stale.length) c.warn(`other exes in ${distDir} (older builds?): ${plan.stale.join(', ')} — do not upload them to v${version}`)
  for (const f of [expected.portable, expected.setup]) {
    if (!files.includes(f)) continue
    const p = join(distDir, f)
    const nsis = grepFile(p, 'NullsoftInst', 0)
    const level = grepFile(p, 'requestedExecutionLevel level="', 30)?.match(/level="(\w+)"/)?.[1]
    const size = (statSync(p).size / 1e6).toFixed(1)
    if (!nsis) c.fail(`${f}: not an NSIS self-extracting archive`)
    if (level !== 'asInvoker') c.fail(`${f}: manifest requests "${level}" — would trigger UAC`)
    else c.ok(`${f} (${size} MB): single-file NSIS self-extractor, manifest requestedExecutionLevel=asInvoker (no UAC/admin)`)
  }
  if (/perMachine:\s*false/.test(yml) && /oneClick:\s*true/.test(yml)) c.ok('electron-builder.yml nsis: oneClick + perMachine:false → per-user install to %LOCALAPPDATA%\\Programs, no UAC')
  else c.warn('nsis is not oneClick per-user — the installer may prompt for elevation')
  if (/allowElevation:\s*true/.test(yml)) c.warn('nsis.allowElevation is true')
  const exe = join(appDir, 'SitSense.exe')
  if (existsSync(exe)) {
    const pe = parsePe(exe)
    let electron = '?'
    try {
      electron = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
    } catch {
      /* not installed */
    }
    c.ok(`SitSense.exe: x64, PE subsystem version ${pe.subsystemVersion}; Electron ${electron} (Chromium ≥110 dropped Windows 7/8/8.1) → minimum Windows 10 x64 (Windows 11 on ARM runs it under x64 emulation)`)
    try {
      const ps = `$v=(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo; "$($v.ProductName) $($v.ProductVersion) / file $($v.FileVersion)"`
      const ver = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      c.ok(`SitSense.exe version resource: ${ver}`)
    } catch {
      /* informational only */
    }
  }
  // the update feed: an installed SitSense reads latest.yml from the GitHub release and
  // downloads the installer it names — every name must match a file uploaded to the release
  if (!latest) {
    c.fail(`no latest.yml in ${distDir} — installed copies could not find this version (the nsis target writes it)`)
    return
  }
  for (const p of plan.problems) c.fail(p)
  if (!plan.blockmaps.length) c.warn('no .blockmap next to the installer — updates still work, but always download the full installer')
  if (!c.r.problems.length) c.ok(`update feed latest.yml ${latest.version} → ${plan.named.join(', ')}. GitHub release v${version} must carry exactly these assets: ${plan.assets.join(', ')}`)
}

// ───────────────────────────── run ─────────────────────────────

if (!existsSync(appDir)) {
  console.error(`[verify-package] ${appDir} does not exist — run npm run dist (or dist:dir) first`)
  process.exit(1)
}
console.log(`[verify-package] app: ${appDir}`)

checkPeImports()
const asarPath = join(appDir, 'resources', 'app.asar')
if (existsSync(asarPath)) {
  const asar = openAsar(asarPath)
  try {
    checkBundle(asar)
    checkNoDownloads(asar)
    checkMainNetwork(asar)
  } finally {
    asar.close()
  }
} else {
  check('bundle', 'Bundle contents').fail(`${asarPath} missing`)
}
if (!skipSmoke) {
  await smoke('smoke-offline', 'Offline smoke test (GPU allowed, network disabled, fake camera, offline update check)', [], 'packaged-offline.png', { updateCheck: true })
  await smoke('smoke-nogpu', 'Offline smoke test without GPU (--disable-gpu → software WebGL)', ['--disable-gpu', '--disable-gpu-compositing'], 'packaged-offline-nogpu.png')
  await smoke('smoke-cpu', 'Offline smoke test, CPU delegate (--disable-gpu + settings delegate=CPU → XNNPACK/WASM inference)', ['--disable-gpu', '--disable-gpu-compositing'], 'packaged-offline-cpu.png', {
    seed: { delegate: 'CPU' },
    expectDelegate: 'CPU'
  })
  await smoke('smoke-nowebgl', 'Offline smoke test with no WebGL at all (--disable-gpu --disable-software-rasterizer)', ['--disable-gpu', '--disable-software-rasterizer'], 'packaged-offline-nowebgl.png', {
    expectDelegate: 'CPU',
    limitation:
      'MediaPipe tasks-vision uploads every video frame through a WebGL context even with the CPU delegate. Windows 10/11 always provide software WebGL (ANGLE on the in-box WARP rasterizer, or the bundled SwiftShader), so this only happens when software rendering is explicitly disabled — but then detection cannot run'
  })
}
checkDistributables()

if (asJson) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const r of results) {
    console.log(`\n${r.status.padEnd(4)}  ${r.title}`)
    for (const p of r.problems) console.log(`   ✗ ${p}`)
    for (const w of r.warnings) console.log(`   ! ${w}`)
    for (const e of r.evidence) console.log(`   · ${e}`)
  }
  const fails = results.filter((r) => r.status === 'FAIL').length
  console.log(`\n[verify-package] ${results.length - fails}/${results.length} checks passed${results.some((r) => r.status === 'WARN') ? ' (with warnings)' : ''}`)
}
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0)
