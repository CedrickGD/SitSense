// Which files in dist/ are THIS version's release (scripts/verify-package.mjs,
// check "distributables"). dist/ keeps exes from older builds side by side, so the
// exes are picked by their exact electron-builder artifact names for the
// package.json version — never by "first file that matches a pattern".

const unquote = (s) => s.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2')

/** `<section>.artifactName` (or a top-level key when section is null) from electron-builder.yml text. */
export function builderYmlValue(yml, section, key) {
  const lines = String(yml).split(/\r?\n/)
  let inSection = section === null
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (top) {
      if (section === null && top[1] === key) return unquote(top[2])
      inSection = top[1] === section
      continue
    }
    if (!inSection || section === null) continue
    const m = new RegExp(`^\\s+${key}:\\s*(.+)$`).exec(line)
    if (m) return unquote(m[1])
  }
  return null
}

/** electron-builder's ${...} macros used by our artifact names. */
export function expandArtifactName(template, { version, productName, ext = 'exe' }) {
  return template.replaceAll('${version}', version).replaceAll('${productName}', productName).replaceAll('${ext}', ext)
}

/**
 * The exact distributable names for `version`, per electron-builder.yml
 * (fallbacks mirror the current config if a key is missing).
 */
export function expectedDistributables(yml, version) {
  const productName = builderYmlValue(yml, null, 'productName') ?? 'SitSense'
  const portable = expandArtifactName(builderYmlValue(yml, 'portable', 'artifactName') ?? 'SitSense-portable-${version}.exe', { version, productName })
  const setup = expandArtifactName(builderYmlValue(yml, 'nsis', 'artifactName') ?? '${productName}-Setup-${version}.${ext}', { version, productName })
  return { portable, setup }
}

/**
 * Release plan for `version` from the dist/ listing and the parsed latest.yml (or null).
 * - missing: expected exes that are not in dist/ (FAIL)
 * - stale: every other .exe in dist/ (older builds: WARN, never upload)
 * - assets: exactly what the GitHub release must carry
 */
export function planRelease({ files, version, expected, latest }) {
  const present = new Set(files)
  const missing = [
    ['portable', expected.portable],
    ['installer', expected.setup]
  ].filter(([, f]) => !present.has(f))
  const stale = files.filter((f) => /\.exe$/i.test(f) && f !== expected.portable && f !== expected.setup)
  const named = latest ? [...new Set([latest.path, ...(latest.files ?? [])].filter(Boolean))] : []
  const blockmaps = named.map((f) => `${f}.blockmap`).filter((b) => present.has(b))
  const assets = latest ? ['latest.yml', ...named, ...blockmaps, ...(present.has(expected.portable) ? [expected.portable] : [])] : []
  const problems = []
  if (latest) {
    if (latest.version !== version) problems.push(`latest.yml is for ${latest.version}, package.json is ${version} — stale dist?`)
    else if (latest.path && latest.path !== expected.setup) problems.push(`latest.yml points at ${latest.path}, but the ${version} installer is ${expected.setup}`)
    for (const f of named) {
      if (/\s/.test(f)) problems.push(`latest.yml names "${f}" — GitHub renames assets with spaces, so the download would 404`)
      else if (!present.has(f)) problems.push(`latest.yml names ${f}, which is not in dist/`)
    }
  }
  return { missing, stale, named, blockmaps, assets, problems }
}
