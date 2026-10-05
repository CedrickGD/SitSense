// Types for update-scan.mjs (imported by its unit tests).

export const UPDATER_NETWORK_PACKAGES: string[]
export const UPDATE_HOSTS: RegExp
export function packageOfPath(p: string): string | null
export function packageDirOfPath(p: string): string | null
export function networkApiSites(src: string): { index: number; what: string }[]
export function updaterWiring(src: string): { binding: string | null; ok: string[]; fail: string[] }
export function checkPackedModules(
  paths: Iterable<string>,
  pkgJson: (dir: string) => { version?: string; dependencies?: Record<string, string> } | null,
  rootDeps: Record<string, string> | undefined,
  satisfies?: (version: string, range: string) => boolean | null
): { packages: string[]; ok: string[]; fail: string[] }
export function parseUpdateYml(text: string): { files: string[]; [key: string]: string | string[] | undefined }
export function checkAppUpdateYml(
  text: string,
  owner: string,
  repo: string
): { config: { files: string[]; [key: string]: string | string[] | undefined }; fail: string[] }
