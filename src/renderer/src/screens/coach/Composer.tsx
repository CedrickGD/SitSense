// The composer (ui-v3.md §4.4): a 1–5 line textarea with Send / Stop inset on the right,
// "Check my posture now", the key hint or the character counter, and suggested prompts
// above it after a reply. On narrow windows the context chips take the hint's place.

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type Ref } from 'react'
import { Icon } from '@renderer/components/icons'
import { Button, Tooltip } from '@renderer/components/primitives'
import { useMonitoring } from '@renderer/lib/hooks'
import { useAppStore } from '@renderer/state/store'
import { COMPOSER_MAX, useCoachStore } from './coachStore'

const COUNTER_FROM = 900
const LINE = 21
const MAX_LINES = 5
const PAD_Y = 15 // 7 + 8: one line = 36 px

interface ComposerProps {
  textareaRef: Ref<HTMLTextAreaElement>
  /** send disabled with this reason (offline), or null */
  blockedReason: string | null
  /** prompt chips above the composer (after a reply), or [] */
  prompts: string[]
  /** right side of the action row instead of the key hint (context chips on narrow windows) */
  aside?: ReactNode
  /** one caption line under the actions (privacy on narrow windows) */
  below?: ReactNode
}

/** One row of prompt chips: chips that don't fit whole are hidden (never wrapped or cut). */
function PromptChips({ prompts, onPick, disabled }: { prompts: string[]; onPick: (p: string) => void; disabled: boolean }): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState<boolean[]>(() => prompts.map(() => true))
  const key = prompts.join('|')

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const measure = (): void => {
      const w = row.clientWidth
      const next = Array.from(row.children).map((c) => {
        const el = c as HTMLElement
        // the row is `relative`, so offsetLeft is measured from its padding edge
        return el.offsetLeft + el.offsetWidth <= w + 0.5
      })
      setFits((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    return () => ro.disconnect()
  }, [key])

  return (
    <div ref={rowRef} className="relative flex min-w-0 flex-nowrap gap-2 overflow-hidden" role="group" aria-label="Suggested questions">
      {prompts.map((p, i) => {
        const shown = fits[i] !== false
        return (
          <button
            key={p}
            type="button"
            disabled={disabled}
            tabIndex={shown ? undefined : -1}
            aria-hidden={shown ? undefined : true}
            onClick={() => onPick(p)}
            className={`inline-flex h-7 shrink-0 items-center rounded-full bg-white/[0.04] px-3 type-caption whitespace-nowrap text-text-dim ring-1 ring-white/[0.05] ring-inset transition-colors duration-150 enabled:hover:bg-sage-soft enabled:hover:text-sage focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 motion-safe:animate-[rowIn_150ms_ease-out] ${
              shown ? '' : 'invisible'
            }`}
          >
            {p}
          </button>
        )
      })}
    </div>
  )
}

