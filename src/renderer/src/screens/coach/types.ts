// Coach chat data model (docs/specs/ui-v3.md §4.2, §4.7). Pure types, shared by the
// store, the persistence layer and the components.

import type { AiShareMode } from '@shared/ai'
import type { AiReviewOk } from '@renderer/state/store'

export type CoachRole = 'user' | 'assistant' | 'system'

/**
 * - `text`  — a normal chat message (user or assistant)
 * - `check` — user: the "Checked my posture" chip · assistant: a posture-check result card
 * - `error` — assistant-side error row (coral tint) with Retry
 * - `note`  — system: a centered note ("Conversation cleared", "Stopped", "Measurements
 *             updated") or, with `tone`, an inline hint ("Resume monitoring to check…")
 */
export type CoachKind = 'text' | 'check' | 'error' | 'note'

/** A pose drawing for the check card's thumbnail: 2D landmark points (null = not seen). */
export interface CheckSketch {
  points: ([number, number] | null)[]
  /** frame width / height */
  aspect: number
}

export interface CoachMessage {
  id: string
  role: CoachRole
  kind: CoachKind
  /** plain text (markdown-lite for assistant text) */
  text: string
  /** epoch ms */
  at: number
  /** assistant `check`: the review (numbers and text only, never the image) */
  review?: AiReviewOk
  /** `check`: what was sent with the review */
  share?: AiShareMode
  /** which model answered (assistant text) */
  meta?: { label: string; model: string; fallbackFrom?: string | null }
  /** `error`: the id of the user message to resend, null = re-run the posture check */
  retryOf?: string | null
  /** `error`: the failure came from the model / connection (offers "Open AI settings") */
  fromModel?: boolean
  /** `note` with a tone renders as an inline hint row instead of a centered caption */
  tone?: 'info'
  /** in memory only — never persisted (the thumbnail of a pose sketch) */
  sketch?: CheckSketch
}

/** The three "What your coach sees" toggles (§4.5), persisted per device. */
export interface CoachContextToggles {
  live: boolean
  today: boolean
  baseline: boolean
}

export const DEFAULT_CONTEXT_TOGGLES: CoachContextToggles = { live: true, today: true, baseline: true }
