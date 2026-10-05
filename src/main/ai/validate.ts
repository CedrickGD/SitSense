// Validation of every AI IPC payload coming from the renderer (docs/specs/ai-providers.md §4).
// Errors are AiError('invalid-input') with a short message; none ever echoes a key.

import {
  AI_CHAT_LIMITS,
  AI_LIMITS,
  AI_PROVIDER_KINDS,
  type AiChatBaselineContext,
  type AiChatContext,
  type AiChatDayContext,
  type AiChatHistoryContext,
  type AiChatLiveContext,
  type AiChatMessage,
  type AiChatRecentAlert,
  type AiChatRequest,
  type AiProviderKind,
  type AiReviewMeasurements,
  type AiReviewRequest
} from '../../shared/ai'
import { ISSUES, type IssueId, type Stage, type ViewKind } from '../../shared/posture'
import { AiError, isLocalHost } from './errors'

const invalid = (msg: string): AiError => new AiError('invalid-input', msg)
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

export function validateKind(v: unknown): AiProviderKind {
  if (typeof v !== 'string' || !(AI_PROVIDER_KINDS as readonly string[]).includes(v)) throw invalid('Unknown provider type.')
  return v as AiProviderKind
}

export function validateId(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64 || CONTROL.test(v)) throw invalid('Invalid connection id.')
  return v
}

export function validateLabel(v: unknown): string {
  if (typeof v !== 'string') throw invalid('The name must be text.')
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) throw invalid('Enter a name for this connection.')
  if (t.length > AI_LIMITS.maxLabel) throw invalid(`The name can be at most ${AI_LIMITS.maxLabel} characters.`)
  return t
}

export function validateModel(v: unknown): string {
  if (typeof v !== 'string') throw invalid('The model must be text.')
  const t = v.trim()
  if (t.length > AI_LIMITS.maxModel) throw invalid(`The model id can be at most ${AI_LIMITS.maxModel} characters.`)
  if (CONTROL.test(t) || /\s/.test(t)) throw invalid('The model id can’t contain spaces.')
  return t
}

/**
 * https:// anywhere, http:// only for localhost / 127.0.0.1 / [::1]. No credentials,
 * query or fragment. Returns the normalized URL without trailing slashes, or null when empty.
 */
export function validateBaseUrl(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw invalid('The base URL must be text.')
  const t = v.trim()
  if (!t) return null
  if (t.length > AI_LIMITS.maxBaseUrl) throw invalid('The base URL is too long.')
  let u: URL
  try {
    u = new URL(t)
  } catch {
    throw invalid('Enter a full URL, like https://example.com/v1.')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw invalid('The base URL must start with https://.')
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) throw invalid('Use https:// — plain http:// is only allowed for localhost.')
  if (u.username || u.password) throw invalid('Don’t put a username or password in the URL — use the API key field.')
  if (u.search || u.hash) throw invalid('The base URL can’t contain ? or #.')
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
}

/** undefined = keep, null = delete, string = set. An empty/blank string means keep. */
export function validateKeyInput(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return v
  if (typeof v !== 'string') throw invalid('The API key must be text.')
  const t = v.trim()
  if (!t) return undefined
  if (t.length > AI_LIMITS.maxKey) throw invalid('The API key is too long.')
  // keys travel in HTTP headers: printable ASCII only, no spaces
  if (!/^[\x21-\x7e]+$/.test(t)) throw invalid('The API key contains spaces or characters that aren’t allowed — paste it again.')
  return t
}

export function validateDelta(v: unknown): -1 | 1 {
  if (v !== -1 && v !== 1) throw invalid('Move by -1 or 1.')
  return v
}

/** decoded byte length of strict base64 (no data: prefix, no whitespace), or -1 if malformed */
export function base64ByteLength(b64: string): number {
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return -1
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return (b64.length / 4) * 3 - pad
}

