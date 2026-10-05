// Coach chat (docs/specs/ai-providers.md §7): a friendly ergonomics coach the user can
// ask questions. Builds the system prompt from the validated context, asks the enabled
// connections in priority order (falling back on failure, like the posture judge) and
// returns a cleaned, length-capped markdown-lite reply. Nothing here is ever logged.

import { AI_CHAT_LIMITS, AI_LIMITS, type AiChatContext, type AiChatReply, type AiChatRequest, type AiSettings } from '../../shared/ai'
import { ISSUE_LABELS, ISSUES, type IssueId, type Stage } from '../../shared/posture'
import { AiError, safeMessage } from './errors'
import { abortable, timeoutSignal } from './http'
import { isUsable, type JudgeDeps } from './judge'
import { KEY_REQUIRED } from './providers'

export const CHAT_SYSTEM_PROMPT = [
  'You are the SitSense coach: a friendly, practical ergonomics and posture coach inside SitSense, a Windows app that watches a person\'s sitting posture through their webcam.',
  '',
  'What SitSense does (refer to these features by name when they help):',
  '- An on-device pose model runs on the computer and checks posture several times a second. No video leaves the computer unless the user turned on a connected AI model; even then only a pose sketch or a small snapshot is sent when they ask.',
  '- Posture setup: the app coaches the user into a genuinely good, upright seated posture and saves it as their reference. Deviations from it trigger nudges. Running setup again (Setup / Recalibrate) is right after moving the camera, chair or desk, or if nudges feel wrong.',
  '- It tracks four issues: slouching (sinking down / reclining too far), head forward, leaning to one side, and sitting too close to the screen. Each has stages: slight, clear, severe.',
  '- Nudges are Windows notifications after bad posture holds for a while; Settings adjust sensitivity per issue, the delay, quiet time between nudges, and which stages notify.',
  '- Break reminders: after a continuous sitting stretch (default 50 minutes, adjustable 20–120 in Settings) the app suggests standing up; 3 minutes away from the desk counts as a break.',
  '- Monitoring can be paused from the tray or the app (15 min, 30 min, 1 h, or until resumed).',
  '- The app keeps per-day statistics on this computer: time in good posture, which issues happened when, nudges, breaks and a streak of good days.',
  '',
  'How to answer:',
  '- Be warm, encouraging and concise: usually 2–6 short sentences or a few bullet points. Lead with the most useful, concrete advice.',
  '- Use the SitSense data below when it is relevant ("Right now your head is clearly forward…"); never invent numbers that are not there. If data is missing, say so briefly or answer generally.',
  '- Good seated posture: ears roughly over the shoulders, trunk upright or slightly reclined (about 100–110°) with the lower back supported, shoulders relaxed, feet flat, screen top at or slightly below eye level about an arm\'s length away. Slumping or half-lying in the chair is not good posture even if it feels comfortable.',
  '- Format as plain text with light markdown only: short paragraphs, "- " bullet lists, **bold** for a key phrase. No headings, tables, code blocks, links or emoji.',
  '- Speak to the user as "you" and use their own left and right.',
  '- You are not a doctor. Never diagnose. If the user mentions pain, numbness, tingling, an injury or symptoms that persist, suggest seeing a physiotherapist or doctor, and keep any advice general and gentle.',
  '- Stay on topic: posture, ergonomics, desk setup, breaks, movement and stretches at work, and how to use SitSense. Politely steer other requests back.',
  '- Reply in the language the user writes in.'
].join('\n')

