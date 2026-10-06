// The Coach conversation (docs/specs/ui-v3.md §4). A module-level zustand store, so a
// reply in flight survives leaving the Coach page (the sidebar shows a sage dot through
// useAppStore.coachPending) and Live's coach card can read the last answer.
//
// History is local only: localStorage on this device, last 200 messages, never an image
// (a posture-check message keeps its numbers, text and share mode only). The pure parts
// live in chat.ts / context.ts and are unit-tested.

import { create } from 'zustand'
import { aiErrorMessage, type AiChatReply } from '@shared/ai'
import type { StatsRange } from '@shared/stats'
import { useAppStore } from '@renderer/state/store'
import { usableConnections } from '@renderer/ai/helpers'
import { detectionController } from '@renderer/detection/controller'
import { isSeen } from '@renderer/detection/pose-geometry'
import { capAssistantText } from './markdown'
import { fromStored, newMessageId, replyRow, toAiMessages, toStored } from './chat'
import { buildContext, liveKey, type CoachContextInputs } from './context'
import { DEFAULT_CONTEXT_TOGGLES, type CheckSketch, type CoachContextToggles, type CoachMessage } from './types'

export const COACH_HISTORY_KEY = 'sitsense.coach.history.v1'
export const COACH_CONTEXT_KEY = 'sitsense.coach.context.v1'
/** composer limit (§4.4) */
export const COMPOSER_MAX = 1000
const STATS_STALE_MS = 60_000

export interface CoachPending {
  kind: 'chat' | 'check'
  /** epoch ms the request started ("Still thinking…" after 8 s) */
  since: number
  /** the connection asked first */
  label: string
}

interface CoachState {
  messages: CoachMessage[]
  pending: CoachPending | null
  /** composer text (kept while away from Coach) */
  draft: string
  toggles: CoachContextToggles
  /** getStatsRange(7) for the "Today's stats" context */
  range: StatsRange | null
  /** bumps after each reply (rotates the suggested prompts) */
  promptSeed: number

  setDraft: (draft: string) => void
  setToggle: (key: keyof CoachContextToggles, on: boolean) => void
  refreshStats: (force?: boolean) => Promise<void>
  /** send a user message (ignored while a reply is pending or when empty) */
  send: (text: string) => void
  /** resend the user message the newest error row belongs to (or re-run the check); older errors are ignored */
  retry: (errorId: string) => void
  /** abandon the reply / check in flight (adds "Stopped") */
  stop: () => void
  /** delete the conversation (adds "Conversation cleared") */
  clear: () => void
  /** "Check my posture now" (§4.4) */
  checkPosture: () => void
}

// ───────────────────────────── storage (never throws) ─────────────────────────────

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full or blocked: the chat still works for this session
  }
}

function loadToggles(): CoachContextToggles {
  const v = readJson(COACH_CONTEXT_KEY)
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return {
    live: typeof o.live === 'boolean' ? o.live : DEFAULT_CONTEXT_TOGGLES.live,
    today: typeof o.today === 'boolean' ? o.today : DEFAULT_CONTEXT_TOGGLES.today,
    baseline: typeof o.baseline === 'boolean' ? o.baseline : DEFAULT_CONTEXT_TOGGLES.baseline
  }
}

/** Number of stored coach messages (Settings › Privacy & data). */
export function coachHistoryCount(): number {
  return toStored(useCoachStore.getState().messages).filter((m) => m.role !== 'system').length
}

/** Delete the stored conversation (Settings › Privacy & data › Clear chat). */
export function clearCoachHistory(): void {
  useCoachStore.getState().clear()
}

// ───────────────────────────── inputs from the app store ─────────────────────────────

export function contextInputs(range: StatsRange | null): CoachContextInputs {
  const s = useAppStore.getState()
  const paused = s.pause.paused
  const issues = s.settings?.issues
  return {
    snapshot: s.snapshot,
    paused,
    live: !paused && s.detection.running && !s.detection.cameraError && !s.detectorError,
    calibrated: !!s.settings?.calibration && !s.baselineCameraMismatch,
    // setup was done, with another camera: the coach must not hear "never set up"
    baselineCameraMismatch: !!s.settings?.calibration && s.baselineCameraMismatch,
    sitting: s.sitting,
    range,
    baseline: s.settings?.calibration ?? null,
    enabledIssues: issues
      ? { sink: issues.sink.enabled, headForward: issues.headForward.enabled, lean: issues.lean.enabled, tooClose: issues.tooClose.enabled }
      : undefined,
    now: Date.now()
  }
}

