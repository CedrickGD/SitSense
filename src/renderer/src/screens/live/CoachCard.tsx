// Live › Coach card (docs/specs/ui-v3.md §3.6): a peek at the coach — the last exchange
// as a mini thread — plus an inline question box (1–3 lines, Enter sends, Shift+Enter
// adds a line). Sending hands the question to Coach (store.askCoach), which appends and
// sends it there; "Check my posture now" runs the check in Coach.
// A tall card spends its height on the conversation: the reply keeps its lines (lists stay
// lists), earlier messages fade in above it, and an empty chat offers suggested questions.

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type RefObject
} from 'react'
import { useAppStore } from '@renderer/state/store'
import { usableConnections } from '@renderer/ai/helpers'
import { Button, Card, CardHeader, FIELD_CLASS, IconButton, LinkButton, ThinkingDots } from '@renderer/components/primitives'
import { useCoachStore } from '@renderer/screens/coach/coachStore'
import { PROMPT_POOL, suggestedPrompts } from '@renderer/screens/coach/chat'
import { Icon } from '@renderer/components/icons'
import { coachThread, type PeekMessage } from './liveModel'

const EMPTY_PREVIEW = 'Ask anything about your posture, your desk or a stretch.'

/** The question box grows from one line to this many, then scrolls. */
const MAX_DRAFT_LINES = 3
const DRAFT_LINE_PX = 20

