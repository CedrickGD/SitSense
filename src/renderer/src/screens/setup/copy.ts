// Copy and small decisions for the posture-setup flow (docs/specs/ui-v3.md §7, §10.6).
// Pure — unit-tested in __tests__/copy.test.ts. The UI renders what detection reports
// (§11): nothing here judges a posture, it only words and arranges the verdicts.

import type { ViewKind } from '@shared/posture'
import type { Settings } from '@shared/settings'
import { aiAvailable, aiReviewsSetup, primaryAiConnection } from '@renderer/ai/helpers'
import { ESSENTIAL_CHECKS, type CheckId } from '@renderer/posture/assess'
import type { BaselineSummary, DetectorError, SetupCheckUi, SetupUiState } from '@renderer/state/store'
import type { SetupProbeState } from '@renderer/detection/setup-ui'

export const VIEW_LABEL: Record<ViewKind, string> = {
  front: 'Front view',
  angled: 'Angled view',
  side: 'Side view · works great'
}

/** Short view names for the glass chip on the camera. */
export const VIEW_CHIP: Record<ViewKind, string> = {
  front: 'Front view',
  angled: 'Angled view',
  side: 'Side view'
}

export const SEARCHING_COPY = 'Sit where you normally work.'
export const SEARCHING_SUB = 'Your head and at least one shoulder need to be in the picture.'
/** the panel headline while a reviewer is asked — the card below says who (§7.5) */
export const REVIEWING_COPY = 'Stay like this.'
export const HOLD_STILL_COPY = "That's it — hold still."
export const CAMERA_STARTING_COPY = 'Getting the camera ready…'
/** "Save anyway" never shows before this much coaching (§7.3) */
export const FORCE_VISIBLE_AFTER_MS = 20_000

const FAIL_FALLBACK = {
  unstable: 'Hold still for a moment.',
  lost: 'Lost sight of you — sit back in view.'
} as const

export type PrimaryTone = 'normal' | 'fail' | 'blocked'

export interface PrimaryCopy {
  /** the one big sentence */
  text: string
  /** a smaller line under it, or null */
  sub: string | null
  tone: PrimaryTone
  /** "Suggested by <model>" when the instruction came from the cloud reviewer */
  attribution: string | null
}

export interface ScreenEnv {
  paused: boolean
  cameraError: boolean
  detectorError: DetectorError
  /** the camera and detector are delivering frames (default true) */
  running?: boolean
  /** whether an AI model reviews setup (aiSetupState); only 'on' can confirm what the camera can't */
  ai?: AiSetupState
}

/**
 * Why an essential can't be checked when only the camera view (or an AI model) can fix it
 * (§7.4.1): 'hips' = hips hidden or outside the picture · 'front' = the trunk lean can't
 * be judged from straight in front · null = the session's own instruction can still
 * unblock it (an adjust row, or "sit back and look ahead" when two readings disagree).
 */
export function cameraFix(setup: SetupUiState): 'hips' | 'front' | null {
  if (unverifiedEssentials(setup).length === 0) return null
  // something the user CAN change comes first
  if (setup.checks.some((c) => c.status === 'adjust' && c.id !== 'inView')) return null
  const ins = setup.instruction ?? ''
  if (/hips are hidden|hips are in the picture|tilt the camera down/i.test(ins)) return 'hips'
  if (/straight in front/i.test(ins)) return 'front'
  if (/sit back against your backrest and look/i.test(ins)) return null
  return setup.view === 'front' ? 'front' : 'hips'
}

export const CAMERA_FIX_COPY = {
  hips: {
    text: "I can't see your hips from here.",
    sub: "So I can't check whether you're slumped. Tilt the camera down a little or sit a bit farther back — or let an AI model check it.",
    note: 'Show the camera your hips, or let an AI model check your back.'
  },
  front: {
    text: "I can't judge your back angle from straight in front.",
    sub: 'Turn the camera a little to the side — or let an AI model check it.',
    note: 'Turn the camera a little to the side, or let an AI model check your back.'
  }
} as const

