// scripts/lib/update-scan.mjs — the packaged-build checks that keep the updater the
// only network path besides the AI module (scripts/verify-package.mjs, check 3b).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  UPDATE_HOSTS,
  checkAppUpdateYml,
  checkPackedModules,
  networkApiSites,
  packageDirOfPath,
  packageOfPath,
  parseUpdateYml,
  updaterWiring
} from '../../../scripts/lib/update-scan.mjs'

// what electron-vite/rollup emits for src/main/updater-init.ts
const WIRED = `const electron = require("electron");
const electronUpdater = require("electron-updater");
function initUpdater() {
  const packaged = electron.app.isPackaged;
  const svc = createUpdateService({
    // unpackaged: no updater
    updater: packaged ? electronUpdater.autoUpdater : null,
    portable: Boolean(process.env["PORTABLE_EXECUTABLE_FILE"]),
    onStatus: (s) => { send("update:state", s); }
  });
  return svc;
}
function createUpdateService(deps) {
  return deps.updater.checkForUpdates();
}
`

describe('updaterWiring (out/main)', () => {
  it('accepts electron-updater only as the updater: value passed to createUpdateService', () => {
    const r = updaterWiring(WIRED)
    expect(r.binding).toBe('electronUpdater')
    expect(r.fail).toEqual([])
    expect(r.ok).toHaveLength(1)
    expect(updaterWiring(WIRED.replace('packaged ? electronUpdater.autoUpdater : null', 'electronUpdater.autoUpdater')).fail).toEqual([])
  })

  it('is silent when main has no updater', () => {
    expect(updaterWiring('const electron = require("electron");\n')).toEqual({ binding: null, ok: [], fail: [] })
  })

  it.each([
    ['a direct check elsewhere', WIRED + 'function warmUp() { electronUpdater.autoUpdater.checkForUpdates(); }\n'],
    ['a second binding', WIRED + 'const again = require("electron-updater");\n'],
    ['a dynamic import', WIRED + 'function later() { return import("electron-updater"); }\n'],
    ['the binding inside another property', WIRED.replace('onStatus: (s) => {', 'onStatus: (s) => { electronUpdater.autoUpdater.downloadUpdate();')],
    ['a nested object value', WIRED.replace('updater: packaged ? electronUpdater.autoUpdater : null,', 'opts: { updater: electronUpdater.autoUpdater },')],
    ['setFeedURL to another server', WIRED + 'electronUpdater.autoUpdater.setFeedURL("https://evil.example/");\n'],
    ["Electron's Squirrel autoUpdater", WIRED + 'electron.autoUpdater.checkForUpdates();\n'],
    ['a feed override through the service', WIRED.replace('return deps.updater.checkForUpdates();', 'deps.updater.setFeedURL({ provider: "generic", url: "https://evil.example" });')]
  ])('fails %s', (_n, src) => {
    expect(updaterWiring(src).fail.length).toBeGreaterThan(0)
  })

  it('passes on the real build output when one exists', () => {
    let src: string
    try {
      src = readFileSync(join(__dirname, '../../../out/main/index.js'), 'utf8')
    } catch {
      return // not built
    }
    if (!src.includes('electron-updater')) return // stale build from before the updater
    const r = updaterWiring(src)
    expect(r.fail).toEqual([])
    expect(r.binding).not.toBeNull()
  })
})

describe('networkApiSites', () => {
  it('finds Node/Chromium networking', () => {
    const src = [
      'const https = require("https");',
      'const r = require("electron").net.request({ url });',
      'await fetch(url);',
      'new WebSocket(u);',
      'import("node:http2");'
    ].join('\n')
    expect(networkApiSites(src).map((s) => s.what)).toEqual([
      'loads the "https" module',
      'calls net.request()',
      'calls fetch()',
      'uses WebSocket',
      'loads the "http2" module'
    ])
  })

  it('ignores look-alikes', () => {
    expect(networkApiSites('const fs = require("fs"); obj.prefetch(x); "fetch(" ; a.netrequest(1); updater.checkForUpdates();')).toEqual([])
  })
})