/** A textarea that grows with its text from 1 to MAX_DRAFT_LINES lines. */
function useAutoGrow(value: string): RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const max = MAX_DRAFT_LINES * DRAFT_LINE_PX + pad
    el.style.height = `${Math.min(max, el.scrollHeight)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [value])
  return ref
}

/** Room (card height) from which the thread shows the question bubble too. */
const THREAD_MIN_ROOM = 250
/** Card height used by everything but the reply lines (header, bubble, box, button, padding). */
const THREAD_CHROME_PX = 220
/** type-body line height */
const LINE_PX = 18
/** At most this many reply lines; a taller card shows earlier messages above instead. */
const MAX_ANSWER_LINES = 12
/** Earlier messages kept ready for the space above the exchange (clipped to what fits). */
const MAX_EARLIER = 6
/** Card height used by an empty chat's line, box and button (padding included). */
const EMPTY_CHROME_PX = 196
/** One suggested-question chip (28 px + 6 px gap). */
const PROMPT_PX = 34
/** Only prompts this short fit a one-line chip in the narrowest card. */
const SHORT_PROMPT_CHARS = 31

const clampStyle = (lines: number): CSSProperties => ({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: lines,
  overflow: 'hidden'
})

function QuestionBubble({ text, dim }: { text: string; dim?: boolean }): JSX.Element {
  // padding on the bubble, clamp on the text: a clamped box with padding shows a sliver of the next line
  return (
    <span className="max-w-[88%] shrink-0 self-end rounded-xl rounded-br-sm bg-card-2 px-2.5 py-1.5 ring-1 ring-white/[0.05]">
      <span className={`line-clamp-2 type-caption whitespace-pre-line ${dim ? 'text-text-dim' : 'text-text'}`}>{text}</span>
    </span>
  )
}

/**
 * Earlier messages in whatever height is left above the last exchange, newest at the
 * bottom. When they don't all fit, the oldest are clipped under a fade; a sliver too thin
 * to read is not shown at all.
 */
function EarlierMessages({ items }: { items: PeekMessage[] }): JSX.Element {
  const boxRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState({ cut: false, show: false })
  useLayoutEffect(() => {
    const box = boxRef.current
    const list = listRef.current
    if (!box || !list || typeof ResizeObserver === 'undefined') return
    const read = (): void => {
      // bottom-anchored, the overflow sits above the box, where scrollHeight can't see it
      const cut = list.offsetHeight > box.clientHeight + 1
      const show = box.clientHeight >= 44
      setFit((f) => (f.cut === cut && f.show === show ? f : { cut, show }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(box)
    ro.observe(list)
    return () => ro.disconnect()
  }, [])
  // the list is absolute: it must never size the card (the grid row would grow to fit it).
  // Too short to show anything, the (same-size) box moves below the exchange, so the gap
  // sits above the question box rather than under the card header.
  return (
    <span
      ref={boxRef}
      aria-hidden
      className={`relative min-h-0 flex-1 overflow-hidden ${fit.show ? '' : 'invisible order-last'}`}
      style={fit.cut ? { maskImage: 'linear-gradient(to bottom, transparent, black 40px)' } : undefined}
    >
      <span ref={listRef} className="absolute inset-x-0 bottom-0 flex flex-col gap-2 pb-2">
        {items.map((m, i) =>
          m.role === 'user' ? (
            <QuestionBubble key={i} text={m.text} dim />
          ) : (
            <span key={i} className="type-body whitespace-pre-line text-text-dim/75" style={clampStyle(4)}>
              {m.text}
            </span>
          )
        )}
      </span>
    </span>
  )
}

/**
 * `room`: the height the card gets from the row (0 = unknown). A short card shows a
 * 2-line reply; a taller one shows the last question as a bubble and as many reply lines
 * as fit, then earlier messages above — the extra height goes to the conversation, never
 * to a scroll or an empty gap.
 */
export default function CoachCard({ room = 0 }: { room?: number }): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setRoute = useAppStore((s) => s.setRoute)
  const openSettings = useAppStore((s) => s.openSettings)
  const askCoach = useAppStore((s) => s.askCoach)
  const checkPostureInCoach = useAppStore((s) => s.checkPostureInCoach)
  const pending = useAppStore((s) => s.coachPending)
  // the conversation lives in Coach's module store (local history), read-only here
  const messages = useCoachStore((s) => s.messages)
  const [draft, setDraft] = useState('')
  const draftRef = useAutoGrow(draft)
  const hintId = useId()
  const { question, answer, earlier } = useMemo(() => coachThread(messages, pending, MAX_EARLIER), [messages, pending])

  const usable = usableConnections(settings).length > 0
  const turnedOff = !!settings && !settings.ai.enabled && settings.ai.connections.length > 0

  const header = (
    <CardHeader
      eyebrow="Coach"
      icon="spark"
      action={
        <LinkButton arrow onClick={() => setRoute('coach')}>
          Open
        </LinkButton>
      }
    />
  )

  if (!usable) {
    // a proper empty state (§8.6, compact): one centered group, not three loose rows
    return (
      <Card dense className="flex h-full min-w-0 flex-col" aria-label="Coach">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-2 pb-1 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sage-soft text-sage" aria-hidden>
            <Icon name="spark" size={18} />
          </span>
          <p className="max-w-[32ch] type-body text-balance text-text-dim">
            {turnedOff
              ? 'Your AI model is turned off.'
              : 'Your coach can answer questions about your posture once you connect an AI model.'}
          </p>
          <Button size="sm" variant="secondary" ringOn="card" onClick={() => openSettings('ai')}>
            {turnedOff ? 'Turn on' : 'Connect a model'}
          </Button>
        </div>
      </Card>
    )
  }

  const send = (): void => {
    const t = draft.trim()
    if (!t) return
    setDraft('')
    askCoach(t)
  }

  const preview = pending ? 'Thinking…' : (answer ?? EMPTY_PREVIEW)
  const thread = room >= THREAD_MIN_ROOM
  const answerLines = thread ? Math.max(2, Math.min(MAX_ANSWER_LINES, Math.floor((room - THREAD_CHROME_PX) / LINE_PX))) : 2
  const showEarlier = thread && earlier.length > 0 && (answer !== null || pending)
  // an empty chat: a few questions to start with, as many as the card has room for
  const empty = !pending && answer === null
  const promptCount = empty ? Math.max(0, Math.min(3, Math.floor((room - EMPTY_CHROME_PX) / PROMPT_PX))) : 0
  const prompts = promptCount > 0 ? suggestedPrompts(0, PROMPT_POOL.length).filter((p) => p.length <= SHORT_PROMPT_CHARS).slice(0, promptCount) : []

  return (
    <Card dense className="flex h-full min-w-0 flex-col" aria-label="Coach">
      {header}
      <button
        type="button"
        onClick={() => setRoute('coach')}
        aria-label={`Open Coach: ${question ? `You asked “${question}”. ` : ''}${preview}`}
        className={`-mx-1.5 -mt-1 mb-3 flex min-h-0 flex-col gap-2 rounded-lg px-1.5 py-1 text-left transition-colors duration-150 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:ring-offset-2 focus-visible:ring-offset-card focus-visible:outline-none ${
          showEarlier ? 'flex-1' : ''
        }`}
      >
        {showEarlier && <EarlierMessages items={earlier} />}
        {thread && question && <QuestionBubble text={question} />}
        {pending ? (
          <span className="flex shrink-0 items-center gap-2 type-body text-text-dim">
            <ThinkingDots />
            Thinking…
          </span>
        ) : answer ? (
          <span className="shrink-0 type-body whitespace-pre-line text-text-dim" style={clampStyle(answerLines)}>
            {answer}
          </span>
        ) : (
          <span className="line-clamp-2 type-body text-text-dim">{EMPTY_PREVIEW}</span>
        )}
      </button>
      {prompts.length > 0 && (
        <ul aria-label="Suggested questions" className="-mt-1 mb-3 flex min-w-0 flex-col items-start gap-1.5">
          {prompts.map((p) => (
            <li key={p} className="max-w-full">
              <button
                type="button"
                onClick={() => askCoach(p)}
                className="inline-flex h-7 max-w-full items-center rounded-full bg-white/[0.04] px-3 type-caption text-text-dim ring-1 ring-white/[0.05] ring-inset transition-colors duration-150 hover:bg-sage-soft hover:text-sage focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none"
              >
                <span className="truncate" title={p}>
                  {p}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="relative mt-auto"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          ref={draftRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter adds a line (never mid-IME composition)
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Ask your coach…"
          aria-label="Ask your coach"
          aria-describedby={hintId}
          maxLength={1000}
          className={`${FIELD_CLASS} titlebar-no-drag block h-auto w-full resize-none py-1.5 pr-10 leading-5 select-text`}
        />
        <span id={hintId} className="sr-only">
          Enter sends, Shift+Enter adds a line.
        </span>
        <span className="absolute right-0.5 bottom-0.5">
          <IconButton icon="send" label="Send to Coach" size={28} ringOn="card-2" disabled={!draft.trim()} onClick={send} />
        </span>
      </form>
      <Button size="sm" variant="ghost" icon="camera" ringOn="card" className="mt-2 -ml-2.5 self-start" onClick={() => checkPostureInCoach()}>
        Check my posture now
      </Button>
    </Card>
  )
}
