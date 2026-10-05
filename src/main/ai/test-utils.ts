// Test helpers for the AI module (imported only by src/main/__tests__/ai-*.test.ts;
// never bundled — nothing in the app imports this file).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiConnection } from '../../shared/ai'
import { mergeSettings, type Settings } from '../../shared/settings'
import type { FetchLike } from './http'
import { createKeyStore, type EncryptionBackend, type KeyStore } from './keystore'
import { withKeyState } from './service'

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  rawBody: string | undefined
}

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error | 'hang'

/** A fetch that records requests and answers from `route`. 'hang' waits for the abort signal. */
export function fakeFetch(route: (call: RecordedCall, index: number) => Reply): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fn = (async (input: string, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    const call: RecordedCall = { url: input, method: init?.method ?? 'GET', headers, body: rawBody ? JSON.parse(rawBody) : undefined, rawBody }
    calls.push(call)
    const r = route(call, calls.length - 1)
    if (r === 'hang') {
      return new Promise<Response>((_res, rej) => {
        const sig = init?.signal
        if (sig?.aborted) rej(sig.reason)
        sig?.addEventListener('abort', () => rej(sig.reason), { once: true })
      })
    }
    if (r instanceof Error) throw r
    const body = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(r.status && r.status >= 300 && r.status < 400 ? null : body, {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) }
    })
  }) as FetchLike & { calls: RecordedCall[] }
  fn.calls = calls
  return fn
}

/** Reversible, obviously-not-plaintext "encryption" for tests. */
export function fakeBackend(opts: { available?: boolean; storage?: string } = {}): EncryptionBackend & { available: boolean } {
  const b = {
    available: opts.available ?? true,
    isEncryptionAvailable: () => b.available,
    encryptString: (plain: string) => Buffer.from(`ENC1:${Buffer.from(plain, 'utf8').toString('hex').split('').reverse().join('')}`),
    decryptString: (cipher: Buffer) => {
      const s = cipher.toString('utf8')
      if (!s.startsWith('ENC1:')) throw new Error('bad cipher')
      return Buffer.from(s.slice(5).split('').reverse().join(''), 'hex').toString('utf8')
    },
    getSelectedStorageBackend: opts.storage ? () => opts.storage as string : undefined
  }
  return b
}

export function tempKeyFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'sitsense-ai-')), 'ai-keys.json')
}

export function makeKeyStore(backend = fakeBackend(), file = tempKeyFile()): { keys: KeyStore; file: string; backend: typeof backend } {
  return { keys: createKeyStore({ file, backend }), file, backend }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  if (base === null || typeof base !== 'object' || Array.isArray(base)) base = {}
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = deepMerge(out[k], v)
  return out
}

/** In-memory twin of settings-store with the AI key-state normalizer installed. */
export function settingsHolder(keys: KeyStore, initial: unknown = {}): {
  get: () => Settings
  update: (patch: unknown) => Settings
  broadcasts: Settings[]
  broadcast: (s: Settings) => void
} {
  let s = withKeyState(mergeSettings(initial), keys)
  const broadcasts: Settings[] = []
  return {
    get: () => s,
    update: (patch) => {
      s = withKeyState(mergeSettings(deepMerge(s, patch)), keys)
      return s
    },
    broadcasts,
    broadcast: (x) => broadcasts.push(x)
  }
}

export function conn(patch: Partial<AiConnection> = {}): AiConnection {
  return {
    id: 'c1',
    kind: 'gemini',
    label: 'Google Gemini',
    baseUrl: null,
    model: 'gemini-3.5-flash-lite',
    enabled: true,
    hasKey: true,
    keyHint: '…abcd',
    lastTest: null,
    ...patch
  }
}

/** a tiny valid-looking JPEG payload (starts with FF D8 FF) */
export const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64')

export const FAKE_KEYS = {
  aq: 'AQ.AbFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEtest',
  aiza: 'AIzaSyFAKE-FAKE_FAKEFAKEFAKEFAKEFAKE00',
  openai: 'sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEtestKEY9',
  anthropic: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEtestKEY9',
  openrouter: 'sk-or-v1-FAKEFAKEFAKEFAKEFAKEFAKEtestKEY9'
} as const