describe('checkPackedModules', () => {
  const tree: Record<string, { version: string; dependencies?: Record<string, string> }> = {
    'node_modules/electron-updater': { version: '6.8.9', dependencies: { semver: '~7.7.3', 'lazy-val': '^1.0.5', 'builder-util-runtime': '9.7.0' } },
    'node_modules/semver': { version: '7.7.4' },
    'node_modules/lazy-val': { version: '1.0.5' },
    'node_modules/builder-util-runtime': { version: '9.7.0', dependencies: { debug: '^4.3.4' } },
    'node_modules/builder-util-runtime/node_modules/debug': { version: '4.4.3' }
  }
  const paths = (t: Record<string, unknown>): string[] => Object.keys(t).flatMap((d) => [`${d}/package.json`, `${d}/index.js`])
  const pj = (t: typeof tree) => (d: string) => t[d] ?? null
  const sat = (v: string, r: string): boolean | null => (r === '~7.7.3' ? v.startsWith('7.7.') : null)

  it('accepts exactly the production closure (nested node_modules resolve first)', () => {
    const r = checkPackedModules(paths(tree), pj(tree), { 'electron-updater': '^6.8.9' }, sat)
    expect(r.fail).toEqual([])
    expect(r.packages).toHaveLength(5)
  })

  it('fails an extra package', () => {
    const t = { ...tree, 'node_modules/left-pad': { version: '1.0.0' } }
    expect(checkPackedModules(paths(t), pj(t), { 'electron-updater': '^6.8.9' }, sat).fail).toEqual([
      'node_modules/left-pad is packed but is not a production dependency (only the "dependencies" closure may ship)'
    ])
  })

  it('fails a missing dependency and a wrong version', () => {
    const t = { ...tree, 'node_modules/semver': { version: '6.3.1' } } as typeof tree
    delete (t as Record<string, unknown>)['node_modules/lazy-val']
    const r = checkPackedModules(paths(t), pj(t), { 'electron-updater': '^6.8.9' }, sat)
    expect(r.fail).toEqual(expect.arrayContaining([expect.stringMatching(/lazy-val .*missing/), expect.stringMatching(/semver is 6\.3\.1, but electron-updater needs ~7\.7\.3/)]))
  })

  it('maps paths to packages', () => {
    expect(packageOfPath('node_modules/a/node_modules/@s/b/x.js')).toBe('@s/b')
    expect(packageDirOfPath('node_modules/a/node_modules/@s/b/lib/x.js')).toBe('node_modules/a/node_modules/@s/b')
    expect(packageOfPath('out/main/index.js')).toBeNull()
  })
})

describe('update metadata', () => {
  it('parses latest.yml', () => {
    const y = parseUpdateYml(
      "version: 0.2.0\nfiles:\n  - url: SitSense-Setup-0.2.0.exe\n    sha512: abc==\n    size: 1\npath: SitSense-Setup-0.2.0.exe\nsha512: abc==\nreleaseDate: '2026-10-05T18:53:38.602Z'\n"
    )
    expect(y.version).toBe('0.2.0')
    expect(y.path).toBe('SitSense-Setup-0.2.0.exe')
    expect(y.files).toEqual(['SitSense-Setup-0.2.0.exe'])
    expect(y.releaseDate).toBe('2026-10-05T18:53:38.602Z')
  })

  it('accepts only the GitHub feed of this repo', () => {
    const good = 'owner: CedrickGD\nrepo: SitSense\nprovider: github\nupdaterCacheDirName: sitsense-updater\n'
    expect(checkAppUpdateYml(good, 'CedrickGD', 'SitSense').fail).toEqual([])
    expect(checkAppUpdateYml(good.replace('SitSense\n', 'Other\n'), 'CedrickGD', 'SitSense').fail).toHaveLength(1)
    expect(checkAppUpdateYml('provider: generic\nurl: https://evil.example/\n', 'CedrickGD', 'SitSense').fail.length).toBeGreaterThanOrEqual(2)
  })

  it('knows the GitHub update hosts', () => {
    for (const h of ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']) expect(UPDATE_HOSTS.test(h)).toBe(true)
    for (const h of ['evil-github.com', 'github.com.evil.example', 'gitlab.com']) expect(UPDATE_HOSTS.test(h)).toBe(false)
  })

  it('electron-builder.yml publishes to the repo src/shared/update.ts names', () => {
    const yml = readFileSync(join(__dirname, '../../../electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/publish:\s*\n\s+provider: github\s*\n\s+owner: CedrickGD\b[^\n]*\n\s+repo: SitSense\b/)
    expect(yml).toMatch(/artifactName: \$\{productName\}-Setup-\$\{version\}\.\$\{ext\}/)
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as { scripts: Record<string, string> }
    // builds never publish by themselves; releases are uploaded by hand
    expect(pkg.scripts['dist']).toMatch(/--publish never/)
    expect(pkg.scripts['dist:dir']).toMatch(/--publish never/)
  })
})