/** The primary copy is a camera-view fix, not a posture instruction (no "Suggested by"). */
export function isCameraFixCopy(text: string): boolean {
  return text === CAMERA_FIX_COPY.hips.text || text === CAMERA_FIX_COPY.front.text
}

/** Saving is on hold after repeated rejections and the reviewer's point is what's left. */
function onHoldCopy(setup: SetupUiState): PrimaryCopy | null {
  const r = setup.reviewResult
  if (setup.autoCapture || !r || r.verdict !== 'adjust') return null
  const ins = r.instructions[0] ?? r.summary
  // the on-device judge has its own, different fix: that one first
  if (setup.instruction !== null && setup.instruction !== ins) return null
  return { text: `${r.label} still sees a problem`, sub: ins, tone: 'normal', attribution: null }
}

/** Nobody in view yet (or the camera is still starting): only the In view row matters. */
export function waitingForView(setup: SetupUiState): boolean {
  if (setup.phase === 'idle') return true
  if (setup.phase !== 'searching') return false
  return setup.checks.find((c) => c.id === 'inView')?.status !== 'good'
}

/** Copy for states in which setup can't run at all (paused, camera, detector), else null. */
export function blockedCopy(setup: Pick<SetupUiState, 'suspended'>, env: ScreenEnv): PrimaryCopy | null {
  const plain = (text: string, sub: string): PrimaryCopy => ({ text, sub, tone: 'blocked', attribution: null })
  if (env.paused || setup.suspended === 'paused') {
    return plain('Monitoring is paused.', 'Setup needs the camera. It carries on as soon as you resume.')
  }
  if (env.cameraError) return plain("SitSense can't see your camera right now.", 'Setup carries on by itself once the camera is back.')
  if (env.detectorError === 'model') return plain("SitSense couldn't load its posture model.", 'It keeps trying in the background.')
  if (env.detectorError === 'inference') return plain('Detection stopped — restarting…', 'This usually takes a few seconds.')
  return null
}

/** The coach panel's primary instruction for the current state. */
export function primaryCopy(setup: SetupUiState, env: ScreenEnv): PrimaryCopy {
  const plain = (text: string, sub: string | null = null, tone: PrimaryTone = 'normal'): PrimaryCopy => ({
    text,
    sub,
    tone,
    attribution: null
  })

  if (setup.phase === 'done') {
    return setup.saveError
      ? plain("Couldn't save your posture.", 'Redo setup to try again.', 'fail')
      : plain('This is your good posture.')
  }
  const blocked = blockedCopy(setup, env)
  if (blocked) return blocked

  switch (setup.phase) {
    case 'idle':
      return plain(CAMERA_STARTING_COPY)
    case 'failed':
      return plain(
        setup.failMessage ?? (setup.failReason ? FAIL_FALLBACK[setup.failReason] : FAIL_FALLBACK.unstable),
        'No problem — setup picks up again by itself.',
        'fail'
      )
    case 'reviewing':
      // the capture is taken: live instructions would only contradict "stay like this"
      return plain(REVIEWING_COPY)
    case 'holding':
    case 'capturing':
      return withAttribution(setup, setup.instruction ?? HOLD_STILL_COPY)
    case 'searching':
    case 'coaching':
    default: {
      if (setup.phase === 'searching') {
        // out of view, the In view instruction would only repeat the checklist — say where to sit
        if (env.running === false) return plain(CAMERA_STARTING_COPY)
        if (waitingForView(setup) || !setup.instruction) return plain(SEARCHING_COPY, SEARCHING_SUB)
      }
      // sitting taller can't make the back checkable from this camera: say what can
      // (§7.4.1). With an AI model on, "sit tall" stays — the model really does judge it.
      const fix = env.ai === 'on' ? null : cameraFix(setup)
      if (fix) return plain(CAMERA_FIX_COPY[fix].text, CAMERA_FIX_COPY[fix].sub)
      const hold = onHoldCopy(setup)
      if (hold) return hold
      if (setup.phase === 'searching' && setup.instruction) return plain(setup.instruction)
      return withAttribution(setup, setup.instruction ?? 'One moment — SitSense is taking a look.')
    }
  }
}

