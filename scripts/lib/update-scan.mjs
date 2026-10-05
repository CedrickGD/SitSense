// Static checks for the auto-updater in a packaged build (used by
// scripts/verify-package.mjs; unit-tested in src/main/__tests__/verify-update-scan.test.ts).
//
// The updater is the second module allowed to reach the network (after the AI
// module). These checks pin down exactly how:
//   - out/main loads electron-updater once, into one binding, and uses that binding
//     only as `updater: <cond> ? <binding>.autoUpdater : null` (or `updater:
//     <binding>.autoUpdater`) in the object passed to createUpdateService(...)
//   - Electron's own (Squirrel) autoUpdater is not used
//   - in the asar's node_modules, network APIs appear only in electron-updater and
//     builder-util-runtime (the updater's own HTTP code), and node_modules holds
//     exactly the production dependency closure
//   - app-update.yml points at GitHub Releases of the expected repo

/** Packages whose code may use network APIs: electron-updater's own HTTP stack. */
export const UPDATER_NETWORK_PACKAGES = ['electron-updater', 'builder-util-runtime']

/** Hosts the updater talks to (GitHub Releases: the atom feed, latest.yml, the installer). */
export const UPDATE_HOSTS = /^(github\.com|api\.github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|github-releases\.githubusercontent\.com)$/

/** The package a node_modules path belongs to: node_modules/a/node_modules/@s/b/x.js → '@s/b'. */
export function packageOfPath(p) {
  const parts = p.split('/')
  const i = parts.lastIndexOf('node_modules')
  if (i < 0 || i + 1 >= parts.length) return null
  return parts[i + 1].startsWith('@') ? `${parts[i + 1]}/${parts[i + 2] ?? ''}` : parts[i + 1]
}

/** The package directory of a node_modules path: node_modules/a/node_modules/b/x.js → 'node_modules/a/node_modules/b'. */
export function packageDirOfPath(p) {
  const parts = p.split('/')
  const i = parts.lastIndexOf('node_modules')
  if (i < 0 || i + 1 >= parts.length) return null
  return parts.slice(0, i + (parts[i + 1].startsWith('@') ? 3 : 2)).join('/')
}

