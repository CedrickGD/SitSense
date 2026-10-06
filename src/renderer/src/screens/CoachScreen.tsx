// Coach (docs/specs/ui-v3.md §4): a chat with an AI coach that can see the user's posture
// numbers. Local-first — nothing is sent unless the user sends a message or presses
// "Check my posture now"; the history stays on this PC (coach/coachStore.ts).
//
// Shell contract: this route fills the content height (no page scroll — the message list
// scrolls inside the chat card). Live hands over questions / checks with `coachIntent`;
// `coachPending` (set by the coach store) puts the sage dot on the Coach nav item.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAppStore } from '@renderer/state/store'
import { TopBarContent } from '@renderer/components/AppShell'
import { usableConnections } from '@renderer/ai/helpers'
import { presetForConnection } from '@renderer/components/ai-settings'
import { Icon } from '@renderer/components/icons'
import { Button, Card, ConfirmButton, EmptyState, LinkButton, Skeleton, Tooltip } from '@renderer/components/primitives'
import { useMonitoring, useWindowWidth } from '@renderer/lib/hooks'
import { suggestedPrompts } from './coach/chat'
import { useCoachStore } from './coach/coachStore'
import { Composer } from './coach/Composer'
import { ContextChips, ContextPanel, privacyLine } from './coach/ContextPanel'
import { isLocalConnection } from './coach/context'
import { MessageList } from './coach/MessageList'
import { CoachIllustration } from './coach/parts'

/** Below this window width the context panel becomes chips above the composer (§4.1). */
const PANEL_MIN_WINDOW = 1100

const OFFLINE_TEXT = 'You’re offline. Messages will work again once you’re connected — local models like Ollama still work.'

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

/** A slim notice strip at the top of the chat card. */
function Strip({ icon, children, action }: { icon: 'info' | 'pause'; children: string; action?: JSX.Element }): JSX.Element {
  return (
    <div role="status" className="flex shrink-0 items-center gap-2.5 border-b border-white/[0.06] bg-slate-cool/[0.07] px-5 py-2.5">
      <span className="text-slate-cool">
        <Icon name={icon} size={16} />
      </span>
      <p className="min-w-0 flex-1 type-body text-text-dim">{children}</p>
      {action}
    </div>
  )
}

/** Narrow windows: the privacy note in at most two caption lines (full text in the tooltip). */
function PrivacyLine({ text }: { text: string }): JSX.Element {
  return (
    <Tooltip content={text} placement="top" align="start">
      <p tabIndex={0} className="flex min-w-0 items-start gap-1.5 rounded-md type-caption text-text-faint focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none">
        <Icon name="lock" size={14} className="mt-px shrink-0" />
        <span className="line-clamp-2 min-w-0">{text}</span>
      </p>
    </Tooltip>
  )
}

