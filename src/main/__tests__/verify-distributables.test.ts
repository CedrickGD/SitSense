// scripts/lib/distributables.mjs — which dist/ files are THIS version's release
// (scripts/verify-package.mjs, check "distributables").
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builderYmlValue, expectedDistributables, planRelease } from '../../../scripts/lib/distributables.mjs'

const root = join(__dirname, '../../..')
const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')

const latest020 = { version: '0.2.0', path: 'SitSense-Setup-0.2.0.exe', files: ['SitSense-Setup-0.2.0.exe'] }

describe('expectedDistributables', () => {
  it('derives both exe names from electron-builder.yml for the given version', () => {
    expect(expectedDistributables(builderYml, '0.2.0')).toEqual({
      portable: 'SitSense-portable-0.2.0.exe',
      setup: 'SitSense-Setup-0.2.0.exe'
    })
  })

  it('reads section keys and top-level keys, ignoring comments', () => {
    const yml = 'productName: Foo # c\nnsis:\n  # x\n  artifactName: "${productName}-Inst-${version}.${ext}"\nportable:\n  artifactName: p-${version}.exe\n'
    expect(builderYmlValue(yml, null, 'productName')).toBe('Foo')
    expect(expectedDistributables(yml, '1.2.3')).toEqual({ portable: 'p-1.2.3.exe', setup: 'Foo-Inst-1.2.3.exe' })
  })
})

describe('planRelease', () => {
  // the dist/ that made the old check pick the 0.1.0 exes (first alphabetical match)
  const mixed = [
    'SitSense Setup 0.1.0.exe',
    'SitSense Setup 0.1.0.exe.blockmap',
    'SitSense-Setup-0.2.0.exe',
    'SitSense-Setup-0.2.0.exe.blockmap',
    'SitSense-portable-0.1.0.exe',
    'SitSense-portable-0.2.0.exe',
    'builder-debug.yml',
    'latest.yml',
    'win-unpacked'
  ]
  const expected = expectedDistributables(builderYml, '0.2.0')

  it('lists only the current version as release assets; older exes are stale (regression)', () => {
    const plan = planRelease({ files: mixed, version: '0.2.0', expected, latest: latest020 })
    expect(plan.missing).toEqual([])
    expect(plan.problems).toEqual([])
    expect(plan.stale).toEqual(['SitSense Setup 0.1.0.exe', 'SitSense-portable-0.1.0.exe'])
    expect(plan.assets).toEqual([
      'latest.yml',
      'SitSense-Setup-0.2.0.exe',
      'SitSense-Setup-0.2.0.exe.blockmap',
      'SitSense-portable-0.2.0.exe'
    ])
  })

  it('reports a missing current-version exe instead of falling back to an old one', () => {
    const files = mixed.filter((f) => f !== 'SitSense-portable-0.2.0.exe')
    const plan = planRelease({ files, version: '0.2.0', expected, latest: latest020 })
    expect(plan.missing).toEqual([['portable', 'SitSense-portable-0.2.0.exe']])
    expect(plan.assets).not.toContain('SitSense-portable-0.1.0.exe')
    expect(plan.assets).not.toContain('SitSense-portable-0.2.0.exe')
  })

  it('flags a stale latest.yml and names with spaces', () => {
    const stale = planRelease({
      files: mixed,
      version: '0.2.0',
      expected,
      latest: { version: '0.1.0', path: 'SitSense Setup 0.1.0.exe', files: ['SitSense Setup 0.1.0.exe'] }
    })
    expect(stale.problems.some((p) => p.includes('latest.yml is for 0.1.0'))).toBe(true)
    expect(stale.problems.some((p) => p.includes('spaces'))).toBe(true)
  })

  it('flags latest.yml pointing at a different installer than this version builds', () => {
    const plan = planRelease({ files: mixed, version: '0.2.0', expected, latest: { ...latest020, path: 'Other.exe', files: ['Other.exe'] } })
    expect(plan.problems).toContain('latest.yml points at Other.exe, but the 0.2.0 installer is SitSense-Setup-0.2.0.exe')
  })
})
