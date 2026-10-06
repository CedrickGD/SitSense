// Live › Coach card (docs/specs/ui-v3.md §3.6): a peek at the coach — the last exchange
// as a mini thread — plus an inline question box (1–3 lines, Enter sends, Shift+Enter
// adds a line). Sending hands the question to Coach (store.askCoach), which appends and
// sends it there; "Check my posture now" runs the check in Coach.

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react'
import { useAppStore } from '@renderer/state/store'
import { usableConnections } from '@renderer/ai/helpers'
import { Button, Card, CardHeader, FIELD_CLASS, IconButton, LinkButton, ThinkingDots } from '@renderer/components/primitives'
import { useCoachStore } from '@renderer/screens/coach/coachStore'
import { Icon } from '@renderer/components/icons'
import { lastExchange } from './liveModel'

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
const LINE_PX = 20

const clampStyle = (lines: number): CSSProperties => ({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: lines,
  overflow: 'hidden'
})

/**
 * `room`: the height the card gets from the row (0 = unknown). A short card shows a
 * 2-line reply; a taller one shows the last question as a bubble and as many reply lines
 * as fit (up to 8), so the extra height is spent on the conversation, never on a scroll.
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
  const { question, answer } = lastExchange(messages, pending)

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
    return (
      <Card dense className="flex h-full min-w-0 flex-col" aria-label="Coach">
        {header}
        <div className="flex flex-1 flex-col items-start gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sage-soft text-sage" aria-hidden>
            <Icon name="spark" size={16} />
          </span>
          <p className="type-body text-text-dim">
            {turnedOff
              ? 'Your AI model is turned off.'
              : 'Your coach can answer questions about your posture once you connect an AI model.'}
          </p>
          <Button size="sm" variant="secondary" ringOn="card" className="mt-auto" onClick={() => openSettings('ai')}>
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
  const answerLines = thread ? Math.max(2, Math.min(8, Math.floor((room - THREAD_CHROME_PX) / LINE_PX))) : 2

  return (
    <Card dense className="flex h-full min-w-0 flex-col" aria-label="Coach">
      {header}
      <button
        type="button"
        onClick={() => setRoute('coach')}
        aria-label={`Open Coach: ${question ? `You asked “${question}”. ` : ''}${preview}`}
        className="-mx-1.5 -mt-1 mb-3 flex flex-col gap-2 rounded-lg px-1.5 py-1 text-left transition-colors duration-150 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:ring-offset-2 focus-visible:ring-offset-card focus-visible:outline-none"
      >
        {thread && question && (
          // padding on the bubble, clamp on the text: a clamped box with padding shows a sliver of the next line
          <span className="max-w-[88%] self-end rounded-xl rounded-br-sm bg-card-2 px-2.5 py-1.5 ring-1 ring-white/[0.05]">
            <span className="line-clamp-2 type-caption text-text">{question}</span>
          </span>
        )}
        {pending ? (
          <span className="flex items-center gap-2 type-body text-text-dim">
            <ThinkingDots />
            Thinking…
          </span>
        ) : answer ? (
          <span className="type-body text-text-dim" style={clampStyle(answerLines)}>
            {answer}
          </span>
        ) : (
          <span className="line-clamp-2 type-body text-text-dim">{EMPTY_PREVIEW}</span>
        )}
      </button>
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
