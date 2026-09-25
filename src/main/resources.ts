import { join } from 'node:path'
import { app } from 'electron'

/** resources/ on disk — unpacked from the asar so Windows can read the files by path. */
export function resourcesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources')
    : join(app.getAppPath(), 'resources')
}
