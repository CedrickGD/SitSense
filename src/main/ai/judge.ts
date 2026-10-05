// Posture judge (docs/specs/ai-providers.md §5): builds the prompt, asks the enabled
// connections in priority order (25 s each, falling back on failure), and turns the
// model's text into a validated AiPostureReview.

import { AI_LIMITS, type AiConnection, type AiPostureReview, type AiReviewMeasurements, type AiReviewRequest, type AiSettings } from '../../shared/ai'
import { AiError, safeMessage } from './errors'
import { abortable, timeoutSignal } from './http'
import { KEY_REQUIRED, type AdapterSet } from './providers'

export const SYSTEM_PROMPT = [
  'You are an ergonomics coach reviewing the posture of one person seated at a computer.',
  'A webcam sees them from an arbitrary angle: front, angled, side or from above.',
  'Good seated posture: ears roughly over the shoulders; trunk upright or slightly reclined against a backrest; shoulders level and relaxed; head level; gaze roughly horizontal to slightly down.',
  'You also get measurements from an on-device pose model. Treat them as context and override them when the image clearly disagrees.',
  'Respond with JSON only — no prose, no code fences — in exactly this shape:',
  '{"verdict":"good"|"adjust","score":<integer 0-100>,"summary":"<one short sentence>","instructions":["<imperative, at most 12 words>"]}',
  'Give at most 3 instructions, most important first, and none when nothing needs to change.',
  'Speak to the user as "you". Use the user\'s own left and right; never mention the image\'s left or right.'
].join('\n')

const fmtDeg = (v: number | null): string => (v === null ? 'not measurable from this view' : `${Math.round(v * 10) / 10}°`)

export function buildUserPrompt(req: Pick<AiReviewRequest, 'purpose' | 'share' | 'measurements'>): string {
  const m: AiReviewMeasurements = req.measurements
  const image =
    req.share === 'sketch'
      ? 'The image is a pose drawing, not a photo: gray lines and dots are the body on a plain background, and a dashed line marks true vertical through the shoulder.'
      : 'The image is a downscaled webcam snapshot of the user.'
  const purpose =
    req.purpose === 'setup'
      ? 'The user is setting up SitSense: this posture will be saved as their reference. Answer "good" only if it is a healthy posture to keep; otherwise say what to change.'
      : 'The user asked for a quick review of their current posture.'
  const lines = [
    purpose,
    image,
    '',
    'On-device measurements (degrees from the reference direction; null means not measurable):',
    `- camera view: ${m.view}`,
    `- neck forward angle (ear ahead of shoulder): ${fmtDeg(m.neckFwdDeg)}`,
    `- trunk forward lean: ${fmtDeg(m.trunkFwdDeg)}`,
    `- head pitch: ${fmtDeg(m.headPitchDeg)}`,
    `- shoulder tilt: ${fmtDeg(m.shoulderTiltDeg)}`,
    `- head roll: ${fmtDeg(m.headRollDeg)}`,
    `- trunk sideways lean: ${fmtDeg(m.trunkLatDeg)}`,
    `- on-device verdict: ${m.localVerdict}${m.localInstruction ? ` ("${m.localInstruction}")` : ''}`,
    '',
    'Review the posture and answer with the JSON object.'
  ]
  return lines.join('\n')
}

/** Find the first JSON object in model text: tolerates <think> blocks, ``` fences and prose. */
export function extractJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const candidates: string[] = []
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g
  for (let m = fence.exec(t); m; m = fence.exec(t)) candidates.push(m[1])
  candidates.push(t)
  for (const c of candidates) {
    const obj = firstObject(c)
    if (obj !== undefined) return obj
  }
  return undefined
}