function sketchFromPose(): CheckSketch | undefined {
  const pose = useAppStore.getState().pose
  if (!pose) return undefined
  return { points: pose.image.map((p) => (isSeen(p) ? ([p.x, p.y] as [number, number]) : null)), aspect: pose.aspect }
}

/**
 * Stop the chat main is still running, so an abandoned question stops spending provider
 * tokens (ui-v3 §4.4). Main also replaces an abandoned chat when the next one arrives, so
 * a new question never waits for it (IPC 'ai:chat-cancel' → AiService.cancelChat).
 */
function cancelChatInMain(): void {
  const api = window.sitsense
  if (typeof api.aiChatCancel !== 'function') return
  try {
    void api.aiChatCancel().catch(() => undefined)
  } catch {
    // best effort: main drops the chat anyway when the next question arrives
  }
}

// ───────────────────────────── the store ─────────────────────────────

/** bumped by stop()/clear(): a reply that arrives for an older token is dropped */
let token = 0
let rangeAt = 0
let lastLiveKey: string | null = null

const msg = (m: Omit<CoachMessage, 'id' | 'at'> & { at?: number }): CoachMessage => ({ id: newMessageId(), at: Date.now(), ...m })
const note = (text: string, tone?: 'info'): CoachMessage => msg({ role: 'system', kind: 'note', text, ...(tone ? { tone } : {}) })

