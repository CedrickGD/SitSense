// The conversation (ui-v3.md §4.2, §4.6): day separators, grouped messages, the
// greeting with suggested prompts, the thinking row, error rows, and auto-scroll with a
// "New message" pill when the user has scrolled up.

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Icon } from '@renderer/components/icons'
import { Button, IconButton, ThinkingDots } from '@renderer/components/primitives'
import { fmtClock, fmtDate } from '@renderer/lib/format'
import { aiErrorLine, mentionsSettings } from '@renderer/lib/ui'
import { useNow } from '@renderer/lib/hooks'
import { useAppStore } from '@renderer/state/store'
import { greetingText, layoutRows, relativeDay } from './chat'
import { useContextPreviews } from './ContextPanel'
import { Markdown } from './MarkdownView'
import { plainText } from './markdown'
import { CheckCard, CoachAvatar, Separator } from './parts'
import { useCoachStore, type CoachPending } from './coachStore'
import type { CoachMessage } from './types'

const STICK_PX = 80
const STILL_THINKING_MS = 8000
const COPY_FEEDBACK_MS = 1400

const ROW_IN = 'motion-safe:animate-[rowIn_150ms_ease-out]'

function AssistantHeader({ at }: { at: number | null }): JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <CoachAvatar />
      <span className="type-caption font-medium text-text-dim">Coach</span>
      {at !== null && <span className="type-caption text-text-faint tabular-nums">{fmtClock(at)}</span>}
    </div>
  )
}

/** Copies the reply as plain text (no `**`, backticks or fences); says so when it can't. */
function CopyButton({ text }: { text: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), COPY_FEEDBACK_MS)
    return () => clearTimeout(t)
  }, [state])
  const copy = (): void => {
    const write = navigator.clipboard?.writeText(plainText(text))
    if (!write) {
      setState('failed')
      return
    }
    write.then(
      () => setState('copied'),
      () => setState('failed')
    )
  }
  return (
    <IconButton
      icon={state === 'copied' ? 'check' : state === 'failed' ? 'alert' : 'copy'}
      label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy'}
      size={28}
      ringOn="card"
      className={`opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ${
        state === 'copied' ? 'text-sage! opacity-100' : state === 'failed' ? 'text-coral! opacity-100' : ''
      }`}
      onClick={copy}
    />
  )
}

function AssistantText({ m, head }: { m: CoachMessage; head: boolean }): JSX.Element {
  return (
    <div className={`group ${ROW_IN}`}>
      {head && <AssistantHeader at={m.at} />}
      <div className="relative flex max-w-[660px] items-start gap-2 pl-8">
        <Markdown text={m.text} className="max-w-[620px] min-w-0 flex-1 type-body-lg text-text" />
        <span className="-mt-0.5 shrink-0">
          <CopyButton text={m.text} />
        </span>
      </div>
      {m.meta?.fallbackFrom && (
        <p className="mt-1.5 pl-8 type-caption text-text-faint">
          Answered by {m.meta.label} — {m.meta.fallbackFrom} didn’t respond.
        </p>
      )}
    </div>
  )
}

/**
 * A failed reply. Only the newest one can be retried (an older question resent now would
 * be answered at the bottom, out of context); older ones fade and read "Not answered".
 * The settings hint is a button, not repeated in the text; HTTP codes are left out.
 */
function ErrorRow({ m, canRetry }: { m: CoachMessage; canRetry: boolean }): JSX.Element {
  const retry = useCoachStore((s) => s.retry)
  const busy = useCoachStore((s) => s.pending !== null)
  const openSettings = useAppStore((s) => s.openSettings)
  const line = aiErrorLine(m.text, false).replace(/\s*\(HTTP \d{3}\)/, '')
  const settingsHint = m.fromModel === true || mentionsSettings(line)
  return (
    <div className={`pl-8 ${ROW_IN}`}>
      <div
        className={`flex max-w-[620px] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3.5 py-2.5 ring-1 ${
          canRetry ? 'bg-coral/12 ring-coral/15' : 'bg-white/[0.03] ring-white/[0.05]'
        }`}
      >
        <span className="flex min-w-0 flex-1 basis-64 items-start gap-2.5">
          <span className={`mt-0.5 ${canRetry ? 'text-coral' : 'text-text-faint'}`}>
            <Icon name="alert" size={16} />
          </span>
          <span className={`min-w-0 type-body ${canRetry ? 'text-text' : 'text-text-dim'}`}>{line}</span>
        </span>
        {canRetry ? (
          <span className="flex shrink-0 items-center gap-1">
            {settingsHint && (
              <Button size="sm" variant="ghost" ringOn="card" onClick={() => openSettings('ai')}>
                Open AI settings
              </Button>
            )}
            <Button size="sm" variant="ghost" icon="refresh" ringOn="card" pending={busy} onClick={() => retry(m.id)}>
              Retry
            </Button>
          </span>
        ) : (
          <span className="shrink-0 type-caption text-text-faint">Not answered</span>
        )}
      </div>
    </div>
  )
}

