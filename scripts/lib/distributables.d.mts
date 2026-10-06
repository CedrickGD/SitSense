// Types for distributables.mjs (imported by its unit tests).

export function builderYmlValue(yml: string, section: string | null, key: string): string | null
export function expandArtifactName(template: string, v: { version: string; productName: string; ext?: string }): string
export function expectedDistributables(yml: string, version: string): { portable: string; setup: string }
export function planRelease(o: {
  files: string[]
  version: string
  expected: { portable: string; setup: string }
  latest: { files: string[]; [key: string]: string | string[] | undefined } | null
}): {
  missing: [string, string][]
  stale: string[]
  named: string[]
  blockmaps: string[]
  assets: string[]
  problems: string[]
}