export const useCoachStore = create<CoachState>((set, get) => {
  const push = (...m: CoachMessage[]): void => set((s) => ({ messages: [...s.messages, ...m] }))
  const setPending = (pending: CoachPending | null): void => {
    set({ pending })
    useAppStore.getState().setCoachPending(pending !== null)
  }

  async function runChat(userId: string): Promise<void> {
    const settings = useAppStore.getState().settings
    const primary = usableConnections(settings)[0]
    if (!primary) return
    const my = ++token
    setPending({ kind: 'chat', since: Date.now(), label: primary.label })
    if (Date.now() - rangeAt > STATS_STALE_MS) await get().refreshStats().catch(() => undefined)
    if (my !== token) return
    const inputs = contextInputs(get().range)
    const context = buildContext(inputs, get().toggles)
    lastLiveKey = get().toggles.live ? liveKey(inputs) : null
    const messages = toAiMessages(get().messages, { upTo: userId })
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      setPending(null)
      return
    }
    const res: AiChatReply = await window.sitsense
      .aiChat({ messages, ...(context ? { context } : {}) })
      .catch((err): AiChatReply => ({ ok: false, message: aiErrorMessage(err) }))
    if (my !== token) return // stopped or cleared meanwhile
    setPending(null)
    // main decides whether a fallback answered and whether a failure is the model's
    const row = replyRow(res)
    if (row.kind === 'text') {
      push(msg({ role: 'assistant', kind: 'text', text: capAssistantText(row.text), meta: row.meta }))
      set((s) => ({ promptSeed: s.promptSeed + 1 }))
    } else {
      push(msg({ role: 'assistant', kind: 'error', text: row.text, retryOf: userId, fromModel: row.fromModel }))
    }
  }

  async function runCheck(): Promise<void> {
    const app = useAppStore.getState()
    const settings = app.settings
    const primary = usableConnections(settings)[0]
    if (!settings || !primary) return
    if (app.pause.paused) {
      push(note('Resume monitoring to check your posture.', 'info'))
      return
    }
    const live = app.detection.running && !app.detection.cameraError && !app.detectorError
    if (!live || app.snapshot?.presence !== 'active') {
      push(note('Sit in view of the camera first — SitSense needs to see you.', 'info'))
      return
    }
    const share = settings.ai.share
    const sketch = share === 'sketch' ? sketchFromPose() : undefined
    push(msg({ role: 'user', kind: 'check', text: 'Checked my posture', share }))
    const my = ++token
    setPending({ kind: 'check', since: Date.now(), label: primary.label })
    // the controller runs one check at a time; take over one Live may have started
    if (useAppStore.getState().aiCheck.status !== 'idle') detectionController.dismissAiCheck()
    await detectionController.askAi().catch(() => undefined)
    if (my !== token) return
    const result = useAppStore.getState().aiCheck
    // the answer lives in the chat now — don't leave a second copy on Live
    if (result.status !== 'idle') detectionController.dismissAiCheck()
    setPending(null)
    if (result.status === 'done' && result.review) {
      push(msg({ role: 'assistant', kind: 'check', text: result.review.summary, review: result.review, share, sketch }))
      set((s) => ({ promptSeed: s.promptSeed + 1 }))
    } else if (result.status === 'error') {
      push(
        msg({
          role: 'assistant',
          kind: 'error',
          text: result.message ?? 'The posture check failed.',
          retryOf: null,
          fromModel: result.label !== null
        })
      )
    } else {
      // cancelled underneath us (monitoring paused, camera lost)
      push(note(useAppStore.getState().pause.paused ? 'Resume monitoring to check your posture.' : 'Stopped', useAppStore.getState().pause.paused ? 'info' : undefined))
    }
  }

  return {
    messages: fromStored(readJson(COACH_HISTORY_KEY)),
    pending: null,
    draft: '',
    toggles: loadToggles(),
    range: null,
    promptSeed: Math.floor(Math.random() * 8),

    setDraft: (draft) => set({ draft: draft.slice(0, COMPOSER_MAX) }),
    setToggle: (key, on) => {
      const toggles = { ...get().toggles, [key]: on }
      set({ toggles })
      writeJson(COACH_CONTEXT_KEY, toggles)
    },
    refreshStats: async (force) => {
      if (!force && Date.now() - rangeAt < STATS_STALE_MS / 2 && get().range) return
      rangeAt = Date.now()
      try {
        const range = await window.sitsense.getStatsRange(7)
        set({ range })
      } catch {
        // keep the last range; the panel shows what it has
      }
    },
    send: (text) => {
      const t = text.trim().slice(0, COMPOSER_MAX)
      if (!t || get().pending) return
      if (usableConnections(useAppStore.getState().settings).length === 0) return
      const extra: CoachMessage[] = []
      if (get().toggles.live && lastLiveKey !== null && get().messages.some((m) => m.role === 'assistant')) {
        const now = liveKey(contextInputs(get().range))
        if (now !== null && now !== lastLiveKey) extra.push(note('Measurements updated'))
      }
      const user = msg({ role: 'user', kind: 'text', text: t })
      push(...extra, user)
      void runChat(user.id)
    },
    retry: (errorId) => {
      if (get().pending) return
      // only the newest error can be retried: resending an older question would answer it
      // at the bottom of the chat, out of context (older rows read "Not answered")
      const lastReal = [...get().messages].reverse().find((m) => m.role !== 'system')
      if (lastReal?.id !== errorId) return
      const err = get().messages.find((m) => m.id === errorId)
      if (!err || err.kind !== 'error') return
      set((s) => ({ messages: s.messages.filter((m) => m.id !== errorId) }))
      if (err.retryOf === null || err.retryOf === undefined) {
        // drop the "Checked my posture" chip of the failed attempt; the new run adds one
        set((s) => {
          const last = s.messages[s.messages.length - 1]
          return last && last.role === 'user' && last.kind === 'check' ? { messages: s.messages.slice(0, -1) } : {}
        })
        void runCheck()
      } else if (get().messages.some((m) => m.id === err.retryOf)) {
        void runChat(err.retryOf)
      }
    },
    stop: () => {
      const p = get().pending
      if (!p) return
      token++
      setPending(null)
      if (p.kind === 'check') detectionController.dismissAiCheck()
      else cancelChatInMain()
      push(note('Stopped'))
    },
    clear: () => {
      const p = get().pending
      token++
      if (p) {
        setPending(null)
        if (p.kind === 'check') detectionController.dismissAiCheck()
        else cancelChatInMain()
      }
      lastLiveKey = null
      set({ messages: [note('Conversation cleared')] })
    },
    checkPosture: () => {
      if (get().pending) return
      void runCheck()
    }
  }
})

// persist on every change of the conversation (small: ≤ 200 short messages)
useCoachStore.subscribe((s, prev) => {
  if (s.messages !== prev.messages) writeJson(COACH_HISTORY_KEY, toStored(s.messages))
})