function UserRow({ m, head }: { m: CoachMessage; head: boolean }): JSX.Element {
  if (m.kind === 'check') {
    return (
      <div className={`flex justify-end ${ROW_IN}`}>
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-card-2 px-3 type-caption text-text-dim ring-1 ring-white/[0.06]">
          <Icon name="camera" size={14} />
          {m.text}
        </span>
      </div>
    )
  }
  return (
    <div className={`flex flex-col items-end ${ROW_IN}`}>
      {head && <span className="mb-1 type-caption text-text-faint tabular-nums">{fmtClock(m.at)}</span>}
      <div className="max-w-[min(520px,85%)] rounded-[14px] rounded-br-[4px] bg-card-2 px-3.5 py-2.5 type-body-lg whitespace-pre-wrap break-words text-text ring-1 ring-white/[0.04]">
        {m.text}
      </div>
    </div>
  )
}

function NoteRow({ m }: { m: CoachMessage }): JSX.Element {
  if (m.tone === 'info') {
    return (
      <div className={`pl-8 ${ROW_IN}`}>
        <p className="inline-flex max-w-[620px] items-start gap-2 rounded-xl bg-white/[0.04] px-3 py-2 type-body text-text-dim">
          <span className="mt-px text-slate-cool">
            <Icon name="info" size={16} />
          </span>
          {m.text}
        </p>
      </div>
    )
  }
  return <p className={`text-center type-caption text-text-faint ${ROW_IN}`}>{m.text}</p>
}

function ThinkingRow({ pending }: { pending: CoachPending }): JSX.Element {
  const now = useNow(1000)
  const slow = now - pending.since >= STILL_THINKING_MS
  const text =
    pending.kind === 'check'
      ? slow
        ? 'Still looking — some models take a moment.'
        : `Asking ${pending.label} to look at your posture…`
      : slow
        ? 'Still thinking — local models can take a while.'
        : 'Thinking…'
  return (
    <div className={`flex items-center gap-2 ${ROW_IN}`}>
      <CoachAvatar />
      <span className="flex h-6 items-center gap-2.5 pl-1">
        <ThinkingDots />
        <span className="type-body text-text-dim">{text}</span>
      </span>
    </div>
  )
}