export function Composer({ textareaRef, blockedReason, prompts, aside, below }: ComposerProps): JSX.Element {
  const draft = useCoachStore((s) => s.draft)
  const setDraft = useCoachStore((s) => s.setDraft)
  const pending = useCoachStore((s) => s.pending)
  const send = useCoachStore((s) => s.send)
  const stop = useCoachStore((s) => s.stop)
  const checkPosture = useCoachStore((s) => s.checkPosture)
  const messages = useCoachStore((s) => s.messages)
  const local = useRef<HTMLTextAreaElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const m = useMonitoring()
  const present = useAppStore((s) => s.snapshot?.presence === 'active')
  // the same reasons runCheck() would give, shown before the click instead of after it
  const checkBlocked = m.paused
    ? 'Resume monitoring to check your posture.'
    : !m.live || !present
      ? 'Sit in view of the camera first — SitSense needs to see you.'
      : null

  const setRefs = (el: HTMLTextAreaElement | null): void => {
    local.current = el
    if (typeof textareaRef === 'function') textareaRef(el)
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el
  }

  // grow from 1 to 5 lines
  useLayoutEffect(() => {
    const el = local.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, LINE * MAX_LINES + PAD_Y)}px`
  }, [draft])

  // a reply finished: back to the composer — unless the user is busy elsewhere (a Copy
  // button, a code block, a context toggle); only from nowhere or from inside the composer
  useEffect(() => {
    if (pending) return
    const active = document.activeElement
    if (active === document.body || active === null || rootRef.current?.contains(active)) local.current?.focus({ preventScroll: true })
  }, [pending])

  const canSend = draft.trim().length > 0 && !pending && blockedReason === null
  /** fromDraft = false for a suggested question: the half-written draft stays */
  const submit = (text = draft, fromDraft = true): void => {
    if (!text.trim() || pending || blockedReason) return
    send(text)
    if (fromDraft) setDraft('')
  }

  const lastUserText = (): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && m.kind === 'text') return m.text
    }
    return null
  }

  const sendButton = pending ? (
    <Button variant="secondary" icon="stop" ringOn="card-2" onClick={stop} aria-label="Stop the reply">
      Stop
    </Button>
  ) : (
    <Button variant="primary" icon="send" ringOn="card-2" disabled={!canSend} onClick={() => submit()}>
      Send
    </Button>
  )

  const counter = draft.length >= COUNTER_FROM

  return (
    <div ref={rootRef} className="flex shrink-0 flex-col gap-3 border-t border-white/[0.06] px-5 pt-3.5 pb-4">
      {prompts.length > 0 && <PromptChips prompts={prompts} onPick={(p) => submit(p, false)} disabled={!!pending || blockedReason !== null} />}
      <div className="relative rounded-xl bg-card-2 ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.6)] transition-shadow duration-150 hover:ring-hairline-strong focus-within:ring-sage/60!">
        <label htmlFor="coach-composer" className="sr-only">
          Message your coach
        </label>
        <textarea
          id="coach-composer"
          ref={setRefs}
          rows={1}
          value={draft}
          maxLength={COMPOSER_MAX}
          placeholder="Ask about your posture, desk or a stretch…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'ArrowUp' && draft === '') {
              const t = lastUserText()
              if (t) {
                e.preventDefault()
                setDraft(t)
                requestAnimationFrame(() => {
                  const el = local.current
                  if (el) el.setSelectionRange(el.value.length, el.value.length)
                })
              }
            }
          }}
          className="block max-h-[120px] min-h-9 w-full resize-none bg-transparent py-[7px] pr-[92px] pb-2 pl-3.5 type-body-lg text-text placeholder:text-text-faint focus:outline-none"
        />
        <div className="absolute right-0.5 bottom-0.5">
          {blockedReason && !pending ? (
            <Tooltip content={blockedReason}>
              <span tabIndex={0} className="inline-flex rounded-[10px] focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none">
                {sendButton}
              </span>
            </Tooltip>
          ) : (
            sendButton
          )}
        </div>
      </div>
      <div className="flex min-h-7 items-center gap-3">
        <Tooltip content={pending ? null : checkBlocked} placement="top" align="start">
          <Button size="sm" variant="ghost" icon="camera" ringOn="card" className="-ml-2.5" pending={!!pending || !!checkBlocked} onClick={checkPosture}>
            Check my posture now
          </Button>
        </Tooltip>
        <span className="min-w-0 flex-1" />
        {counter && (
          <span className={`shrink-0 font-mono text-[12px] leading-4 tabular-nums ${draft.length >= COMPOSER_MAX ? 'text-text' : 'text-text-dim'}`}>
            {draft.length}/{COMPOSER_MAX}
          </span>
        )}
        {aside ??
          (!counter && (
            <span className="flex min-w-0 items-center gap-1.5 truncate type-caption text-text-faint">
              <Icon name="keyboard" size={14} />
              <span className="truncate">Enter to send · Shift+Enter for a new line</span>
            </span>
          ))}
      </div>
      {below}
    </div>
  )
}