function withAttribution(setup: SetupUiState, text: string): PrimaryCopy {
  const r = setup.reviewResult
  const fromReviewer =
    r !== null && r.verdict === 'adjust' && setup.instruction !== null && setup.instruction === (r.instructions[0] ?? r.summary)
  return { text, sub: null, tone: 'normal', attribution: fromReviewer ? `Suggested by ${r.label}` : null }
}

/**
 * A long instruction reads better as a big imperative plus a smaller reason: "Sit back —
 * let your back rest against the chair." → "Sit back" + "Let your back rest against the
 * chair." Only splits at the first " — " when the head stays short; "That's it — hold
 * still." stays whole.
 */
export function splitInstruction(text: string): { head: string; sub: string | null } {
  if (text === HOLD_STILL_COPY) return { head: text, sub: null }
  const i = text.indexOf(' — ')
  if (i < 6 || i > 64) return { head: text, sub: null }
  const rest = text.slice(i + 3).trim()
  if (rest.length < 6) return { head: text, sub: null }
  return { head: text.slice(0, i).trim(), sub: rest.charAt(0).toUpperCase() + rest.slice(1) }
}

/** Which progress widget the panel shows. */
export function progressKind(setup: SetupUiState): 'hold' | 'capture' | 'review' | null {
  switch (setup.phase) {
    case 'holding':
      return 'hold'
    case 'capturing':
      return 'capture'
    case 'reviewing':
      return 'review'
    default:
      return null
  }
}

// ───────────────────────────── checklist ─────────────────────────────

/** In view plus the checks a good posture must pass (assess.ts ESSENTIAL_CHECKS). */
export const ESSENTIALS: readonly CheckId[] = ['inView', ...ESSENTIAL_CHECKS]

/**
 * How a checklist row is shown (§7.3): 'good' ✓ · 'adjust' ◐ + short hint (blocks) ·
 * 'unverified' ! "can't check yet" (an essential the camera can't measure — blocks) ·
 * 'na' – "not visible from here" (doesn't block) · 'pending' while nobody is in view.
 */
export type RowKind = 'good' | 'adjust' | 'unverified' | 'na' | 'pending'

export function rowKind(c: SetupCheckUi, waiting: boolean): RowKind {
  if (waiting) return c.id === 'inView' ? (c.status === 'good' ? 'good' : 'adjust') : 'pending'
  if (c.status === 'good') return 'good'
  if (c.status === 'adjust') return 'adjust'
  return ESSENTIALS.includes(c.id) ? 'unverified' : 'na'
}

const HINTS: Array<[RegExp, string]> = [
  [/lying|sliding down/i, 'sit up tall'],
  [/^sit up/i, 'sit up a little'],
  [/^sit back/i, 'sit back'],
  [/head back/i, 'head back'],
  [/head and at least one shoulder|in the picture/i, 'move into view'],
  [/leaning to your/i, 'center your weight'],
  [/shoulder is raised/i, 'relax your shoulder'],
  [/straighten your head/i, 'straighten your head'],
  [/lift your gaze/i, 'lift your gaze'],
  [/lower your chin/i, 'lower your chin']
]

/** A 1–3 word status for an 'adjust' row, e.g. "sit back". */
export function shortHint(c: Pick<SetupCheckUi, 'instruction'>): string {
  const ins = c.instruction ?? ''
  for (const [re, hint] of HINTS) if (re.test(ins)) return hint
  const first = ins.split(/ — |[,.]/)[0]?.trim() ?? ''
  if (first.length > 0 && first.length <= 22) return first.charAt(0).toLowerCase() + first.slice(1)
  return 'adjust'
}

export function rowStatusText(kind: RowKind, c: SetupCheckUi): string {
  switch (kind) {
    case 'adjust':
      return shortHint(c)
    case 'unverified':
      return "can't check yet"
    case 'na':
      return 'not visible from here'
    default:
      return ''
  }
}