function firstObject(text: string): unknown {
  let tries = 0
  for (let start = text.indexOf('{'); start !== -1 && tries < 20; start = text.indexOf('{', start + 1), tries++) {
    const end = matchBrace(text, start)
    if (end === -1) continue
    try {
      const v: unknown = JSON.parse(text.slice(start, end + 1))
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {
      /* try the next '{' */
    }
  }
  return undefined
}

/** index of the brace closing the one at `start`, string-aware; -1 if unbalanced */
function matchBrace(text: string, start: number): number {
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

export interface ParsedReview {
  verdict: 'good' | 'adjust'
  score: number
  summary: string
  instructions: string[]
}

/** Validate + clamp/truncate per AI_LIMITS. Throws AiError('unexpected') when unusable. */
export function parseReview(text: string): ParsedReview {
  const bad = (): AiError => new AiError('unexpected', 'The model’s answer wasn’t a valid review.')
  const obj = extractJson(text)
  if (obj === null || typeof obj !== 'object') throw bad()
  const o = obj as Record<string, unknown>
  const verdictRaw = typeof o.verdict === 'string' ? o.verdict.trim().toLowerCase() : ''
  if (verdictRaw !== 'good' && verdictRaw !== 'adjust') throw bad()
  const scoreNum = typeof o.score === 'number' ? o.score : typeof o.score === 'string' ? Number(o.score.trim()) : NaN
  if (!Number.isFinite(scoreNum)) throw bad()
  const score = Math.round(Math.min(100, Math.max(0, scoreNum)))
  if (typeof o.summary !== 'string' || !o.summary.trim()) throw bad()
  const summary = clip(o.summary, AI_LIMITS.maxSummary)
  const rawInstr: unknown[] = Array.isArray(o.instructions) ? o.instructions : typeof o.instructions === 'string' ? [o.instructions] : []
  const instructions = rawInstr
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .slice(0, AI_LIMITS.maxInstructions)
    .map((x) => clip(x, AI_LIMITS.maxInstruction))
  return { verdict: verdictRaw, score, summary, instructions }
}

export interface JudgeDeps {
  adapters: AdapterSet
  getKey(id: string): string | null
  timeoutMs?: number
  /** aborts every attempt (AI switched off, app quitting) */
  signal?: AbortSignal
}

/** a connection the judge may call right now */
export function isUsable(c: AiConnection): boolean {
  return c.enabled && c.model.trim().length > 0 && (!KEY_REQUIRED.has(c.kind) || c.hasKey) && (c.kind !== 'openai-compatible' || !!c.baseUrl)
}

export async function runReview(ai: AiSettings, req: AiReviewRequest, deps: JudgeDeps): Promise<AiPostureReview> {
  if (!ai.enabled) return { ok: false, message: 'AI review is turned off.' }
  const queue = ai.connections.filter(isUsable)
  if (queue.length === 0) return { ok: false, message: 'No connected AI model is ready — add or enable one in Settings → AI models.' }

  const system = SYSTEM_PROMPT
  const prompt = buildUserPrompt(req)
  const failures: string[] = []
  for (const conn of queue) {
    if (deps.signal?.aborted) break
    const key = deps.getKey(conn.id)
    if (KEY_REQUIRED.has(conn.kind) && !key) {
      failures.push(`${conn.label}: no API key`)
      continue
    }
    const t = timeoutSignal(deps.timeoutMs ?? AI_LIMITS.timeoutMs, deps.signal)
    try {
      const text = await abortable(
        deps.adapters[conn.kind].analyze({ conn, key, system, prompt, imageJpegB64: req.imageJpegB64, signal: t.signal }),
        t.signal
      )
      const r = parseReview(text)
      return { ok: true, connectionLabel: conn.label, model: conn.model, ...r }
    } catch (err) {
      if (err instanceof AiError && err.code === 'cancelled') return { ok: false, message: 'AI review was cancelled.' }
      failures.push(`${conn.label}: ${safeMessage(err, key)}`)
    } finally {
      t.dispose()
    }
  }
  if (deps.signal?.aborted) return { ok: false, message: 'AI review was cancelled.' }
  const detail = failures.join(' · ')
  const message = `${queue.length > 1 ? 'All AI connections failed' : 'AI review failed'} — ${detail}`
  return { ok: false, message: message.length > 400 ? `${message.slice(0, 399)}…` : message }
}