function Greeting({ onPrompt, prompts, disabled }: { onPrompt: (p: string) => void; prompts: string[]; disabled: boolean }): JSX.Element {
  const toggles = useCoachStore((s) => s.toggles)
  const previews = useContextPreviews()
  const present = useAppStore((s) => s.snapshot?.presence === 'active')
  return (
    <div className={ROW_IN}>
      <AssistantHeader at={null} />
      <div className="flex max-w-[620px] flex-col gap-4 pl-8">
        <Markdown text={greetingText(toggles, previews, present)} className="type-body-lg text-text" />
        <div className="grid grid-cols-1 gap-2 min-[560px]:grid-cols-2" role="group" aria-label="Suggested questions">
          {prompts.map((p) => (
            <button
              key={p}
              type="button"
              disabled={disabled}
              onClick={() => onPrompt(p)}
              className="group flex min-h-11 items-center gap-2.5 rounded-xl bg-white/[0.035] px-3 py-2 text-left type-body text-text-dim ring-1 ring-white/[0.06] transition-colors duration-150 enabled:hover:bg-sage-soft enabled:hover:text-sage enabled:hover:ring-sage/25 focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-text-faint transition-colors duration-150 group-enabled:group-hover:text-sage">
                <Icon name="spark" size={14} />
              </span>
              <span className="min-w-0 flex-1">{p}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

interface MessageListProps {
  messages: CoachMessage[]
  pending: CoachPending | null
  /** show the greeting (no user/assistant messages yet) */
  greeting: boolean
  greetingPrompts: string[]
  onPrompt: (p: string) => void
  promptsDisabled: boolean
}

export function MessageList({ messages, pending, greeting, greetingPrompts, onPrompt, promptsDisabled }: MessageListProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  /** the scroller's height at the last scroll event (a layout-caused scroll isn't the user's) */
  const lastH = useRef(0)
  const [unseen, setUnseen] = useState(false)
  const now = useNow(60_000)
  const rows = layoutRows(messages)
  const last = messages[messages.length - 1]
  // only the newest real row's error can be retried (coachStore.retry checks the same)
  const lastRealId = [...messages].reverse().find((m) => m.role !== 'system')?.id

  const toBottom = (smooth: boolean): void => {
    const el = scrollRef.current
    if (!el) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' })
  }

  // first paint: start at the newest message
  useLayoutEffect(() => {
    if (scrollRef.current) lastH.current = scrollRef.current.clientHeight
    toBottom(false)
  }, [])

  // the list or its content changed size (window resize, a notice strip, the composer
  // growing, a reply rendering): stay pinned to the bottom if the user was there
  useEffect(() => {
    const el = scrollRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      lastH.current = el.clientHeight
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  // new rows: follow along unless the user scrolled up (their own message always scrolls)
  useEffect(() => {
    if (stick.current || last?.role === 'user') {
      toBottom(true)
      setUnseen(false)
    } else if (last) {
      setUnseen(true)
    }
  }, [messages.length, last?.id, last?.role, pending?.since])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(e) => {
          const el = e.currentTarget
          // the scroller just changed height (window resize, composer grew): this scroll is
          // the layout's doing, not the user's — leave `stick` for the ResizeObserver
          if (el.clientHeight !== lastH.current) {
            lastH.current = el.clientHeight
            return
          }
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
          if (stick.current) setUnseen(false)
        }}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-contain px-6 pt-6 pb-5 [overflow-anchor:none]"
      >
        <div ref={innerRef} className="flex min-h-full flex-col">
          {/* a short greeting sits centred; a conversation sits on the composer like a messenger */}
          <div className={`flex flex-col ${greeting && rows.length <= 2 ? 'my-auto' : 'mt-auto'}`}>
            {rows.map((r, i) => {
              const first = i === 0
              if (r.t === 'day') {
                const rel = relativeDay(r.at, now)
                return (
                  <div key={`d${r.key}`} className={first ? 'mb-4' : 'my-5'}>
                    <Separator>{rel ?? fmtDate(r.at)}</Separator>
                  </div>
                )
              }
              const m = r.m
              const gap = rows[i - 1]?.t === 'day' ? '' : r.head || m.role === 'system' ? 'mt-5' : 'mt-2'
              return (
                <div key={m.id} className={gap}>
                  {m.role === 'system' ? (
                    <NoteRow m={m} />
                  ) : m.role === 'user' ? (
                    <UserRow m={m} head={r.head} />
                  ) : m.kind === 'error' ? (
                    <ErrorRow m={m} canRetry={m.id === lastRealId} />
                  ) : m.kind === 'check' ? (
                    <div className={ROW_IN}>
                      <AssistantHeader at={m.at} />
                      <div className="pl-8">
                        <CheckCard message={m} />
                      </div>
                    </div>
                  ) : (
                    <AssistantText m={m} head={r.head} />
                  )}
                </div>
              )
            })}
            {greeting && (
              <div className={rows.length ? 'mt-5' : ''}>
                <Greeting onPrompt={onPrompt} prompts={greetingPrompts} disabled={promptsDisabled} />
              </div>
            )}
            {pending && (
              <div className="mt-5">
                <ThinkingRow pending={pending} />
              </div>
            )}
          </div>
        </div>
      </div>
      {unseen && (
        <button
          type="button"
          onClick={() => {
            stick.current = true
            setUnseen(false)
            toBottom(true)
          }}
          className="surface-popover absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full! px-3.5 type-caption font-medium text-text transition-colors duration-150 hover:text-sage focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none motion-safe:animate-[rowIn_150ms_ease-out]"
        >
          <Icon name="arrow-down" size={14} />
          New message
        </button>
      )}
    </div>
  )
}