/** "Essentials checked: 2 of 3" — essentials that are verified good. */
export function essentialsChecked(checks: readonly SetupCheckUi[]): { done: number; total: number } {
  const ess = checks.filter((c) => ESSENTIALS.includes(c.id))
  return { done: ess.filter((c) => c.status === 'good').length, total: ESSENTIALS.length }
}

/** Essential checks the camera can't measure right now (in view only). */
export function unverifiedEssentials(setup: SetupUiState): CheckId[] {
  if (waitingForView(setup)) return []
  if (setup.phase === 'reviewing' || setup.phase === 'done') return setup.unverifiedChecks.filter((id) => ESSENTIALS.includes(id))
  return setup.checks.filter((c) => c.status === 'unknown' && ESSENTIALS.includes(c.id)).map((c) => c.id)
}

// ───────────────────────────── target figure ─────────────────────────────

/**
 * What the target figure highlights: the body part the primary instruction is about.
 * 'lying' = sliding down / lying in the chair · 'back' = leaning forward · 'recline' =
 * leaning far back · 'head' = head forward / gaze · 'hips' = the camera can't check the
 * back (show the hips / sit tall) · 'side' = lateral issues · null = nothing to fix.
 */
export type GuideFocus = 'lying' | 'back' | 'recline' | 'head' | 'hips' | 'side' | null

export function guideFocus(setup: SetupUiState): GuideFocus {
  if (waitingForView(setup)) return null
  const ins = setup.instruction ?? ''
  if (/lying|sliding down/i.test(ins)) return 'lying'
  const first = setup.checks.find((c) => c.status === 'adjust')
  if (first) {
    switch (first.id) {
      case 'trunkUpright':
        return /^sit up/i.test(first.instruction ?? '') ? 'recline' : 'back'
      case 'headOverShoulders':
      case 'gaze':
      case 'headLevel':
        return 'head'
      case 'sideLean':
      case 'shouldersLevel':
        return 'side'
      default:
        return null
    }
  }
  if (setup.needsVerification || unverifiedEssentials(setup).length > 0) return 'hips'
  return null
}

/** The target card's one line for each focus. */
export const GUIDE_LINE: Record<Exclude<GuideFocus, null> | 'none', string> = {
  none: 'Hips all the way back, back against the backrest, ears over your shoulders.',
  lying: 'Hips back to the backrest, then sit up tall — your back carries you, not the chair edge.',
  back: 'Let your back rest against the chair instead of leaning toward the screen.',
  recline: 'Come up from the recline until your back is close to upright.',
  head: 'Stack your ears over your shoulders — chin level, eyes on the middle of the screen.',
  hips: 'Hips all the way back, back against the backrest. The camera needs to see your hips to confirm it.',
  side: 'Center your weight on both hips and let your shoulders drop.'
}

// ───────────────────────────── step 1: camera check ─────────────────────────────

export type ProbeTone = 'good' | 'warn' | 'info' | 'pending'

export interface ProbeRow {
  id: 'camera' | 'you' | 'hips' | 'angle'
  label: string
  tone: ProbeTone
  text: string
  /** a smaller second line (the fix), or null */
  detail: string | null
}

