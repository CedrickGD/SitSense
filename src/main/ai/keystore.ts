// Encrypted API-key store (docs/specs/ai-providers.md §4).
// File: userData/ai-keys.json = { [connectionId]: base64(cipher) }, written atomically.
// The encryption backend is Electron safeStorage (DPAPI on Windows) in the app and a
// fake in tests. Plaintext is never written; keys never leave main.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AiError } from './errors'

export interface EncryptionBackend {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
  /** Linux only; 'basic_text' means a hard-coded password, which we refuse */
  getSelectedStorageBackend?(): string
}

export interface KeyStore {
  /** throws AiError when encryption is unavailable */
  setKey(id: string, key: string): void
  getKey(id: string): string | null
  deleteKey(id: string): void
  hasKey(id: string): boolean
  /** "…abcd" (last 4 characters), null when no key is stored */
  keyHint(id: string): string | null
  /** drop keys whose connection no longer exists */
  prune(validIds: Iterable<string>): void
}

export const ENCRYPTION_UNAVAILABLE =
  'Secure key storage isn’t available on this system, so the key was not saved.'

export function makeKeyHint(key: string): string {
  return key.length >= 8 ? `…${key.slice(-4)}` : '…'
}

export function createKeyStore(opts: { file: string; backend: EncryptionBackend }): KeyStore {
  const { file, backend } = opts
  /** id → base64 cipher, exactly what is on disk */
  let entries: Record<string, string> = {}
  /** id → hint, computed once per entry so hasKey/keyHint never decrypt in a hot path */
  const hints = new Map<string, string>()

  const encryptionOk = (): boolean => {
    try {
      if (!backend.isEncryptionAvailable()) return false
      return backend.getSelectedStorageBackend?.() !== 'basic_text'
    } catch {
      return false
    }
  }

  const decrypt = (b64: string): string | null => {
    try {
      const plain = backend.decryptString(Buffer.from(b64, 'base64'))
      return typeof plain === 'string' && plain.length > 0 ? plain : null
    } catch {
      return null
    }
  }

  const load = (): void => {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) entries[id] = v
    }
    // compute hints; entries that no longer decrypt (moved profile, new machine) are unusable
    if (!encryptionOk()) return
    for (const [id, v] of Object.entries(entries)) {
      const plain = decrypt(v)
      if (plain) hints.set(id, makeKeyHint(plain))
    }
  }

  const persist = (): void => {
    const tmp = `${file}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    if (Object.keys(entries).length === 0) {
      try {
        unlinkSync(file)
      } catch {
        /* nothing to delete */
      }
      return
    }
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 })
    renameSync(tmp, file)
  }

  load()

  return {
    setKey(id, key) {
      if (!encryptionOk()) throw new AiError('invalid-input', ENCRYPTION_UNAVAILABLE)
      let cipher: Buffer
      try {
        cipher = backend.encryptString(key)
      } catch {
        throw new AiError('invalid-input', ENCRYPTION_UNAVAILABLE)
      }
      const prev = entries[id]
      entries = { ...entries, [id]: cipher.toString('base64') }
      try {
        persist()
      } catch {
        if (prev === undefined) delete entries[id]
        else entries[id] = prev
        throw new AiError('invalid-input', 'Couldn’t save the key to disk.')
      }
      hints.set(id, makeKeyHint(key))
    },
    getKey(id) {
      const v = entries[id]
      if (!v || !hints.has(id) || !encryptionOk()) return null
      return decrypt(v)
    },
    deleteKey(id) {
      if (!(id in entries) && !hints.has(id)) return
      delete entries[id]
      hints.delete(id)
      try {
        persist()
      } catch {
        /* best effort; the entry is gone from memory and pruned on the next write */
      }
    },
    hasKey(id) {
      return hints.has(id)
    },
    keyHint(id) {
      return hints.get(id) ?? null
    },
    prune(validIds) {
      const keep = new Set(validIds)
      let changed = false
      for (const id of Object.keys(entries)) {
        if (!keep.has(id)) {
          delete entries[id]
          hints.delete(id)
          changed = true
        }
      }
      if (changed) {
        try {
          persist()
        } catch {
          /* best effort */
        }
      }
    }
  }
}