const STAGE_WORDS = ['fine', 'slight', 'clear', 'severe'] as const
const stageWord = (s: Stage): string => STAGE_WORDS[s]
const deg = (v: number | null | undefined): string | null => (v === undefined ? null : v === null ? 'not measurable' : `${v}°`)
const mins = (n: number): string => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`)

function issueLines(rec: Partial<Record<IssueId, number>> | undefined, fmt: (id: IssueId, v: number) => string): string[] {
  if (!rec) return []
  return ISSUES.filter((id) => rec[id] !== undefined).map((id) => fmt(id, rec[id] as number))
}

/** The context block appended to the system prompt; '' when there is nothing to say. */
export function buildContextBlock(ctx: AiChatContext | undefined, now = Date.now()): string {
  if (!ctx) return ''
  const out: string[] = []
  const l = ctx.live
  if (l) {
    const lines: string[] = []
    if (l.presence) lines.push(`at the desk: ${l.presence === 'active' ? 'yes' : 'no (away)'}`)
    if (l.calibrated !== undefined) lines.push(`posture setup done: ${l.calibrated ? 'yes' : 'no — the user has not saved a reference posture yet'}`)
    if (l.view) lines.push(`camera view: ${l.view}`)
    const measures: [string, number | null | undefined][] = [
      ['neck forward angle (ear ahead of shoulder)', l.neckFwdDeg],
      ['trunk forward lean', l.trunkFwdDeg],
      ['head pitch', l.headPitchDeg],
      ['shoulder tilt', l.shoulderTiltDeg],
      ['head roll', l.headRollDeg],
      ['trunk sideways lean', l.trunkLatDeg]
    ]
    for (const [name, v] of measures) {
      const d = deg(v)
      if (d) lines.push(`${name}: ${d}`)
    }
    lines.push(...issueLines(l.issues, (id, s) => `${ISSUE_LABELS[id].toLowerCase()}: ${stageWord(s as Stage)}`))
    if (l.worstStage !== undefined) lines.push(`overall: ${l.worstStage === 0 ? 'aligned' : `${stageWord(l.worstStage)} issue`}`)
    if (l.localVerdict) lines.push(`on-device verdict: ${l.localVerdict}${l.localInstruction ? ` ("${l.localInstruction}")` : ''}`)
    if (l.sittingMinutes !== undefined) lines.push(`sitting without a break for: ${mins(l.sittingMinutes)}`)
    if (lines.length) out.push('Right now (live, from the on-device model; degrees are deviations measured by the app):', ...lines.map((x) => `- ${x}`))
  }
  const t = ctx.today
  if (t) {
    const lines: string[] = []
    if (t.trackedMinutes !== undefined) lines.push(`time measured at the desk: ${mins(t.trackedMinutes)}`)
    if (t.goodMinutes !== undefined) {
      const pct = t.trackedMinutes ? ` (${Math.round((t.goodMinutes / t.trackedMinutes) * 100)} %)` : ''
      lines.push(`in good posture: ${mins(t.goodMinutes)}${pct}`)
    }
    lines.push(...issueLines(t.minutesByIssue, (id, n) => `${ISSUE_LABELS[id].toLowerCase()}: ${mins(n)}`))
    if (t.awayMinutes !== undefined) lines.push(`away from the desk: ${mins(t.awayMinutes)}`)
    if (t.alertsCount !== undefined) lines.push(`nudges shown: ${t.alertsCount}`)
    if (t.breaksTaken !== undefined) lines.push(`breaks taken: ${t.breaksTaken}`)
    if (lines.length) out.push('Today so far:', ...lines.map((x) => `- ${x}`))
  }
  const h = ctx.history
  if (h) {
    const lines: string[] = []
    const span = h.days ? `last ${h.days} days` : 'recent days'
    if (h.alignedShare !== undefined) lines.push(`${span}: ${h.alignedShare === null ? 'no data' : `${Math.round(h.alignedShare * 100)} % of measured time in good posture`}`)
    if (h.streakDays !== undefined) lines.push(`streak of good days: ${h.streakDays}`)
    if (lines.length) out.push('History:', ...lines.map((x) => `- ${x}`))
  }
  const b = ctx.baseline
  if (b) {
    const lines: string[] = []
    if (b.capturedAt !== undefined) {
      const days = Math.max(0, Math.floor((now - b.capturedAt) / 86_400_000))
      lines.push(`saved ${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}`)
    }
    if (b.view) lines.push(`camera view at setup: ${b.view}`)
    if (b.verified !== undefined) lines.push(b.verified ? 'confirmed as good posture' : 'saved without confirmation')
    for (const [name, v] of [
      ['neck forward angle', b.neckFwdDeg],
      ['trunk forward lean', b.trunkFwdDeg],
      ['head pitch', b.headPitchDeg]
    ] as const) {
      const d = deg(v)
      if (d) lines.push(`${name}: ${d}`)
    }
    if (lines.length) out.push('Saved reference posture:', ...lines.map((x) => `- ${x}`))
  }
  if (ctx.recentAlerts?.length) {
    out.push(
      'Recent nudges (newest first):',
      ...ctx.recentAlerts.map((a) => `- ${ISSUE_LABELS[a.issue].toLowerCase()}, ${stageWord(a.stage)}, ${a.minutesAgo === 0 ? 'just now' : `${mins(a.minutesAgo)} ago`}`)
    )
  }
  return out.join('\n')
}

export function buildChatSystemPrompt(req: Pick<AiChatRequest, 'context' | 'image'>, now = Date.now()): string {
  const parts = [CHAT_SYSTEM_PROMPT]
  const ctx = buildContextBlock(req.context, now)
  parts.push('', 'SitSense data for this conversation:', ctx || '- none available')
  if (req.image) {
    parts.push(
      '',
      req.image.share === 'sketch'
        ? 'The user\'s newest message comes with a pose drawing (not a photo): gray lines and dots are their body on a plain background, and a dashed line marks true vertical through the shoulder.'
        : 'The user\'s newest message comes with a downscaled webcam snapshot of them at their desk.'
    )
  }
  return parts.join('\n')
}

/** strip reasoning blocks, tidy whitespace, cap the length */
export function cleanReply(text: string): string {
  let t = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '') // an unterminated reasoning block holds no answer
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (t.length > AI_CHAT_LIMITS.maxReplyChars) t = `${t.slice(0, AI_CHAT_LIMITS.maxReplyChars - 1).trimEnd()}…`
  return t
}

export async function runChat(ai: AiSettings, req: AiChatRequest, deps: JudgeDeps & { now?: () => number }): Promise<AiChatReply> {
  if (!ai.enabled) return { ok: false, message: 'The AI coach is turned off.' }
  const queue = ai.connections.filter(isUsable)
  if (queue.length === 0) return { ok: false, message: 'No connected AI model is ready — add or enable one in Settings → AI models.' }

  const system = buildChatSystemPrompt(req, deps.now?.() ?? Date.now())
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
        deps.adapters[conn.kind].chat({ conn, key, system, messages: req.messages, imageJpegB64: req.image?.jpegB64, signal: t.signal }),
        t.signal
      )
      const reply = cleanReply(text)
      if (!reply) throw new AiError('unexpected', 'The model returned an empty answer.')
      return { ok: true, reply, connectionLabel: conn.label, model: conn.model }
    } catch (err) {
      if (err instanceof AiError && err.code === 'cancelled') return { ok: false, message: 'The coach was interrupted.' }
      failures.push(`${conn.label}: ${safeMessage(err, key)}`)
    } finally {
      t.dispose()
    }
  }
  if (deps.signal?.aborted) return { ok: false, message: 'The coach was interrupted.' }
  const message = `${queue.length > 1 ? 'All AI connections failed' : 'The coach couldn’t answer'} — ${failures.join(' · ')}`
  return { ok: false, message: message.length > 400 ? `${message.slice(0, 399)}…` : message }
}