/** "What I can see" (§7.2). `cameraError` is the user-facing error sentence, or null. */
export function probeRows(p: SetupProbeState, env: { running: boolean; cameraError: string | null }): ProbeRow[] {
  const rows: ProbeRow[] = []
  rows.push(
    env.cameraError
      ? { id: 'camera', label: 'Camera', tone: 'warn', text: env.cameraError, detail: null }
      : env.running && p.frames
        ? { id: 'camera', label: 'Camera', tone: 'good', text: 'Camera is on', detail: null }
        : { id: 'camera', label: 'Camera', tone: 'pending', text: 'Starting the camera…', detail: null }
  )
  rows.push(
    p.inView
      ? { id: 'you', label: 'You', tone: 'good', text: 'I can see you', detail: null }
      : {
          id: 'you',
          label: 'You',
          tone: p.frames ? 'warn' : 'pending',
          text: 'Move so your head and a shoulder are in the picture',
          detail: null
        }
  )
  if (!p.inView) {
    rows.push({ id: 'hips', label: 'Hips', tone: 'pending', text: 'Hips', detail: null })
    rows.push({ id: 'angle', label: 'Angle', tone: 'pending', text: 'Camera angle', detail: null })
    return rows
  }
  if (p.hips === 'seen') {
    rows.push(
      p.backCheckable
        ? { id: 'hips', label: 'Hips', tone: 'good', text: 'I can see your hips — full tracking', detail: null }
        : {
            id: 'hips',
            label: 'Hips',
            tone: 'info',
            text: 'I can see your hips',
            detail: 'Your back angle is hard to judge from straight in front — an AI model or a side angle can confirm it.'
          }
    )
  } else if (p.hips === 'hidden') {
    rows.push({
      id: 'hips',
      label: 'Hips',
      tone: 'warn',
      text: "Your hips are hidden — I won't be able to tell if you slump down",
      detail: 'Probably the desk. Tilt the camera down a little or sit a bit farther back.'
    })
  } else {
    rows.push({
      id: 'hips',
      label: 'Hips',
      tone: 'warn',
      text: "I can't see your hips — I won't be able to tell if you slump down",
      detail: 'Tilt the camera down a little or sit a bit farther back.'
    })
  }
  rows.push({ id: 'angle', label: 'Angle', tone: 'info', text: p.view ? VIEW_LABEL[p.view] : 'Camera angle', detail: null })
  return rows
}

/** The line under "Start coaching" when the back can't be confirmed from this view, else null. */
export function backWarning(p: SetupProbeState, ai: AiSetupState): string | null {
  if (!p.inView || p.backCheckable !== false) return null
  const lead = p.hips === 'seen' ? 'From this view I can’t confirm your back angle myself' : 'Without your hips in view'
  const need = `${lead}, setup needs an AI second opinion to confirm your back`
  switch (ai) {
    case 'on':
      return `${need} — or you can improve the view now.`
    case 'off-in-setup':
      return `${need} — turn your AI model on for setup, or improve the view now.`
    case 'turned-off':
      return `${need} — turn your AI model back on, or improve the view now.`
    default:
      return `${need} — connect an AI model for one, or improve the view now.`
  }
}

// ───────────────────────────── AI ─────────────────────────────

/**
 * 'none' = no connection saved · 'turned-off' = connections saved, but the AI switch or
 * every connection is off · 'off-in-setup' = available, "Use during setup" off · 'on'.
 */
export type AiSetupState = 'none' | 'turned-off' | 'off-in-setup' | 'on'

export function aiSetupState(settings: Settings | null): AiSetupState {
  if (aiReviewsSetup(settings)) return 'on'
  if (aiAvailable(settings)) return 'off-in-setup'
  return (settings?.ai.connections.length ?? 0) > 0 ? 'turned-off' : 'none'
}

/** The connection a setup review would ask first ("Google Gemini"), or null. */
export function aiLabel(settings: Settings | null): string | null {
  return primaryAiConnection(settings)?.label ?? null
}

/** The hint card while an essential can't be checked and no reviewer runs (§7.4.4). */
export function aiHintCopy(ai: AiSetupState, label: string | null): { text: string; action: string } | null {
  switch (ai) {
    case 'none':
      return { text: 'Want a second opinion? Connect an AI model and it can check what the camera can’t.', action: 'Open AI settings' }
    case 'turned-off':
      return { text: 'Your AI model is turned off. Turn it on and it can check what the camera can’t.', action: 'Open AI settings' }
    case 'off-in-setup':
      return {
        text: `Let ${label ?? 'your AI model'} double-check setup — it can check what the camera can’t.`,
        action: 'Turn on'
      }
    default:
      return null
  }
}

// ───────────────────────────── saved ─────────────────────────────

const sign = (v: number): string => {
  const r = Math.round(v)
  return r < 0 ? `−${-r}` : `${r === 0 ? 0 : r}`
}

const SEEN_FROM: Record<ViewKind, string> = {
  front: 'seen from the front',
  angled: 'seen at an angle',
  side: 'seen from the side'
}