/** base64 JPEG (no data: prefix) of at most AI_LIMITS.maxImageBytes */
export function validateJpegB64(img: unknown): string {
  if (typeof img !== 'string') throw invalid('The image is missing.')
  // cheap length check before the regex so a huge string is rejected fast
  if (img.length > Math.ceil(AI_LIMITS.maxImageBytes / 3) * 4) throw invalid('The image is too large.')
  const bytes = base64ByteLength(img)
  if (bytes < 0) throw invalid('The image must be base64 without a data: prefix.')
  if (bytes > AI_LIMITS.maxImageBytes) throw invalid('The image is too large.')
  // JPEG magic FF D8 FF  → base64 "/9j/"
  if (!img.startsWith('/9j/')) throw invalid('The image must be a JPEG.')
  return img
}

const finiteOrNull = (v: unknown, name: string): number | null => {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 360) throw invalid(`Invalid measurement: ${name}.`)
  return v
}

export function validateReviewRequest(v: unknown): AiReviewRequest {
  if (!isObj(v)) throw invalid('Invalid review request.')
  if (v.purpose !== 'setup' && v.purpose !== 'check') throw invalid('Invalid review purpose.')
  if (v.share !== 'sketch' && v.share !== 'snapshot') throw invalid('Invalid share mode.')
  const img = validateJpegB64(v.imageJpegB64)
  const m = v.measurements
  if (!isObj(m)) throw invalid('Measurements are missing.')
  if (m.view !== 'front' && m.view !== 'angled' && m.view !== 'side') throw invalid('Invalid measurement: view.')
  if (m.localVerdict !== 'good' && m.localVerdict !== 'adjust') throw invalid('Invalid measurement: localVerdict.')
  let localInstruction: string | null = null
  if (m.localInstruction !== null && m.localInstruction !== undefined) {
    if (typeof m.localInstruction !== 'string') throw invalid('Invalid measurement: localInstruction.')
    localInstruction = m.localInstruction.replace(/\s+/g, ' ').trim().slice(0, 200) || null
  }
  const measurements: AiReviewMeasurements = {
    view: m.view,
    neckFwdDeg: finiteOrNull(m.neckFwdDeg, 'neckFwdDeg'),
    trunkFwdDeg: finiteOrNull(m.trunkFwdDeg, 'trunkFwdDeg'),
    headPitchDeg: finiteOrNull(m.headPitchDeg, 'headPitchDeg'),
    shoulderTiltDeg: finiteOrNull(m.shoulderTiltDeg, 'shoulderTiltDeg'),
    headRollDeg: finiteOrNull(m.headRollDeg, 'headRollDeg'),
    trunkLatDeg: finiteOrNull(m.trunkLatDeg, 'trunkLatDeg'),
    localVerdict: m.localVerdict,
    localInstruction
  }
  return { purpose: v.purpose, share: v.share, imageJpegB64: img, measurements }
}

/** Generic settings patches from the renderer must not touch ai.connections (dedicated IPC only). */
export function stripAiConnections(patch: unknown): unknown {
  if (!isObj(patch) || !('ai' in patch)) return patch
  const ai = patch.ai
  if (!isObj(ai)) {
    // ai: null / [] / scalar would replace the whole object (and its connections) — drop it
    const { ai: _drop, ...rest } = patch
    void _drop
    return rest
  }
  if (!('connections' in ai)) return patch
  const { connections: _c, ...aiRest } = ai
  void _c
  return { ...patch, ai: aiRest }
}

// ── coach chat (docs/specs/ai-providers.md §7) ──

// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_WS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** text as the model will see it: no control chars (newlines/tabs kept), CRLF → LF, trimmed */
function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_WS, '').trim()
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

const tooLong = (): AiError => invalid(`Your message is too long (at most ${AI_CHAT_LIMITS.maxMessageChars} characters).`)

/**
 * Messages every provider accepts: user first, roles alternating (consecutive same-role
 * turns are merged), ending with the user's new message, at most maxTurns. The newest
 * user message is refused above maxMessageChars; older turns are cut instead.
 */
