// build/installer.nsh — what a real uninstall must remove outside the install folder.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTOSTART_NAME } from '../autostart'

const root = join(__dirname, '../../..')
const nsh = readFileSync(join(root, 'build/installer.nsh'), 'utf8')
const pkgName: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

/** the body of `${ifNot} ${isUpdated} ... ${endIf}` in customUnInstall (real uninstall only) */
const realUninstall = (): string => {
  const m = /!macro customUnInstall\r?\n\s*\$\{ifNot\} \$\{isUpdated\}([\s\S]*)\r?\n\s*\$\{endIf\}\r?\n!macroend/.exec(nsh)
  expect(m, 'customUnInstall must guard its cleanup with ${ifNot} ${isUpdated}').not.toBeNull()
  return m![1]!
}

describe('build/installer.nsh customUnInstall', () => {
  it('removes both autostart values', () => {
    const body = realUninstall()
    expect(body).toContain(`"Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${AUTOSTART_NAME}"`)
    expect(body).toContain(`"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${AUTOSTART_NAME}"`)
  })

  it('removes the per-user updater cache (regression: ~113 MB installer.exe left behind)', () => {
    // electron-builder's appInfo.updaterCacheDirName = lowercased package name + "-updater"
    const cacheDir = `${pkgName.toLowerCase()}-updater`
    const body = realUninstall()
    expect(body).toContain(`RMDir /r "$LOCALAPPDATA\\${cacheDir}"`)
    // per-user even if perMachine is ever turned on
    const rm = body.indexOf('RMDir /r')
    expect(body.lastIndexOf('SetShellVarContext current', rm)).toBeGreaterThan(-1)
    expect(body.indexOf('SetShellVarContext all', rm)).toBeGreaterThan(rm)
  })
})
