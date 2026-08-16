import type { SitSenseApi } from '../shared/ipc'

declare global {
  interface Window {
    sitsense: SitSenseApi
  }
}

export {}
