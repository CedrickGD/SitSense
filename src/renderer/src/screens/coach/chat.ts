// Pure chat helpers for the Coach (docs/specs/ui-v3.md §4): what is sent to the model,
// suggested prompts, message grouping, and the local history format.

import { AI_CHAT_LIMITS, type AiChatMessage } from '@shared/ai'
import type { ContextPreview } from './context'
import type { CoachContextToggles, CoachMessage } from './types'

// ───────────────────────────── greeting ─────────────────────────────

const joinAnd = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/**
 * The coach's first message, honest about what it can see right now: only rows that are
 * ticked AND have something to share count (live numbers also need the user in view).
 */
export function greetingText(
  toggles: CoachContextToggles,
  previews: Record<keyof CoachContextToggles, ContextPreview>,
  present: boolean
): string {
  const sees = [
    toggles.live && previews.live.available && present ? 'your live posture numbers' : null,
    toggles.today && previews.today.available ? 'today’s stats' : null,
    toggles.baseline && previews.baseline.available ? 'your saved posture' : null
  ].filter((x): x is string => x !== null)
  if (!sees.length) return 'Hi! Ask me anything about your posture, your desk or a stretch — or press *Check my posture now*.'
  return `Hi! I can see ${joinAnd(sees)}. Ask me anything — or press *Check my posture now*.`
}

// ───────────────────────────── what goes to the model ─────────────────────────────

/** Turns sent with each request (main keeps at most AI_CHAT_LIMITS.maxTurns). */
export const SEND_TURNS = 20
/** Per message sent (the composer allows 1000; replies and check summaries are shortened). */
export const SEND_MESSAGE_CHARS = 2000

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

/** A posture-check result as text, so follow-up questions ("why?") have the context. */
export function checkAsText(m: CoachMessage): string {
  const r = m.review
  if (!r) return m.text
  const tips = r.instructions.length ? ` Tips: ${r.instructions.map((t, i) => `${i + 1}. ${t}`).join(' ')}` : ''
  return `Posture check (${r.connectionLabel}, from a ${m.share === 'snapshot' ? 'camera snapshot' : 'pose sketch'}): ${Math.round(r.score)}/100 — ${
    r.verdict === 'good' ? 'looks good' : 'adjust'
  }. ${r.summary}${tips}`
}

/**
 * The conversation as the model sees it: user and assistant turns only (notes and error
 * rows are UI), checks as text, consecutive same-role turns merged, starting with a user
 * turn, the last `turns` turns, each capped. `upTo` = include messages up to this id.
 */
export function toAiMessages(messages: readonly CoachMessage[], opts: { upTo?: string; turns?: number } = {}): AiChatMessage[] {
  const out: AiChatMessage[] = []
  for (const m of messages) {
    let entry: AiChatMessage | null = null
    if (m.role === 'user' && (m.kind === 'text' || m.kind === 'check')) {
      entry = { role: 'user', content: m.kind === 'check' ? 'Please check my posture now.' : m.text }
    } else if (m.role === 'assistant' && m.kind === 'text') {
      entry = { role: 'assistant', content: m.text }
    } else if (m.role === 'assistant' && m.kind === 'check') {
      entry = { role: 'assistant', content: checkAsText(m) }
    }
    if (entry && entry.content.trim()) {
      const last = out[out.length - 1]
      if (last && last.role === entry.role) last.content = `${last.content}\n\n${entry.content}`
      else out.push({ ...entry })
    }
    if (opts.upTo && m.id === opts.upTo) break
  }
  const turns = Math.min(opts.turns ?? SEND_TURNS, AI_CHAT_LIMITS.maxTurns)
  let res = out.slice(-turns)
  while (res.length && res[0].role !== 'user') res = res.slice(1)
  return res.map((m) => ({ role: m.role, content: cut(m.content.trim(), SEND_MESSAGE_CHARS) }))
}

// ───────────────────────────── suggested prompts (§10.4) ─────────────────────────────

export const PROMPT_POOL: readonly string[] = [
  'How’s my posture right now?',
  'What went worst today?',
  'Why does my neck get tired in the afternoon?',
  'Give me a 2-minute stretch for my upper back',
  'How high should my screen be?',
  'Is my chair set up right?',
  'How often should I take breaks?',
  'What does “head forward” actually mean?'
]

/** `count` prompts from the pool, rotated by `seed`, skipping ones already asked. */
export function suggestedPrompts(seed: number, count: number, asked: readonly string[] = []): string[] {
  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const askedSet = new Set(asked.map(norm))
  const fresh = PROMPT_POOL.filter((p) => !askedSet.has(norm(p)))
  const pool = fresh.length >= count ? fresh : [...PROMPT_POOL]
  const start = ((Math.floor(seed) % pool.length) + pool.length) % pool.length
  const out: string[] = []
  for (let k = 0; k < Math.min(count, pool.length); k++) out.push(pool[(start + k) % pool.length])
  return out
}