export function validateChatMessages(v: unknown): AiChatMessage[] {
  if (!Array.isArray(v) || v.length === 0) throw invalid('Ask a question first.')
  if (v.length > AI_CHAT_LIMITS.maxRawMessages) throw invalid('The conversation is too long — start a new chat.')
  const newest = v[v.length - 1]
  if (!isObj(newest) || newest.role !== 'user') throw invalid('Ask a question first.')
  const raw: AiChatMessage[] = []
  for (let i = 0; i < v.length; i++) {
    const m = v[i]
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw invalid('Invalid chat message.')
    }
    const isNewest = i === v.length - 1
    // cheap guard before cleaning a huge string
    if (isNewest && m.content.length > AI_CHAT_LIMITS.maxMessageChars * 2) throw tooLong()
    const text = cleanText(m.content.slice(0, AI_CHAT_LIMITS.maxMessageChars * 2))
    if (isNewest) {
      if (!text) throw invalid('Ask a question first.')
      if (text.length > AI_CHAT_LIMITS.maxMessageChars) throw tooLong()
    }
    if (text) raw.push({ role: m.role, content: cut(text, AI_CHAT_LIMITS.maxMessageChars) })
  }
  const merged: AiChatMessage[] = []
  for (const m of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n\n${m.content}`
    else merged.push({ ...m })
  }
  let out = merged.slice(-AI_CHAT_LIMITS.maxTurns)
  while (out.length > 0 && out[0].role !== 'user') out = out.slice(1)
  // a merged turn may exceed the per-message cap: keep its newest part
  return out.map((m) =>
    m.content.length > AI_CHAT_LIMITS.maxMessageChars ? { ...m, content: `…${m.content.slice(-(AI_CHAT_LIMITS.maxMessageChars - 1))}` } : m
  )
}

const VIEWS: readonly ViewKind[] = ['front', 'angled', 'side']

const optNum = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined
const round1 = (n: number | undefined): number | undefined => (n === undefined ? undefined : Math.round(n * 10) / 10)
const optDeg = (v: unknown): number | null | undefined => (v === null ? null : round1(optNum(v, -360, 360)))
/** a whole count (minutes, alerts, days), at most a week of minutes */
const optCount = (v: unknown, max = 60 * 24 * 7): number | undefined => {
  const n = optNum(v, 0, max)
  return n === undefined ? undefined : Math.round(n)
}
const optStage = (v: unknown): Stage | undefined => (v === 0 || v === 1 || v === 2 || v === 3 ? v : undefined)
const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const optView = (v: unknown): ViewKind | undefined => VIEWS.find((x) => x === v)

/** drop undefined fields; undefined when nothing is left */
function compact<T extends object>(o: T): T | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T
  return Object.keys(out).length > 0 ? out : undefined
}

function issueRecord<T>(v: unknown, pick: (x: unknown) => T | undefined): Partial<Record<IssueId, T>> | undefined {
  if (!isObj(v)) return undefined
  const out: Partial<Record<IssueId, T>> = {}
  for (const id of ISSUES) {
    const x = pick(v[id])
    if (x !== undefined) out[id] = x
  }
  return compact(out)
}

function sanitizeLive(l: Record<string, unknown>): AiChatLiveContext | undefined {
  let localInstruction: string | null | undefined
  if (typeof l.localInstruction === 'string') localInstruction = cleanText(l.localInstruction).replace(/\s+/g, ' ').slice(0, 200) || null
  else if (l.localInstruction === null) localInstruction = null
  return compact<AiChatLiveContext>({
    presence: l.presence === 'active' || l.presence === 'away' ? l.presence : undefined,
    calibrated: optBool(l.calibrated),
    view: optView(l.view),
    neckFwdDeg: optDeg(l.neckFwdDeg),
    trunkFwdDeg: optDeg(l.trunkFwdDeg),
    headPitchDeg: optDeg(l.headPitchDeg),
    shoulderTiltDeg: optDeg(l.shoulderTiltDeg),
    headRollDeg: optDeg(l.headRollDeg),
    trunkLatDeg: optDeg(l.trunkLatDeg),
    issues: issueRecord(l.issues, optStage),
    worstStage: optStage(l.worstStage),
    localVerdict: l.localVerdict === 'good' || l.localVerdict === 'adjust' ? l.localVerdict : undefined,
    localInstruction,
    sittingMinutes: optCount(l.sittingMinutes)
  })
}

/**
 * Context is advisory: malformed or unknown fields are dropped, never an error, so a
 * renderer on a newer shape still gets an answer. Only enums, booleans and bounded
 * numbers survive (plus the app's own ≤ 200-char coaching line), which keeps the
 * prompt small and leaves the renderer nothing free-form to steer it with.
 */
export function sanitizeChatContext(v: unknown): AiChatContext | undefined {
  if (!isObj(v)) return undefined
  const live = isObj(v.live) ? sanitizeLive(v.live) : undefined
  const t = isObj(v.today) ? v.today : null
  const today = t
    ? compact<AiChatDayContext>({
        trackedMinutes: optCount(t.trackedMinutes),
        goodMinutes: optCount(t.goodMinutes),
        awayMinutes: optCount(t.awayMinutes),
        minutesByIssue: issueRecord(t.minutesByIssue, (x) => optCount(x)),
        alertsCount: optCount(t.alertsCount),
        breaksTaken: optCount(t.breaksTaken)
      })
    : undefined
  const h = isObj(v.history) ? v.history : null
  const history = h
    ? compact<AiChatHistoryContext>({
        days: optCount(h.days, 90),
        alignedShare: h.alignedShare === null ? null : optNum(h.alignedShare, 0, 1) === undefined ? undefined : Math.round((h.alignedShare as number) * 100) / 100,
        streakDays: optCount(h.streakDays, 3650)
      })
    : undefined
  const b = isObj(v.baseline) ? v.baseline : null
  const baseline = b
    ? compact<AiChatBaselineContext>({
        capturedAt: optCount(b.capturedAt, 8.64e15),
        view: optView(b.view),
        verified: optBool(b.verified),
        neckFwdDeg: optDeg(b.neckFwdDeg),
        trunkFwdDeg: optDeg(b.trunkFwdDeg),
        headPitchDeg: optDeg(b.headPitchDeg)
      })
    : undefined
  let recentAlerts: AiChatRecentAlert[] | undefined
  if (Array.isArray(v.recentAlerts)) {
    const list: AiChatRecentAlert[] = []
    for (const a of v.recentAlerts.slice(0, AI_CHAT_LIMITS.maxRecentAlerts * 4)) {
      if (!isObj(a)) continue
      const issue = ISSUES.find((id) => id === a.issue)
      const stage = optStage(a.stage)
      const minutesAgo = optCount(a.minutesAgo)
      if (!issue || stage === undefined || minutesAgo === undefined) continue
      list.push({ issue, stage, minutesAgo })
      if (list.length >= AI_CHAT_LIMITS.maxRecentAlerts) break
    }
    if (list.length > 0) recentAlerts = list
  }
  return compact<AiChatContext>({ live, today, history, baseline, recentAlerts })
}

export function validateChatRequest(v: unknown): AiChatRequest {
  if (!isObj(v)) throw invalid('Invalid chat request.')
  const messages = validateChatMessages(v.messages)
  const context = sanitizeChatContext(v.context)
  let image: AiChatRequest['image']
  if (v.image !== undefined && v.image !== null) {
    if (!isObj(v.image)) throw invalid('Invalid image.')
    if (v.image.share !== 'sketch' && v.image.share !== 'snapshot') throw invalid('Invalid share mode.')
    image = { jpegB64: validateJpegB64(v.image.jpegB64), share: v.image.share }
  }
  return { messages, ...(context ? { context } : {}), ...(image ? { image } : {}) }
}