// Node/Chromium networking a JS file can reach (same patterns as the main-network check).
const NET_PATTERNS = [
  [/\b(?:require\(\s*|from\s*|import\(\s*)["'](?:node:)?(https?|http2|net|tls|dgram|undici|ws)["']/g, (m) => `loads the "${m[1]}" module`],
  [/(?<![\w$.])(WebSocket|EventSource|XMLHttpRequest)(?![\w$])/g, (m) => `uses ${m[1]}`],
  [/(?<![\w$])net\s*\.\s*(request|fetch)\s*\(/g, (m) => `calls net.${m[1]}()`],
  [/(?<![\w$.'"`])(?:globalThis\.|global\.|self\.)?fetch\s*\(/g, () => 'calls fetch()']
]

/** Network API sites in one JS source: [{ index, what }]. */
export function networkApiSites(src) {
  const out = []
  for (const [re, what] of NET_PATTERNS) for (const m of src.matchAll(re)) out.push({ index: m.index, what: what(m) })
  return out.sort((a, b) => a.index - b.index)
}

/**
 * The electron-updater wiring in bundled main code.
 * Returns { binding, ok: string[], fail: string[] }; binding null when main does not use electron-updater.
 */
export function updaterWiring(src) {
  const ok = []
  const fail = []
  const loads = [...src.matchAll(/\b(?:require\(\s*|from\s*|import\(\s*)["']electron-updater(?:\/[^"']*)?["']/g)]
  // Electron's built-in Squirrel updater: never (it is not how this app updates)
  for (const m of src.matchAll(/(?<![\w$])(?:electron|[\w$]+)\s*\.\s*autoUpdater\b/g)) {
    const owner = m[0].split('.')[0].trim()
    if (owner === 'electron') fail.push(`uses Electron's built-in autoUpdater: ${line(src, m.index)}`)
  }
  // the feed comes only from app-update.yml (checked separately): no runtime override
  for (const m of src.matchAll(/\.\s*(setFeedURL|forceDevUpdateConfig|updateConfigPath)\b/g)) {
    fail.push(`overrides the update feed (${m[1]}): ${line(src, m.index)}`)
  }
  if (!loads.length) return { binding: null, ok, fail }
  const decl = [...src.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["']electron-updater["']\s*\)/g)]
  if (loads.length !== 1 || decl.length !== 1) {
    fail.push(`electron-updater must be loaded exactly once, into one binding (found ${loads.length} load(s), ${decl.length} binding(s))`)
    return { binding: null, ok, fail }
  }
  const binding = decl[0][1]
  const declEnd = decl[0].index + decl[0][0].length
  const spans = updaterPropertySpans(src, binding)
  if (!spans.length) fail.push(`electron-updater is loaded but never handed to createUpdateService({ updater: … })`)
  const esc = binding.replace(/\$/g, '\\$')
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`, 'g'))) {
    if (m.index >= decl[0].index && m.index < declEnd) continue
    if (spans.some(([s, e]) => m.index >= s && m.index < e)) ok.push(`electron-updater's autoUpdater is only the \`updater:\` value passed to createUpdateService(): ${line(src, m.index)}`)
    else fail.push(`electron-updater used outside the \`updater:\` property passed to createUpdateService(): ${line(src, m.index)}`)
  }
  return { binding, ok, fail }
}

// `updater: B.autoUpdater` or `updater: <identifier/member> ? B.autoUpdater : null`, then `,` or `}`
function updaterPropertySpans(src, binding) {
  const esc = binding.replace(/\$/g, '\\$')
  const value = new RegExp(`(?<![\\w$.])updater\\s*:\\s*(?:[\\w$.]+\\s*\\?\\s*${esc}\\.autoUpdater\\s*:\\s*null|${esc}\\.autoUpdater)(?=\\s*[,}])`, 'g')
  const spans = []
  for (const m of src.matchAll(/(?<![\w$.]|function\s+)createUpdateService\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1
    const close = matchingBrace(src, open)
    if (close < 0) continue
    const body = src.slice(open, close + 1)
    for (const p of body.matchAll(value)) {
      const at = open + p.index
      if (depthBetween(src, open, at) === 1) spans.push([at, at + p[0].length])
    }
  }
  return spans
}

function matchingBrace(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++
    } else if (ch === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i)
    else if (ch === '/' && src[i + 1] === '*') i = src.indexOf('*/', i + 2) < 0 ? src.length : src.indexOf('*/', i + 2) + 1
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch) && --depth === 0) return i
  }
  return -1
}

function depthBetween(src, from, at) {
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

function line(src, i) {
  const n = src.slice(0, i).split('\n').length
  const text = src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i)).trim()
  return `line ${n}: ${text.slice(0, 120)}`
}

/**
 * node_modules in the asar must be exactly the production dependency closure.
 * pkgJson(dir) → parsed package.json at `${dir}/package.json` or null.
 * satisfies(version, range) → boolean | null (null = can't tell).
 * Returns { packages: string[], ok: string[], fail: string[] }.
 */
export function checkPackedModules(paths, pkgJson, rootDeps, satisfies = () => null) {
  const ok = []
  const fail = []
  const dirs = new Set()
  for (const p of paths) {
    if (!p.startsWith('node_modules/')) continue
    const d = packageDirOfPath(p)
    if (d) dirs.add(d)
  }
  /** Node resolution from `fromDir` (a package dir or '' for the app root). */
  const resolveDep = (fromDir, name) => {
    let base = fromDir
    for (;;) {
      const cand = `${base ? `${base}/` : ''}node_modules/${name}`
      if (dirs.has(cand)) return cand
      if (!base) return null
      const i = base.lastIndexOf('/node_modules/')
      base = i < 0 ? '' : base.slice(0, i)
    }
  }
  const reached = new Set()
  const queue = Object.entries(rootDeps ?? {}).map(([name, range]) => ({ from: '', name, range }))
  while (queue.length) {
    const { from, name, range } = queue.shift()
    const dir = resolveDep(from, name)
    if (!dir) {
      fail.push(`${name} (needed by ${from ? packageOfPath(`${from}/x`) : 'the app'}) is missing from app.asar node_modules`)
      continue
    }
    const pj = pkgJson(dir)
    if (!pj) {
      fail.push(`${dir}/package.json missing`)
      continue
    }
    const sat = satisfies(String(pj.version ?? ''), String(range))
    if (sat === false) fail.push(`${dir} is ${pj.version}, but ${from ? packageOfPath(`${from}/x`) : 'the app'} needs ${range}`)
    if (reached.has(dir)) continue
    reached.add(dir)
    for (const [dep, r] of Object.entries(pj.dependencies ?? {})) queue.push({ from: dir, name: dep, range: r })
  }
  for (const d of [...dirs].sort()) {
    if (!reached.has(d)) fail.push(`${d} is packed but is not a production dependency (only the "dependencies" closure may ship)`)
  }
  if (!fail.length) ok.push(`node_modules holds exactly the production dependency closure: ${[...reached].map((d) => d.replace(/^node_modules\//, '')).sort().join(', ') || 'nothing'}`)
  return { packages: [...reached], ok, fail }
}

/** Minimal YAML reader for electron-builder's flat app-update.yml / latest.yml. */
export function parseUpdateYml(text) {
  const out = { files: [] }
  let inFiles = false
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const top = raw.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (top) {
      inFiles = top[1] === 'files'
      if (!inFiles) out[top[1]] = top[2].replace(/^(['"])(.*)\1$/, '$2')
      continue
    }
    const url = raw.match(/^\s*-\s*url:\s*(.+)$/)
    if (inFiles && url) out.files.push(url[1].trim().replace(/^(['"])(.*)\1$/, '$2'))
  }
  return out
}

/** app-update.yml must send the updater to GitHub Releases of owner/repo (nothing else). */
export function checkAppUpdateYml(text, owner, repo) {
  const y = parseUpdateYml(text)
  const fail = []
  if (y.provider !== 'github') fail.push(`provider is "${y.provider ?? '(none)'}", expected github`)
  if (y.owner !== owner || y.repo !== repo) fail.push(`feed is ${y.owner ?? '?'}/${y.repo ?? '?'}, expected ${owner}/${repo}`)
  if (y.host && y.host !== 'github.com') fail.push(`custom host ${y.host}`)
  if (y.url) fail.push(`a generic feed url (${y.url})`)
  return { config: y, fail }
}