// ───────────────────────────── list layout ─────────────────────────────

export const GROUP_WINDOW_MS = 2 * 60_000

/** Local calendar-day key of an epoch ms. */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export type ListRow =
  | { t: 'day'; key: string; at: number }
  | { t: 'msg'; m: CoachMessage; /** show the avatar / name / time header */ head: boolean }

/**
 * Messages with day separators; consecutive messages from the same side within 2 min
 * drop the repeated header (§4.2).
 */
export function layoutRows(messages: readonly CoachMessage[]): ListRow[] {
  const rows: ListRow[] = []
  let lastDay = ''
  let prev: CoachMessage | null = null
  for (const m of messages) {
    const dk = dayKey(m.at)
    if (dk !== lastDay) {
      rows.push({ t: 'day', key: dk, at: m.at })
      lastDay = dk
      prev = null
    }
    const sameSide = prev !== null && prev.role === m.role && m.role !== 'system' && prev.kind !== 'error' && m.kind !== 'error'
    const head = !(sameSide && prev !== null && m.at - prev.at <= GROUP_WINDOW_MS && m.kind === 'text' && prev.kind === 'text')
    rows.push({ t: 'msg', m, head })
    prev = m
  }
  return rows
}

/** "Today" / "Yesterday" / null (then the caller shows the date). */
export function relativeDay(at: number, now: number): 'Today' | 'Yesterday' | null {
  if (dayKey(at) === dayKey(now)) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (dayKey(at) === dayKey(y.getTime())) return 'Yesterday'
  return null
}

// ───────────────────────────── local history (§4.7) ─────────────────────────────

export const HISTORY_CAP = 200
export const HISTORY_TEXT_MAX = 6100

const ROLES = new Set(['user', 'assistant', 'system'])
const KINDS = new Set(['text', 'check', 'error', 'note'])
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

/**
 * What is stored: the last 200 messages, never an image or a sketch, no transient rows
 * (inline hints). A conversation with only notes is stored as empty.
 */
export function toStored(messages: readonly CoachMessage[]): CoachMessage[] {
  const keep = messages.filter((m) => !(m.kind === 'note' && m.tone))
  if (!keep.some((m) => m.role !== 'system')) return []
  return keep.slice(-HISTORY_CAP).map((m) => {
    const { sketch: _sketch, ...rest } = m
    void _sketch
    return rest
  })
}

/** Validate stored history field by field; anything malformed is dropped. */
export function fromStored(raw: unknown): CoachMessage[] {
  if (!Array.isArray(raw)) return []
  const out: CoachMessage[] = []
  const seen = new Set<string>()
  for (const r of raw.slice(-HISTORY_CAP)) {
    if (!isObj(r)) continue
    const id = str(r.id, 64)
    const text = str(r.text, HISTORY_TEXT_MAX)
    if (!id || seen.has(id) || text === null || !ROLES.has(r.role as string) || !KINDS.has(r.kind as string)) continue
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue
    const m: CoachMessage = { id, role: r.role as CoachMessage['role'], kind: r.kind as CoachMessage['kind'], text, at: r.at }
    if (m.kind === 'check' && m.role === 'assistant') {
      const v = r.review
      if (
        !isObj(v) ||
        typeof v.score !== 'number' ||
        (v.verdict !== 'good' && v.verdict !== 'adjust') ||
        typeof v.summary !== 'string' ||
        !Array.isArray(v.instructions)
      ) {
        continue
      }
      m.review = {
        ok: true,
        connectionLabel: str(v.connectionLabel, 80) ?? 'AI',
        model: str(v.model, 200) ?? '',
        verdict: v.verdict,
        score: Math.max(0, Math.min(100, v.score)),
        summary: v.summary.slice(0, 400),
        instructions: v.instructions.filter((x): x is string => typeof x === 'string').slice(0, 3).map((x) => x.slice(0, 200))
      }
    }
    if (r.share === 'sketch' || r.share === 'snapshot') m.share = r.share
    if (isObj(r.meta) && typeof r.meta.label === 'string') {
      m.meta = {
        label: r.meta.label.slice(0, 80),
        model: str(r.meta.model, 200) ?? '',
        fallbackFrom: str(r.meta.fallbackFrom, 80)
      }
    }
    if (m.kind === 'error') {
      m.retryOf = typeof r.retryOf === 'string' ? r.retryOf.slice(0, 64) : null
      m.fromModel = r.fromModel === true
    }
    seen.add(id)
    out.push(m)
  }
  return out
}

let idSeq = 0
/** A unique message id. */
export function newMessageId(now = Date.now()): string {
  idSeq = (idSeq + 1) % 1_000_000
  return `${now.toString(36)}-${idSeq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}