export default function CoachScreen(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const openSettings = useAppStore((s) => s.openSettings)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const coachIntent = useAppStore((s) => s.coachIntent)
  const consumeCoachIntent = useAppStore((s) => s.consumeCoachIntent)

  const messages = useCoachStore((s) => s.messages)
  const pending = useCoachStore((s) => s.pending)
  const promptSeed = useCoachStore((s) => s.promptSeed)
  const send = useCoachStore((s) => s.send)
  const clear = useCoachStore((s) => s.clear)
  const checkPosture = useCoachStore((s) => s.checkPosture)
  const setDraft = useCoachStore((s) => s.setDraft)

  const width = useWindowWidth()
  const wide = width >= PANEL_MIN_WINDOW
  const compact = width < 1000
  const online = useOnline()
  const m = useMonitoring()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [turningOn, setTurningOn] = useState(false)

  const usable = usableConnections(settings)
  const conn = usable[0] ?? null
  const aiOff = !!settings && !settings.ai.enabled && settings.ai.connections.some((c) => c.enabled)
  const ready = conn !== null
  const allRemote = usable.length > 0 && usable.every((c) => !isLocalConnection(c, presetForConnection(c).baseUrl))
  const offline = ready && !online && allRemote

  const hasConversation = messages.some((x) => x.role !== 'system')
  const lastReal = [...messages].reverse().find((x) => x.role !== 'system')
  const asked = useMemo(() => messages.filter((x) => x.role === 'user' && x.kind === 'text').map((x) => x.text), [messages])
  const greetingPrompts = useMemo(() => suggestedPrompts(promptSeed, 4), [promptSeed])
  const followUps =
    !pending && lastReal?.role === 'assistant' && lastReal.kind !== 'error' ? suggestedPrompts(promptSeed, 3, asked) : []

  // Live → Coach handoff: a question or a posture check, handled once
  useEffect(() => {
    if (!coachIntent || !settings) return
    consumeCoachIntent(coachIntent.id)
    if (coachIntent.kind === 'ask') {
      if (ready && !pending && !offline) send(coachIntent.text)
      else setDraft(coachIntent.text)
    } else if (coachIntent.kind === 'check' && ready && !pending) {
      // only an explicit check sends pose data — never an unknown (newer) intent kind
      checkPosture()
    }
  }, [coachIntent, settings, ready, pending, offline, send, setDraft, checkPosture, consumeCoachIntent])

  // Ctrl+L focuses the composer from anywhere on Coach
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const topBar = (
    <TopBarContent sub={conn ? `${conn.label}${conn.model ? ` · ${conn.model}` : ''}` : undefined}>
      {ready && (
        <ConfirmButton
          size="sm"
          variant="ghost"
          icon="trash"
          disabled={!hasConversation && !pending}
          message="Clear the whole conversation? This can’t be undone."
          confirmLabel="Clear"
          onConfirm={clear}
        >
          Clear chat
        </ConfirmButton>
      )}
    </TopBarContent>
  )

  let body: JSX.Element
  if (!settings) {
    body = (
      <div className="flex flex-1 flex-col gap-4 p-6">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-10 w-1/3" />
        <Skeleton className="h-24 w-3/4" />
      </div>
    )
  } else if (aiOff) {
    body = (
      <EmptyState
        icon={<CoachIllustration />}
        headline="Your AI model is turned off"
        body="Turn it on to ask your coach about your posture, your desk or a stretch. On-device posture tracking keeps working either way."
        primary={
          <Button
            variant="primary"
            size="lg"
            icon="spark"
            loading={turningOn}
            onClick={() => {
              setTurningOn(true)
              void patchSettings({ ai: { enabled: true } }).finally(() => setTurningOn(false))
            }}
          >
            {turningOn ? 'Turning on…' : 'Turn on AI'}
          </Button>
        }
        secondary={
          <Button variant="ghost" size="lg" onClick={() => openSettings('ai')}>
            Open AI settings
          </Button>
        }
      />
    )
  } else if (!ready) {
    body = (
      <EmptyState
        icon={<CoachIllustration />}
        headline="Your coach needs an AI model"
        body="Connect your own AI model — Gemini, OpenAI, Anthropic, OpenRouter, or a local one like Ollama. On-device posture tracking keeps working without it."
        primary={
          <Button variant="primary" size="lg" icon="plus" onClick={() => openSettings('ai')}>
            Connect a model
          </Button>
        }
        secondary={
          <Button variant="ghost" size="lg" icon="shield" onClick={() => openSettings('privacy')}>
            How privacy works
          </Button>
        }
      />
    )
  } else {
    body = (
      <>
        {offline ? (
          <Strip icon="info">{OFFLINE_TEXT}</Strip>
        ) : m.paused ? (
          <Strip
            icon="pause"
            action={
              <LinkButton className="shrink-0" onClick={() => void window.sitsense.setPause(false, null)}>
                Resume
              </LinkButton>
            }
          >
            Monitoring is paused — your coach can’t see live numbers or check your posture.
          </Strip>
        ) : null}
        <MessageList
          messages={messages}
          pending={pending}
          greeting={!hasConversation}
          greetingPrompts={greetingPrompts}
          onPrompt={(p) => send(p)}
          promptsDisabled={!!pending || offline}
        />
        <Composer
          textareaRef={textareaRef}
          blockedReason={offline ? 'You’re offline — connect to the internet or use a local model.' : null}
          prompts={hasConversation ? followUps : []}
          aside={wide ? undefined : <ContextChips showLabel={!compact} />}
          below={wide ? undefined : <PrivacyLine text={`${privacyLine(conn)} Your chat history stays on this PC.`} />}
        />
      </>
    )
  }

  const showPanel = wide && !!settings
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1056px] gap-4">
      {topBar}
      <Card flush aria-label="Coach chat" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {body}
      </Card>
      {showPanel && <ContextPanel conn={conn} share={settings.ai.share} aiOff={aiOff} />}
    </div>
  )
}
