// The AI IPC operations, independent of Electron so they can be tested with a fake
// settings holder, a fake key store backend and a fake fetch.

import { randomUUID } from 'node:crypto'
import {
  AI_LIMITS,
  AI_PRESETS,
  type AiChatRequest,
  type AiConnection,
  type AiModelList,
  type AiPostureReview,
  type AiProviderKind,
  type AiReviewRequest,
  type AiTestResult
} from '../../shared/ai'
import type { Settings } from '../../shared/settings'
import { AiError, safeMessage } from './errors'
import { abortable, timeoutSignal, type FetchLike } from './http'
import { runChat, type CoachChatReply } from './coach'
import { runReview } from './judge'
import type { KeyStore } from './keystore'
import { KEY_REQUIRED, baseUrlOf, createAdapters, defaultBaseUrl, defaultModel, type AdapterSet } from './providers'
import {
  validateBaseUrl,
  validateDelta,
  validateId,
  validateKeyInput,
  validateKind,
  validateLabel,
  validateChatRequest,
  validateModel,
  validateRequestId,
  validateReviewRequest
} from './validate'

export interface AiServiceDeps {
  getSettings(): Settings
  /** deep-partial patch, arrays replace (settings-store semantics); applies the key-state normalizer */
  updateSettings(patch: unknown): Settings
  /** tell the renderer (settingsChanged), like the generic settingsSet handler does */
  broadcast(s: Settings): void
  keys: KeyStore
  fetch: FetchLike
  /** monitoring pause state (main owns it): no review runs while paused (spec §1) */
  isPaused(): boolean
  now?: () => number
  newId?: () => string
  timeoutMs?: number
  /** override adapters (tests) */
  adapters?: AdapterSet
}

export interface AiService {
  saveConnection(conn: unknown, key?: unknown): Settings
  removeConnection(id: unknown): Settings
  moveConnection(id: unknown, delta: unknown): Settings
  testConnection(id: unknown): Promise<AiTestResult>
  listModels(id: unknown): Promise<AiModelList>
  /**
   * One posture review at a time. `req.requestId` (optional, renderer-chosen) names it so
   * the renderer can release the slot with cancelReview() when it abandons the review.
   */
  reviewPosture(req: unknown): Promise<AiPostureReview>
  /** abort the running review if it is `requestId`; frees the slot at once. Never throws. */
  cancelReview(requestId: unknown): void
  /**
   * coach chat (spec §7); never throws. A new chat replaces one still running (the
   * renderer keeps only one pending, so an older one has been abandoned): the older one
   * resolves with "The coach was interrupted."
   */
  chat(req: unknown): Promise<CoachChatReply>
  /** abort the chat in flight (Stop / Clear chat in the renderer) */
  cancelChat(): void
  /** abort every request in flight (AI switched off) */
  cancelAll(): void
  /**
   * abort the requests that carry camera-derived data — posture reviews and chats with
   * an image or a live readout (monitoring paused). Text-only chats keep running.
   */
  cancelPostureData(): void
}

export const PAUSED_MESSAGE = 'Monitoring is paused.'

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export const AI_DISABLED_MESSAGE = 'Turn on “Use a connected AI model” first.'

export const CHAT_DISABLED_MESSAGE = 'The coach needs a connected AI model — turn on “Use a connected AI model” in Settings → AI models.'

export function presetLabel(kind: AiProviderKind): string {
  if (kind === 'openai-compatible') return 'Custom (OpenAI-compatible)'
  return AI_PRESETS.find((p) => p.kind === kind)?.label ?? kind
}

/** hasKey/keyHint always come from the key store — never from disk or the renderer. */
export function withKeyState(s: Settings, keys: KeyStore): Settings {
  let changed = false
  const connections = s.ai.connections.map((c) => {
    const hasKey = keys.hasKey(c.id)
    const keyHint = hasKey ? keys.keyHint(c.id) : null
    if (c.hasKey === hasKey && c.keyHint === keyHint) return c
    changed = true
    return { ...c, hasKey, keyHint }
  })
  return changed ? { ...s, ai: { ...s.ai, connections } } : s
}

/**
 * Drop stored keys whose connection no longer exists (settings reset, connections
 * dropped by mergeAiSettings, a deleteKey whose disk write failed). Only when the
 * settings were actually read from disk: after a transient settings.json read/parse
 * failure the defaults have no connections and every key would be wiped.
 */