/** "Neck 9° · Trunk upright · Shoulders level — seen from the side" */
export function baselineReadout(b: BaselineSummary): string {
  const parts = [`Neck ${sign(b.neckFwdDeg)}°`]
  if (b.trunkFwdDeg !== null) {
    const t = b.trunkFwdDeg
    parts.push(Math.abs(t) < 6 ? 'Trunk upright' : t > 0 ? `Trunk ${Math.round(t)}° forward` : `Reclined ${Math.round(-t)}°`)
  }
  if (b.shoulderTiltDeg !== null) {
    const s = Math.abs(b.shoulderTiltDeg)
    parts.push(s < 3 ? 'Shoulders level' : `Shoulders tilted ${Math.round(s)}°`)
  }
  return `${parts.join(' · ')} — ${SEEN_FROM[b.view]}`
}

/** The Saved step's verification chip (§7.6). */
export function verificationBadge(setup: SetupUiState): { tone: 'sage' | 'amber'; text: string } | null {
  const s = setup.baselineSummary
  if (!s) return null
  if (s.forced || !s.verified) return { tone: 'amber', text: 'Not verified — saved anyway' }
  const r = setup.reviewResult?.verdict === 'good' ? setup.reviewResult : null
  if (!r) return { tone: 'sage', text: 'Verified by on-device AI' }
  return setup.unverifiedChecks.length > 0
    ? { tone: 'sage', text: `Verified by ${r.label}` }
    : { tone: 'sage', text: `Verified by on-device AI and ${r.label}` }
}

const CHECK_PHRASE: Partial<Record<CheckId, string>> = {
  trunkUpright: 'your back',
  headOverShoulders: 'your head position',
  sideLean: 'how your weight is centered',
  shouldersLevel: 'your shoulders',
  headLevel: 'your head tilt',
  gaze: 'your gaze'
}

function joinPhrases(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "your back and your head position" */
export function whatPhrase(ids: readonly CheckId[]): string {
  const phrases = ids.map((id) => CHECK_PHRASE[id]).filter((p): p is string => !!p)
  return joinPhrases([...new Set(phrases)]) || 'your posture'
}

export interface UnverifiedCopy {
  text: string
  /** offer a way to Settings → AI models */
  linkToSettings: boolean
}

/**
 * A note for a saved baseline the local judge couldn't fully verify from this camera that
 * was NOT forced (null when there's nothing to say). Since the strict judge, only a forced
 * save stores an unverified baseline; this stays as a safety net.
 */
export function unverifiedCopy(
  summary: BaselineSummary | null,
  unverified: readonly CheckId[],
  ai: AiSetupState
): UnverifiedCopy | null {
  if (!summary || summary.verified || summary.forced) return null
  const phrases = unverified.map((id) => CHECK_PHRASE[id]).filter((p): p is string => !!p)
  if (phrases.length === 0) return null
  const what = joinPhrases([...new Set(phrases)])
  const tip = unverified.includes('trunkUpright') ? ' Sitting back against your chair is a safe bet.' : ''
  switch (ai) {
    case 'none':
      return {
        text: `From this angle SitSense can't check ${what} on its own — connect an AI model in Settings for a second opinion.${tip}`,
        linkToSettings: true
      }
    case 'turned-off':
      return {
        text: `From this angle SitSense can't check ${what} on its own. Turn on your AI model in Settings → AI models for a second opinion.${tip}`,
        linkToSettings: true
      }
    case 'off-in-setup':
      return {
        text: `From this angle SitSense can't check ${what} on its own. Turn on “Use during setup” under Settings → AI models for a second opinion.${tip}`,
        linkToSettings: true
      }
    case 'on':
      return {
        text: `From this angle SitSense can't check ${what} on its own, and the AI check didn't run this time. Redo setup later for a second opinion.${tip}`,
        linkToSettings: false
      }
  }
}

/** Screen-reader text for a checklist row's status. */
export function checkStatusText(kind: RowKind): string {
  switch (kind) {
    case 'good':
      return 'looks good'
    case 'adjust':
      return 'needs a change'
    case 'unverified':
      return "can't check yet — this blocks saving"
    case 'na':
      return 'not visible from here'
    default:
      return 'waiting'
  }
}
