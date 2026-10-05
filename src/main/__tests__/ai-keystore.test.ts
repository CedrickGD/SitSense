import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeSettings } from '../../shared/settings'
import { AiError } from '../ai/errors'
import { ENCRYPTION_UNAVAILABLE, createKeyStore } from '../ai/keystore'
import { withKeyState } from '../ai/service'
import { FAKE_KEYS, conn, fakeBackend, makeKeyStore, tempKeyFile } from '../ai/test-utils'

describe('key store', () => {
  it('stores, reads, hints and deletes keys; the file never holds plaintext', () => {
    const { keys, file } = makeKeyStore()
    expect(keys.hasKey('c1')).toBe(false)
    expect(keys.keyHint('c1')).toBeNull()
    keys.setKey('c1', FAKE_KEYS.aq)
    expect(keys.hasKey('c1')).toBe(true)
    expect(keys.getKey('c1')).toBe(FAKE_KEYS.aq)
    expect(keys.keyHint('c1')).toBe(`…${FAKE_KEYS.aq.slice(-4)}`)
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(FAKE_KEYS.aq)
    expect(raw).not.toContain(FAKE_KEYS.aq.slice(-8))
    expect(Object.keys(JSON.parse(raw))).toEqual(['c1'])
    // atomic write leaves no temp file behind
    expect(readdirSync(dirname(file))).toEqual(['ai-keys.json'])
    keys.deleteKey('c1')
    expect(keys.hasKey('c1')).toBe(false)
    expect(keys.getKey('c1')).toBeNull()
  })

  it('reloads from disk and recomputes hints', () => {
    const file = tempKeyFile()
    const backend = fakeBackend()
    createKeyStore({ file, backend }).setKey('x', FAKE_KEYS.openai)
    const again = createKeyStore({ file, backend })
    expect(again.hasKey('x')).toBe(true)
    expect(again.keyHint('x')).toBe(`…${FAKE_KEYS.openai.slice(-4)}`)
    expect(again.getKey('x')).toBe(FAKE_KEYS.openai)
  })

  it('refuses to store when encryption is unavailable (and writes nothing)', () => {
    const { keys, file } = makeKeyStore(fakeBackend({ available: false }))
    let err: unknown
    try {
      keys.setKey('c1', FAKE_KEYS.aq)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AiError)
    expect((err as Error).message).toBe(ENCRYPTION_UNAVAILABLE)
    expect((err as Error).message).not.toContain(FAKE_KEYS.aq)
    expect(existsSync(file)).toBe(false)
    expect(keys.hasKey('c1')).toBe(false)
  })

  it('refuses the Linux basic_text backend', () => {
    const { keys } = makeKeyStore(fakeBackend({ storage: 'basic_text' }))
    expect(() => keys.setKey('c1', FAKE_KEYS.aq)).toThrow(ENCRYPTION_UNAVAILABLE)
  })

  it('treats undecryptable or malformed entries as absent', () => {
    const file = tempKeyFile()
    writeFileSync(file, JSON.stringify({ bad: Buffer.from('garbage').toString('base64'), num: 5 }))
    const keys = createKeyStore({ file, backend: fakeBackend() })
    expect(keys.hasKey('bad')).toBe(false)
    expect(keys.getKey('bad')).toBeNull()
    expect(keys.hasKey('num')).toBe(false)
  })

  it('prunes keys of connections that no longer exist', () => {
    const { keys, file } = makeKeyStore()
    keys.setKey('keep', FAKE_KEYS.aq)
    keys.setKey('drop', FAKE_KEYS.openai)
    keys.prune(['keep'])
    expect(keys.hasKey('drop')).toBe(false)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['keep'])
  })

  it('short keys get a hint without characters', () => {
    const { keys } = makeKeyStore()
    keys.setKey('s', 'abc')
    expect(keys.keyHint('s')).toBe('…')
  })
})

describe('withKeyState', () => {
  it('recomputes hasKey/keyHint from the store, ignoring forged values from disk or a patch', () => {
    const { keys } = makeKeyStore()
    keys.setKey('real', FAKE_KEYS.anthropic)
    const forged = mergeSettings({
      ai: {
        connections: [
          conn({ id: 'real', hasKey: false, keyHint: null }),
          conn({ id: 'fake', hasKey: true, keyHint: '…EVIL' })
        ]
      }
    })
    const s = withKeyState(forged, keys)
    expect(s.ai.connections[0]).toMatchObject({ hasKey: true, keyHint: `…${FAKE_KEYS.anthropic.slice(-4)}` })
    expect(s.ai.connections[1]).toMatchObject({ hasKey: false, keyHint: null })
    expect(JSON.stringify(s)).not.toContain(FAKE_KEYS.anthropic)
  })
})