export function pruneOrphanKeys(keys: KeyStore, s: Settings, settingsFromDisk: boolean): void {
  if (!settingsFromDisk) return
  keys.prune(s.ai.connections.map((c) => c.id))
}

const isGoogle = (k: AiProviderKind): boolean => k === 'gemini' || k === 'vertex'

function originOf(c: Pick<AiConnection, 'kind' | 'baseUrl'>): string {
  try {
    return new URL(baseUrlOf(c)).origin
  } catch {
    return ''
  }
}

export function createAiService(deps: AiServiceDeps): AiService {
  const adapters = deps.adapters ?? createAdapters(deps.fetch)
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const timeoutMs = deps.timeoutMs ?? AI_LIMITS.timeoutMs
  let master = new AbortController()
  // requests carrying camera-derived data; aborted by cancelAll() and cancelPostureData()
  let postureCtl = new AbortController()
  // the one review in flight, with its own cancel handle (cancelReview)
  let review: { id: string; ctl: AbortController } | null = null
  // the one chat in flight; a newer chat or cancelChat() aborts it
  let chatCtl: AbortController | null = null
  // per connection: bumped by every test start and every key / endpoint change, so only
  // the newest test of the current key and endpoint records lastTest
  const testGen = new Map<string, number>()
  const bumpTest = (id: string): number => {
    const n = (testGen.get(id) ?? 0) + 1
    testGen.set(id, n)
    return n
  }
  const cancelled = (): AiError => new AiError('cancelled', 'Cancelled.')

  const connections = (): AiConnection[] => deps.getSettings().ai.connections

  const commit = (list: AiConnection[]): Settings => {
    const s = deps.updateSettings({ ai: { connections: list } })
    deps.broadcast(s)
    return s
  }

  const find = (id: string): AiConnection | undefined => connections().find((c) => c.id === id)

  return {
    saveConnection(input, keyInput) {
      if (!isObj(input)) throw new AiError('invalid-input', 'Invalid connection.')
      const key = validateKeyInput(keyInput)
      const list = connections()
      let existing: AiConnection | undefined
      if (input.id !== undefined && input.id !== null) {
        existing = list.find((c) => c.id === validateId(input.id))
        if (!existing) throw new AiError('invalid-input', 'Connection not found.')
      } else if (list.length >= AI_LIMITS.maxConnections) {
        throw new AiError('invalid-input', `You can add at most ${AI_LIMITS.maxConnections} connections.`)
      }

      const kind = input.kind !== undefined ? validateKind(input.kind) : existing?.kind
      if (!kind) throw new AiError('invalid-input', 'Choose a provider.')
      const kindChanged = !!existing && existing.kind !== kind
      const label = input.label !== undefined ? validateLabel(input.label) : (existing?.label ?? presetLabel(kind))
      const model = input.model !== undefined ? validateModel(input.model) : existing && !kindChanged ? existing.model : defaultModel(kind)
      let baseUrl: string | null
      if ('baseUrl' in input) baseUrl = validateBaseUrl(input.baseUrl)
      else baseUrl = existing && !kindChanged ? existing.baseUrl : null
      // the preset's own URL is stored as null so preset updates apply
      if (kind !== 'openai-compatible' && baseUrl && baseUrl === defaultBaseUrl(kind)) baseUrl = null
      if (kind === 'openai-compatible' && !baseUrl) throw new AiError('invalid-input', 'Enter the server’s base URL.')
      const enabled = typeof input.enabled === 'boolean' ? input.enabled : (existing?.enabled ?? true)

      const id = existing?.id ?? newId()
      let keyChanged = false
      if (typeof key === 'string') {
        deps.keys.setKey(id, key) // throws if encryption is unavailable — nothing changed yet
        keyChanged = true
      } else if (key === null) {
        if (deps.keys.hasKey(id)) keyChanged = true
        deps.keys.deleteKey(id)
      } else if (existing && deps.keys.hasKey(id)) {
        // a stored key never follows the connection to a different host (Gemini ↔ Vertex is Google ↔ Google)
        const from = originOf(existing)
        const to = originOf({ kind, baseUrl })
        if (from !== to && !(isGoogle(existing.kind) && isGoogle(kind) && !existing.baseUrl && !baseUrl)) {
          deps.keys.deleteKey(id)
          keyChanged = true
        }
      }

      const endpointChanged = !!existing && (kindChanged || existing.baseUrl !== baseUrl || existing.model !== model)
      // a test still running for the old key or endpoint must not record its result
      if (keyChanged || endpointChanged) bumpTest(id)
      const next: AiConnection = {
        id,
        kind,
        label,
        baseUrl,
        model,
        enabled,
        hasKey: deps.keys.hasKey(id),
        keyHint: deps.keys.keyHint(id),
        lastTest: existing && !endpointChanged && !keyChanged ? existing.lastTest : null
      }
      return commit(existing ? list.map((c) => (c.id === id ? next : c)) : [...list, next])
    },

    removeConnection(rawId) {
      const id = validateId(rawId)
      deps.keys.deleteKey(id)
      testGen.delete(id)
      const list = connections()
      if (!list.some((c) => c.id === id)) return deps.getSettings()
      return commit(list.filter((c) => c.id !== id))
    },

    moveConnection(rawId, rawDelta) {
      const id = validateId(rawId)
      const delta = validateDelta(rawDelta)
      const list = [...connections()]
      const i = list.findIndex((c) => c.id === id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= list.length) return deps.getSettings()
      ;[list[i], list[j]] = [list[j], list[i]]
      return commit(list)
    },

    async testConnection(rawId) {
      let id: string
      try {
        id = validateId(rawId)
      } catch (e) {
        return { ok: false, message: safeMessage(e, null), latencyMs: null }
      }
      if (!deps.getSettings().ai.enabled) return { ok: false, message: AI_DISABLED_MESSAGE, latencyMs: null }
      const conn = find(id)
      if (!conn) return { ok: false, message: 'Connection not found.', latencyMs: null }
      // starting a test supersedes any older one still running for this connection
      const gen = bumpTest(id)

      const key = deps.keys.getKey(id)
      let result: AiTestResult
      let suggested: AiProviderKind | undefined
      let wasCancelled = false
      if (KEY_REQUIRED.has(conn.kind) && !key) {
        result = { ok: false, message: 'Add an API key first.', latencyMs: null }
      } else {
        const t = timeoutSignal(timeoutMs, master.signal)
        const started = now()
        try {
          const out = await abortable(adapters[conn.kind].test(conn, key, t.signal), t.signal)
          result = { ok: true, message: out.message, latencyMs: Math.max(0, now() - started) }
          suggested = out.suggestedKind
        } catch (e) {
          wasCancelled = e instanceof AiError && e.code === 'cancelled'
          result = { ok: false, message: safeMessage(e, key), latencyMs: null }
        } finally {
          t.dispose()
        }
      }

      // a cancelled test (AI switched off) says nothing about the connection, and a test
      // superseded by a newer test or a key / endpoint change must not overwrite its result
      if (wasCancelled || !deps.getSettings().ai.enabled || testGen.get(id) !== gen) return result
      // record lastTest — only if the connection still exists and wasn't edited meanwhile
      const cur = find(id)
      if (cur && cur.kind === conn.kind && cur.baseUrl === conn.baseUrl && cur.model === conn.model) {
        const switchTo = suggested && suggested !== cur.kind ? suggested : undefined
        const updated: AiConnection = {
          ...cur,
          lastTest: { ok: result.ok, at: now(), message: result.message.slice(0, 300), latencyMs: result.latencyMs }
        }
        if (switchTo) {
          updated.kind = switchTo
          updated.baseUrl = null
          if (cur.label === presetLabel(cur.kind)) updated.label = presetLabel(switchTo)
          result = { ...result, switchedKind: switchTo }
        }
        commit(connections().map((c) => (c.id === id ? updated : c)))
      }
      return result
    },

    async listModels(rawId) {
      let id: string
      try {
        id = validateId(rawId)
      } catch (e) {
        return { ok: false, message: safeMessage(e, null) }
      }
      if (!deps.getSettings().ai.enabled) return { ok: false, message: AI_DISABLED_MESSAGE }
      const conn = find(id)
      if (!conn) return { ok: false, message: 'Connection not found.' }
      const key = deps.keys.getKey(id)
      // OpenRouter's model list is public; the others need the key
      if (KEY_REQUIRED.has(conn.kind) && conn.kind !== 'openrouter' && conn.kind !== 'vertex' && !key) {
        return { ok: false, message: 'Add an API key first.' }
      }
      const t = timeoutSignal(timeoutMs, master.signal)
      try {
        const models = await abortable(adapters[conn.kind].listModels(conn, key, t.signal), t.signal)
        return { ok: true, models }
      } catch (e) {
        return { ok: false, message: safeMessage(e, key) }
      } finally {
        t.dispose()
      }
    },

    async reviewPosture(raw) {
      let req: AiReviewRequest
      let requestId: string
      try {
        req = validateReviewRequest(raw)
        requestId = validateRequestId((raw as Record<string, unknown>).requestId) ?? newId()
      } catch (e) {
        return { ok: false, message: safeMessage(e, null) }
      }
      const ai = deps.getSettings().ai
      if (!ai.enabled) return { ok: false, message: 'AI review is turned off.' }
      // privacy contract: the model never runs while monitoring is paused
      if (deps.isPaused()) return { ok: false, message: PAUSED_MESSAGE }
      // privacy contract: only what the user chose may leave the device
      if (req.share !== ai.share) return { ok: false, message: 'The “What’s sent” setting changed — try again.' }
      if (review) return { ok: false, message: 'A review is already running.' }
      const mine = { id: requestId, ctl: new AbortController() }
      review = mine
      try {
        const fresh = { ...ai, connections: ai.connections.map((c) => ({ ...c, hasKey: deps.keys.hasKey(c.id) })) }
        return await runReview(fresh, req, {
          adapters,
          getKey: (cid) => deps.keys.getKey(cid),
          timeoutMs,
          signal: AbortSignal.any([postureCtl.signal, mine.ctl.signal])
        })
      } finally {
        // a cancelled review that settles late must not free a newer review's slot
        if (review === mine) review = null
      }
    },

    cancelReview(rawId) {
      let id: string | undefined
      try {
        id = validateRequestId(rawId)
      } catch {
        return
      }
      if (!id || !review || review.id !== id) return
      review.ctl.abort(cancelled())
      // freed now, not when the aborted promise settles: a review asked for right after is accepted
      review = null
    },

    async chat(raw) {
      let req: AiChatRequest
      try {
        req = validateChatRequest(raw)
      } catch (e) {
        return { ok: false, message: safeMessage(e, null) }
      }
      const ai = deps.getSettings().ai
      if (!ai.enabled) return { ok: false, message: CHAT_DISABLED_MESSAGE }
      const paused = deps.isPaused()
      if (req.image) {
        // same consent rules as a posture review: nothing from the camera while paused,
        // and only what the user chose to share
        if (paused) return { ok: false, message: PAUSED_MESSAGE }
        if (req.image.share !== ai.share) return { ok: false, message: 'The “What’s sent” setting changed — try again.' }
      }
      if (paused && req.context?.live) {
        // no live readout leaves the device while monitoring is paused
        const { live: _live, ...rest } = req.context
        void _live
        req = { ...req, context: Object.keys(rest).length ? rest : undefined }
      }
      // the renderer keeps one chat pending at a time, so one still running here was
      // abandoned (Stop, Clear chat): replace it instead of refusing the new question
      chatCtl?.abort(cancelled())
      const mine = new AbortController()
      chatCtl = mine
      const carriesPostureData = !!req.image || !!req.context?.live
      const base = carriesPostureData ? postureCtl.signal : master.signal
      try {
        const fresh = { ...ai, connections: ai.connections.map((c) => ({ ...c, hasKey: deps.keys.hasKey(c.id) })) }
        return await runChat(fresh, req, {
          adapters,
          getKey: (cid) => deps.keys.getKey(cid),
          timeoutMs,
          signal: AbortSignal.any([mine.signal, base]),
          now
        })
      } finally {
        if (chatCtl === mine) chatCtl = null
      }
    },

    cancelChat() {
      chatCtl?.abort(cancelled())
      chatCtl = null
    },

    cancelAll() {
      master.abort(cancelled())
      master = new AbortController()
      postureCtl.abort(cancelled())
      postureCtl = new AbortController()
      review = null
    },

    cancelPostureData() {
      postureCtl.abort(cancelled())
      postureCtl = new AbortController()
      review = null
    }
  }
}
