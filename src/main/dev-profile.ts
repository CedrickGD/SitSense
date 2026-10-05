import { app } from 'electron'

/**
 * Dev runs must not share settings, calibration and stats with the installed
 * app. Unpackaged, app.name is the package.json "name" ("sitsense"), whose
 * userData folder (%APPDATA%\sitsense) is the SAME folder as the packaged
 * productName "SitSense" on case-insensitive NTFS. Give dev its own profile.
 *
 * Side-effect module: src/main/index.ts must import it FIRST (before anything
 * that reads userData, and before requestSingleInstanceLock, whose lock lives
 * in userData — otherwise a dev run and the installed app block each other).
 */
export function devUserDataPath(userData: string): string {
  return userData.endsWith('-dev') ? userData : `${userData}-dev`
}

if (!app.isPackaged) {
  app.setPath('userData', devUserDataPath(app.getPath('userData')))
}
