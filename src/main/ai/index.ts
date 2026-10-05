// Electron wiring for the AI feature: safeStorage-backed key store, the settings
// normalizer that recomputes hasKey/keyHint, and the service behind the AI IPC.
// Must run after app 'ready' (safeStorage needs it). Not imported by tests.

import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { IPC } from '../../shared/ipc'
import { getPauseState, onPauseChanged } from '../pause'
import { getSettings, onSettingsChanged, setSettingsNormalizer, settingsLoadedFromDisk, updateSettings } from '../settings-store'
import { sendToRenderer } from '../window'
import { createKeyStore, type EncryptionBackend } from './keystore'
import { createAiService, pruneOrphanKeys, withKeyState, type AiService } from './service'

let service: AiService | null = null

export function initAi(): AiService {
  if (service) return service
  const backend: EncryptionBackend = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (cipher) => safeStorage.decryptString(cipher),
    getSelectedStorageBackend: process.platform === 'linux' ? () => safeStorage.getSelectedStorageBackend() : undefined
  }
  const keys = createKeyStore({ file: join(app.getPath('userData'), 'ai-keys.json'), backend })
  // keys of connections that are gone (spec §4: deleting a connection deletes its key)
  pruneOrphanKeys(keys, getSettings(), settingsLoadedFromDisk())
  setSettingsNormalizer((s) => withKeyState(s, keys))
  service = createAiService({
    getSettings,
    updateSettings,
    broadcast: (s) => sendToRenderer(IPC.settingsChanged, s),
    keys,
    fetch: (url, init) => fetch(url, init),
    isPaused: () => getPauseState().paused
  })
  const svc = service
  // switching the master toggle off cancels anything in flight
  onSettingsChanged((s) => {
    if (!s.ai.enabled) svc.cancelAll()
  })
  // pausing monitoring cancels reviews and chats carrying camera data — nothing from the camera is uploaded while paused
  onPauseChanged((p) => {
    if (p.paused) svc.cancelPostureData()
  })
  return service
}
