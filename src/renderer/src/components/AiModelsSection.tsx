// Settings › AI models (docs/specs/ui-v3.md §6.2, ai-providers.md §6).
// Keys go to main and never come back: the form shows only "Saved key …x2Ig", and a
// typed key is cleared from React state as soon as it has been handed to main.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import {
  AI_LIMITS,
  AI_PRESETS,
  aiErrorMessage,
  type AiConnection,
  type AiShareMode,
  type AiTestResult
} from '@shared/ai'
import type { Settings } from '@shared/settings'
import { useAppStore } from '@renderer/state/store'
import { Saved, SettingRow, SettingsCard, SettingsGrid, useCommit } from '@renderer/screens/settings/parts'
import { Button, FIELD_CLASS, IconButton, LinkButton, Menu, MetaItem, MetaRow, Spinner, Toggle, focusRing } from './primitives'
import { Icon, type IconName } from './icons'
import {
  aiStatus,
  baseUrlAlwaysVisible,
  connectionProblem,
  connectionUsable,
  draftDiffers,
  draftForConnection,
  draftForPreset,
  draftPayload,
  findNewConnectionId,
  formatAgo,
  hasBaseUrlOverride,
  keyArgument,
  keyPrefixHint,
  modelSuggestions,
  presetById,
  presetForConnection,
  providerGlyph,
  recipientPhrases,
  saveDropsKey,
  shareDisclosure,
  switchPreset,
  testStatus,
  type ConnectionDraft,
  type KeyAction
} from './ai-settings'

type TestState = { running: true } | { running: false; result: AiTestResult }
type FormTarget = { mode: 'add' } | { mode: 'edit'; id: string }

const focusById = (id: string): void => {
  requestAnimationFrame(() => document.getElementById(id)?.focus())
}

/** Focus the first target that is on screen and enabled: element ids, or selectors starting with "[". */
const focusFirst = (...targets: (string | null)[]): void => {
  requestAnimationFrame(() => {
    for (const t of targets) {
      if (!t) continue
      const el = t.startsWith('[') ? document.querySelector<HTMLElement>(t) : document.getElementById(t)
      if (el && !(el as HTMLButtonElement).disabled) {
        el.focus()
        return
      }
    }
  })
}

/** After controls were disabled while saving: put focus back if it fell to the page. */
const restoreFocus = (el: Element | null): void => {
  if (!(el instanceof HTMLElement)) return
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (el.isConnected && (!active || active === document.body)) el.focus()
  })
}

const applySettings = (s: Settings): void => useAppStore.setState({ settings: s })

// ─────────────────────────────── the AI models category ───────────────────────────────

export default function AiModelsSection(): JSX.Element | null {
  const ai = useAppStore((s) => s.settings?.ai)
  const { commit } = useCommit()
  const masterSubId = useId()
  if (!ai) return null
  const status = aiStatus(ai)

  return (
    <SettingsGrid>
      {/* status hero */}
      <SettingsCard span={12}>
        <div className="flex items-start gap-4">
          <span
            aria-hidden
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 transition-colors duration-150 ${
              ai.enabled ? 'bg-sage-soft text-sage ring-sage/20' : 'bg-card-2 text-text-faint ring-white/[0.06]'
            }`}
          >
            <Icon name="spark" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-4">
              <h3 className="type-title text-text">Use a connected AI model</h3>
              <span className="flex shrink-0 items-center gap-3">
                <Saved k="ai-enabled" />
                <Toggle
                  label="Use a connected AI model"
                  describedBy={masterSubId}
                  checked={ai.enabled}
                  onChange={(v) => commit('ai-enabled', { ai: { enabled: v } })}
                />
              </span>
            </div>
            <p id={masterSubId} className="mt-1 max-w-[68ch] type-body text-text-dim">
              On-device AI always watches your posture. A connected model double-checks setup, answers the coach and
              checks your posture when you ask.
            </p>
            <p
              role="status"
              className={`mt-3 inline-flex max-w-full items-center gap-2 rounded-full px-2.5 py-1 type-caption ${
                status.kind === 'ok'
                  ? 'bg-sage-soft text-sage'
                  : status.kind === 'broken'
                    ? 'bg-amber/12 text-amber'
                    : 'bg-white/[0.05] text-text-dim'
              }`}
            >
              <Icon name={status.kind === 'off' ? 'lock' : status.kind === 'ok' ? 'check' : 'alert'} size={14} />
              <span className="truncate">{status.text}</span>
            </p>
          </div>
        </div>
      </SettingsCard>

      {ai.enabled ? (
        <>
          <ShareCard share={ai.share} recipients={recipientPhrases(ai.connections)} />
          <WhereCard useInSetup={ai.useInSetup} />
          <ConnectionsCard />
        </>
      ) : (
        <>
          <BenefitsCard />
          {/* keys and connections stay editable (and removable) with AI off */}
          {ai.connections.length > 0 && <ConnectionsCard dimmed />}
        </>
      )}
    </SettingsGrid>
  )
}

// ─────────────────────────────── AI off: what it adds ───────────────────────────────

const BENEFITS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'setup',
    title: 'A second opinion on setup',
    body: 'Checks what the camera can’t — like a slump when your hips are out of view.'
  },
  {
    icon: 'coach',
    title: 'A coach to talk to',
    body: 'Ask about your posture, your day or your desk. It sees the live numbers.'
  },
  {
    icon: 'lock',
    title: 'Your key, your choice',
    body: 'Gemini, OpenAI, Anthropic, OpenRouter — or a model on this PC with Ollama or LM Studio.'
  }
]

function BenefitsCard(): JSX.Element {
  return (
    <SettingsCard span={12} eyebrow="What a connected model adds">
      <ul className="grid grid-cols-1 gap-3 @min-[600px]:grid-cols-3">
        {BENEFITS.map((b) => (
          <li key={b.title} className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/[0.06]">
            <Icon name={b.icon} size={20} className="text-sage" />
            <p className="type-body font-medium text-text">{b.title}</p>
            <p className="type-caption text-text-dim">{b.body}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 type-caption text-text-faint">
        Turn it on above to connect a model. Nothing is sent until you do.
      </p>
    </SettingsCard>
  )
}

// ─────────────────────────────── what's sent ───────────────────────────────

function SketchArt(): JSX.Element {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden>
      <rect x="0.5" y="0.5" width="55" height="55" rx="10" fill="var(--color-ink)" stroke="rgb(255 255 255 / 0.08)" />
      <line x1="31" y1="10" x2="31" y2="48" stroke="var(--color-text-faint)" strokeWidth="1" strokeDasharray="2 3" />
      <polyline points="26,15 28,25 30,41" fill="none" stroke="var(--color-sage)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="26" cy="15" r="3" fill="var(--color-sage)" />
      <circle cx="28" cy="25" r="2.5" fill="var(--color-sage)" />
      <circle cx="30" cy="41" r="2.5" fill="var(--color-sage)" />
    </svg>
  )
}

function SnapshotArt(): JSX.Element {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden>
      <rect x="0.5" y="0.5" width="55" height="55" rx="10" fill="#2f3a33" stroke="rgb(255 255 255 / 0.08)" />
      <rect x="6" y="34" width="44" height="16" rx="3" fill="#3b4a40" />
      <circle cx="28" cy="20" r="7" fill="var(--color-text-dim)" />
      <path d="M14 50c1.5-9 7-13 14-13s12.5 4 14 13z" fill="var(--color-text-dim)" />
      <rect x="40" y="7" width="9" height="6" rx="1.5" fill="none" stroke="var(--color-text-faint)" strokeWidth="1.2" />
    </svg>
  )
}

const SHARE_OPTIONS: { value: AiShareMode; title: string; body: string; art: () => JSX.Element }[] = [
  { value: 'sketch', title: 'Pose sketch', body: 'Lines and dots only — no camera image.', art: SketchArt },
  { value: 'snapshot', title: 'Camera snapshot', body: 'A small, downscaled frame from your camera.', art: SnapshotArt }
]

function ShareCard({ share, recipients }: { share: AiShareMode; recipients: string[] }): JSX.Element {
  const { commit } = useCommit()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const descId = useId()
  const pick = (v: AiShareMode): void => {
    if (v !== share) commit('ai-share', { ai: { share: v } })
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const next = (i + 1) % SHARE_OPTIONS.length
    refs.current[next]?.focus()
    pick(SHARE_OPTIONS[next].value)
  }
  return (
    <SettingsCard span={7} eyebrow="What’s sent" className="@container" action={<Saved k="ai-share" />}>
      <div role="radiogroup" aria-label="What’s sent" aria-describedby={descId} className="grid grid-cols-1 gap-3 @min-[440px]:grid-cols-2">
        {SHARE_OPTIONS.map((o, i) => {
          const selected = o.value === share
          const Art = o.art
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => pick(o.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`relative flex min-h-20 items-center gap-3 rounded-xl p-3 @min-[440px]:min-h-28 @min-[440px]:items-start text-left transition-[background-color,box-shadow] duration-150 ${focusRing('card')} ${
                selected ? 'bg-sage-soft ring-2 ring-sage' : 'bg-white/[0.03] ring-1 ring-white/[0.08] hover:bg-white/[0.05] hover:ring-hairline-strong'
              }`}
            >
              <Art />
              <span className="min-w-0 pr-5">
                <span className={`block type-body font-medium ${selected ? 'text-text' : 'text-text'}`}>{o.title}</span>
                <span className="mt-0.5 block type-caption text-text-dim">{o.body}</span>
              </span>
              {selected && (
                <span className="absolute top-2.5 right-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-sage text-ink">
                  <Icon name="check" size={12} strokeWidth={2.6} />
                </span>
              )}
            </button>
          )
        })}
      </div>
      <p id={descId} className="mt-3 max-w-[68ch] type-caption text-text-dim">
        {recipients.length > 0
          ? shareDisclosure(share, recipients)
          : `Nothing yet — no connection is ready (missing key or model). Once one is: ${shareDisclosure(share, null)}`}
      </p>
    </SettingsCard>
  )
}

// ─────────────────────────────── where AI helps ───────────────────────────────

function WhereCard({ useInSetup }: { useInSetup: boolean }): JSX.Element {
  const { commit } = useCommit()
  const setRoute = useAppStore((s) => s.setRoute)
  const setupId = useId()
  const coachId = useId()
  return (
    <SettingsCard span={5} eyebrow="Where AI helps">
      <div className="flex flex-1 flex-col gap-3">
        <SettingRow
          label="Double-check posture setup"
          description="Before saving your posture, setup asks your model to confirm it."
          descriptionId={setupId}
          savedKey="ai-setup"
          control={
            <Toggle
              label="Double-check posture setup"
              describedBy={setupId}
              checked={useInSetup}
              onChange={(v) => commit('ai-setup', { ai: { useInSetup: v } })}
            />
          }
        />
        <hr className="my-1 border-0 border-t border-white/[0.06]" />
        <div className="flex flex-col gap-1">
          <p className="type-body font-medium text-text">Coach chat</p>
          <p id={coachId} className="type-caption text-text-dim">
            Answers your questions and checks your posture when you ask — using the connections below.
          </p>
          <LinkButton arrow className="mt-1 self-start" onClick={() => setRoute('coach')} aria-describedby={coachId}>
            Open Coach
          </LinkButton>
        </div>
        <p className="mt-auto flex items-start gap-2 pt-2 type-caption text-text-faint">
          <Icon name="shield" size={14} className="mt-px shrink-0" />
          Never runs in the background. While paused, only coach questions are answered — nothing from the camera is sent.
        </p>
      </div>
    </SettingsCard>
  )
}

// ─────────────────────────────── connections ───────────────────────────────

function ConnectionsCard({ dimmed = false }: { dimmed?: boolean }): JSX.Element | null {
  const ai = useAppStore((s) => s.settings?.ai)
  const settings = useAppStore((s) => s.settings)
  const [form, setForm] = useState<FormTarget | null>(null)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // per connection: the newest Test run; an older one resolving late must not replace its result
  const testSeq = useRef<Record<string, number>>({})
  const listLabelId = useId()

  // keep "tested 3 min ago" honest while the screen is open
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // a connection removed elsewhere (or by a test that failed validation) closes its form
  useEffect(() => {
    if (form?.mode === 'edit' && ai && !ai.connections.some((c) => c.id === form.id)) setForm(null)
  }, [ai, form])

  if (!ai || !settings) return null

  // the badge marks the connection a request really tries first — never one that can't be called
  const primary = ai.connections.find(connectionUsable) ?? null

  const run = async (id: string, fn: () => Promise<Settings>): Promise<boolean> => {
    setBusy(id)
    setError(null)
    try {
      applySettings(await fn())
      return true
    } catch (e) {
      setError(aiErrorMessage(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (id: string): Promise<void> => {
    const seq = (testSeq.current[id] ?? 0) + 1
    testSeq.current[id] = seq
    setTests((t) => ({ ...t, [id]: { running: true } }))
    let result: AiTestResult
    try {
      result = await window.sitsense.aiTestConnection(id)
    } catch (e) {
      result = { ok: false, message: aiErrorMessage(e), latencyMs: null }
    }
    if (testSeq.current[id] !== seq) return // a newer Test of this connection owns the row
    // AI switched off meanwhile: the test was cancelled and says nothing about the connection
    const cancelled = !useAppStore.getState().settings?.ai.enabled
    setTests((t) => {
      const next = { ...t }
      if (cancelled) delete next[id]
      else next[id] = { running: false, result }
      return next
    })
  }

  const move = async (c: AiConnection, delta: -1 | 1): Promise<void> => {
    const ok = await run(c.id, () => window.sitsense.aiMoveConnection(c.id, delta))
    // keep focus on the moved row's menu button
    if (ok) focusById(`ai-more-${c.id}`)
  }

  const remove = async (c: AiConnection): Promise<void> => {
    const i = ai.connections.findIndex((x) => x.id === c.id)
    const neighbour = ai.connections[i + 1] ?? ai.connections[i - 1] ?? null
    const ok = await run(c.id, () => window.sitsense.aiRemoveConnection(c.id))
    if (!ok) return
    setConfirmRemove(null)
    setTests((t) => {
      const next = { ...t }
      delete next[c.id]
      return next
    })
    // "Add connection" is hidden while the add form is open: fall back to a neighbour or the form
    focusFirst('ai-add', neighbour ? `ai-edit-${neighbour.id}` : null, '[data-ai-form-first]')
  }

  const closeForm = (returnFocusTo: string): void => {
    setForm(null)
    focusById(returnFocusTo)
  }

  const full = ai.connections.length >= AI_LIMITS.maxConnections

  return (
    <SettingsCard
      span={12}
      eyebrow="Connections"
      className={dimmed ? 'opacity-75 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100' : ''}
    >
      {dimmed ? (
        <p id={listLabelId} className="-mt-1 mb-4 flex max-w-[68ch] items-start gap-2 type-caption text-text-dim">
          <Icon name="lock" size={14} className="mt-px shrink-0 text-sage" />
          AI is off — nothing is sent. You can still edit or remove connections.
        </p>
      ) : (
        <p id={listLabelId} className="-mt-1 mb-4 max-w-[68ch] type-caption text-text-dim">
          The first one that’s on is asked first; the others take over if it can’t answer.
        </p>
      )}

      {error && (
        <p role="alert" className="mb-3 flex items-center gap-2 type-caption text-coral">
          <Icon name="alert" size={14} />
          {error}
        </p>
      )}
      {!dimmed && ai.connections.length > 0 && !primary && (
        <p className="mb-3 type-caption text-amber">No connection is ready — turn one on and add its key.</p>
      )}

      <div className="flex flex-col gap-2">
        {ai.connections.length > 0 && (
          <ol aria-labelledby={listLabelId} className="flex flex-col gap-2">
            {ai.connections.map((c, i) => (
              <ConnectionRow
                key={c.id}
                conn={c}
                index={i}
                count={ai.connections.length}
                isPrimary={!dimmed && primary?.id === c.id}
                busy={busy === c.id}
                test={tests[c.id]}
                now={now}
                confirming={confirmRemove === c.id}
                editing={form?.mode === 'edit' && form.id === c.id}
                onToggle={(v) => void run(c.id, () => window.sitsense.aiSaveConnection({ id: c.id, enabled: v }))}
                onMove={(d) => void move(c, d)}
                onTest={() => void runTest(c.id)}
                onEdit={() => {
                  setForm({ mode: 'edit', id: c.id })
                  setConfirmRemove(null)
                }}
                onAskRemove={() => setConfirmRemove(c.id)}
                onCancelRemove={() => {
                  setConfirmRemove(null)
                  focusById(`ai-more-${c.id}`)
                }}
                onRemove={() => void remove(c)}
                form={
                  form?.mode === 'edit' && form.id === c.id ? (
                    <ConnectionForm
                      existing={c}
                      onCancel={() => closeForm(`ai-edit-${c.id}`)}
                      onSaved={(id) => {
                        setForm(null)
                        focusById(`ai-test-${id}`)
                        if (!dimmed) void runTest(id)
                      }}
                    />
                  ) : null
                }
              />
            ))}
          </ol>
        )}

        {form?.mode === 'add' ? (
          <ConnectionForm
            existing={null}
            onCancel={() => closeForm('ai-add')}
            onSaved={(id) => {
              setForm(null)
              focusById(`ai-test-${id}`)
              if (!dimmed) void runTest(id)
            }}
          />
        ) : (
          <button
            id="ai-add"
            type="button"
            disabled={full}
            onClick={() => {
              setForm({ mode: 'add' })
              setConfirmRemove(null)
            }}
            className={`flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-hairline-strong px-4 py-3 type-body font-medium text-text-dim transition-colors duration-150 enabled:hover:border-sage/50 enabled:hover:bg-white/[0.03] enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-40 ${focusRing('card')}`}
          >
            <Icon name="plus" size={16} />
            Add connection
            {ai.connections.length === 0 && (
              <span className="hidden type-caption font-normal text-text-faint @min-[600px]:inline">
                · Gemini, OpenAI, Anthropic, OpenRouter, Ollama or LM Studio
              </span>
            )}
          </button>
        )}
        {full && form?.mode !== 'add' && (
          <p className="type-caption text-text-dim">
            You can add up to {AI_LIMITS.maxConnections} connections — remove one to add another.
          </p>
        )}
      </div>
    </SettingsCard>
  )
}

// ─────────────────────────────── row ───────────────────────────────

interface RowProps {
  conn: AiConnection
  index: number
  count: number
  isPrimary: boolean
  busy: boolean
  test: TestState | undefined
  now: number
  confirming: boolean
  editing: boolean
  form: JSX.Element | null
  onToggle: (v: boolean) => void
  onMove: (delta: -1 | 1) => void
  onTest: () => void
  onEdit: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
}

const STATUS_DOT: Record<ReturnType<typeof testStatus>, string> = {
  ok: 'bg-sage',
  failed: 'bg-coral',
  untested: 'bg-text-faint'
}

function ConnectionRow(p: RowProps): JSX.Element {
  const { conn: c } = p
  const preset = presetForConnection(c)
  const status = testStatus(c)
  const problem = connectionProblem(c)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const nameId = useId()

  useEffect(() => {
    if (p.confirming) cancelRef.current?.focus()
  }, [p.confirming])

  const statusWord =
    status === 'ok'
      ? `Tested ${formatAgo(c.lastTest!.at, p.now)}`
      : status === 'failed'
        ? `Last test failed ${formatAgo(c.lastTest!.at, p.now)}`
        : 'Not tested yet'

  return (
    <li
      aria-labelledby={nameId}
      aria-busy={p.busy || undefined}
      className={`rounded-xl p-3 ring-1 transition-[background-color,box-shadow] duration-150 ${
        p.editing ? 'surface-raised' : 'bg-white/[0.025] ring-white/[0.06] hover:bg-card-2 hover:ring-white/10'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          aria-hidden
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-card-2 font-display text-[13px] font-semibold text-text-dim ring-1 ring-white/[0.08] ${
            c.enabled ? '' : 'opacity-50'
          }`}
        >
          {providerGlyph(preset)}
        </span>
        <div className={`min-w-0 flex-1 basis-48 ${c.enabled ? '' : 'opacity-60'}`}>
          <div className="flex items-center gap-2">
            <span id={nameId} className="truncate type-body font-medium text-text">
              {c.label}
            </span>
            {p.isPrimary && (
              <span className="shrink-0 rounded-full bg-sage-soft px-2 py-px type-caption font-medium text-sage">Primary</span>
            )}
            {!c.enabled && <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-px type-caption text-text-dim">Off</span>}
            {c.enabled && problem && (
              <span className="shrink-0 rounded-full bg-amber/12 px-2 py-px type-caption text-amber">{problem}</span>
            )}
          </div>
          {/* wraps rather than squeezing the model name (the one fact that matters) to "gemini-3…" */}
          <MetaRow className="mt-0.5 gap-y-0.5 type-caption text-text-dim">
            <MetaItem className="font-mono" title={c.model || undefined}>
              <span className="min-w-0 truncate">{c.model || 'no model chosen'}</span>
            </MetaItem>
            {c.label !== preset.label && <MetaItem className="whitespace-nowrap text-text-faint">{preset.label}</MetaItem>}
            <MetaItem className="gap-1.5 whitespace-nowrap">
              <span
                aria-hidden
                title={c.lastTest?.message || undefined}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
              />
              {statusWord}
            </MetaItem>
          </MetaRow>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!p.editing && (
            <>
              <Button
                id={`ai-test-${c.id}`}
                size="sm"
                variant="ghost"
                ringOn="card"
                aria-label={`Test ${c.label}`}
                loading={p.test?.running}
                pending={p.busy}
                onClick={p.onTest}
              >
                {p.test?.running ? 'Testing…' : 'Test'}
              </Button>
              <Button
                id={`ai-edit-${c.id}`}
                size="sm"
                variant="ghost"
                ringOn="card"
                aria-label={`Edit ${c.label}`}
                pending={p.busy}
                onClick={p.onEdit}
              >
                Edit
              </Button>
              <Menu
                align="right"
                ariaLabel={`${c.label} actions`}
                trigger={<IconButton id={`ai-more-${c.id}`} icon="more" label={`More for ${c.label}`} size={28} ringOn="card" />}
                items={[
                  { label: 'Move up', icon: 'chevron-up', disabled: p.index === 0 || p.busy, onClick: () => p.onMove(-1) },
                  {
                    label: 'Move down',
                    icon: 'chevron-down',
                    disabled: p.index === p.count - 1 || p.busy,
                    onClick: () => p.onMove(1)
                  },
                  { label: 'Remove', icon: 'trash', danger: true, disabled: p.busy, onClick: p.onAskRemove }
                ]}
              />
              <span aria-hidden className="mx-1.5 h-5 w-px bg-white/[0.08]" />
            </>
          )}
          <Toggle label={`Use ${c.label}`} checked={c.enabled} pending={p.busy} onChange={p.onToggle} />
        </div>
      </div>

      <div aria-live="polite" className="pl-12">
        {p.test && <TestLine test={p.test} />}
      </div>

      {p.confirming && (
        <div
          role="group"
          aria-label={`Remove ${c.label}?`}
          className="mt-3 ml-12 flex flex-wrap items-center gap-2 rounded-[10px] bg-coral/10 px-3 py-2 ring-1 ring-coral/20"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              p.onCancelRemove()
            }
          }}
        >
          <span className="flex-1 type-caption text-text">
            Remove {c.label}?{c.hasKey && ' Its saved key is deleted too.'}
          </span>
          <Button ref={cancelRef} size="sm" variant="ghost" ringOn="card" onClick={p.onCancelRemove}>
            Cancel
          </Button>
          <Button size="sm" variant="secondary" ringOn="card" className="text-coral!" pending={p.busy} onClick={p.onRemove}>
            Remove
          </Button>
        </div>
      )}

      {p.form}
    </li>
  )
}

function TestLine({ test }: { test: TestState }): JSX.Element {
  if (test.running) {
    return (
      <p className="mt-2 flex items-center gap-2 type-caption text-text-dim">
        <Spinner size={12} />
        Testing…
      </p>
    )
  }
  const r = test.result
  const latency = r.latencyMs !== null ? ` · ${r.latencyMs} ms` : ''
  if (!r.ok)
    return (
      <p className="mt-2 flex items-start gap-1.5 type-caption text-coral">
        <Icon name="alert" size={14} className="mt-px shrink-0" />
        <span>Didn’t work: {r.message}</span>
      </p>
    )
  return (
    <p className="mt-2 flex items-start gap-1.5 type-caption text-sage">
      <Icon name="check" size={14} className="mt-px shrink-0" />
      <span>
        {r.switchedKind ? r.message : r.message || 'Works.'}
        <span className="font-mono text-text-faint">{latency}</span>
      </span>
    </p>
  )
}

// ─────────────────────────────── add / edit form ───────────────────────────────

interface FormProps {
  existing: AiConnection | null
  onCancel: () => void
  /** saved (and the form should close): the caller runs Test on it */
  onSaved: (id: string) => void
}

function ConnectionForm({ existing, onCancel, onSaved }: FormProps): JSX.Element {
  const connections = useAppStore((s) => s.settings?.ai.connections) ?? []
  // a new connection gets an id the first time it is saved (e.g. by Load models)
  const [connId, setConnId] = useState<string | null>(existing?.id ?? null)
  const saved = connections.find((c) => c.id === connId) ?? null
  const [draft, setDraft] = useState<ConnectionDraft>(() =>
    existing ? draftForConnection(existing) : draftForPreset(AI_PRESETS[0])
  )
  const [keyInput, setKeyInput] = useState('')
  const [keyAction, setKeyAction] = useState<KeyAction>('keep')
  // a hosted provider that already uses its own base URL shows it straight away
  const [advanced, setAdvanced] = useState(() => hasBaseUrlOverride(draft))
  const [saving, setSaving] = useState(false)
  /** something was saved (e.g. by Load models): Cancel can no longer undo it, so it reads Close */
  const [savedOnce, setSavedOnce] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [modelsNote, setModelsNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const firstRef = useRef<HTMLSelectElement>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const ids = {
    provider: useId(),
    label: useId(),
    key: useId(),
    keyHelp: useId(),
    keyHint: useId(),
    baseUrl: useId(),
    baseUrlHelp: useId(),
    model: useId(),
    models: useId(),
    title: useId()
  }

  useEffect(() => firstRef.current?.focus(), [])

  const preset = presetById(draft.presetId)
  const hasSavedKey = !!saved?.hasKey
  const showKeyInput = !hasSavedKey || keyAction === 'replace'
  const showBaseUrl = baseUrlAlwaysVisible(preset) || advanced
  const hint = showKeyInput ? keyPrefixHint(preset, keyInput) : null
  // main deletes a kept key whenever the endpoint's origin changes (provider, or just host/port)
  const dropsKey = hasSavedKey && keyAction === 'keep' && saved ? saveDropsKey(saved, draft) : null
  const unsaved = draftDiffers(saved, draft) || keyAction !== 'keep' || keyInput.trim() !== ''

  /** Save the draft; returns the connection id, or null on failure. The typed key leaves React state here. */
  const save = async (): Promise<string | null> => {
    const key = keyArgument(keyAction, keyInput)
    const sentKey = typeof key === 'string'
    const focused = document.activeElement
    setKeyInput('')
    setSaving(true)
    setError(null)
    try {
      const before = useAppStore.getState().settings?.ai.connections ?? []
      const s = await window.sitsense.aiSaveConnection(draftPayload(draft, connId), key)
      applySettings(s)
      const id = connId ?? findNewConnectionId(before, s.ai.connections)
      if (!id) throw new Error('Couldn’t save the connection.')
      setConnId(id)
      setKeyAction('keep')
      setSavedOnce(true)
      return id
    } catch (e) {
      setError(`${aiErrorMessage(e)}${sentKey ? ' The key wasn’t saved — paste it again.' : ''}`)
      return null
    } finally {
      setSaving(false)
      restoreFocus(focused)
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (saving || loadingModels) return
    const id = await save()
    if (id) onSaved(id)
  }

  const loadModels = async (): Promise<void> => {
    if (saving || loadingModels) return
    setModelsNote(null)
    // only unsaved edits are saved first (the hint under Model says so)
    const id = unsaved || !connId ? await save() : connId
    if (!id) return
    setLoadingModels(true)
    try {
      const r = await window.sitsense.aiListModels(id)
      if (r.ok) {
        setModels(r.models)
        setModelsNote(
          r.models.length
            ? { ok: true, text: `${r.models.length} models found — pick one from the suggestions.` }
            : { ok: false, text: 'The server listed no models.' }
        )
      } else setModelsNote({ ok: false, text: r.message })
    } catch (err) {
      setModelsNote({ ok: false, text: aiErrorMessage(err) })
    } finally {
      setLoadingModels(false)
    }
  }

  const disabled = saving || loadingModels
  const suggestions = modelSuggestions(preset, models)

  return (
    <form
      aria-labelledby={ids.title}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
      className="mt-3 flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-white/[0.08]"
    >
      <p id={ids.title} className="type-title text-text">
        {existing ? `Edit ${existing.label}` : 'Add a connection'}
      </p>

      <div className="grid grid-cols-1 gap-4 @min-[600px]:grid-cols-2">
        <Field label="Provider" htmlFor={ids.provider}>
          <span className="relative flex">
            <select
              ref={firstRef}
              id={ids.provider}
              data-ai-form-first=""
              value={draft.presetId}
              disabled={disabled}
              onChange={(e) => {
                setDraft((d) => switchPreset(d, presetById(e.target.value)))
                setModels([])
                setModelsNote(null)
              }}
              className={`${FIELD_CLASS} w-full cursor-pointer appearance-none pr-8`}
            >
              {AI_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={16} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text-dim" />
          </span>
          {dropsKey === 'provider' && (
            <p className="type-caption text-text-dim">Switching provider removes the saved key unless you enter a new one.</p>
          )}
        </Field>

        <Field label="Name" htmlFor={ids.label}>
          <input
            id={ids.label}
            value={draft.label}
            maxLength={AI_LIMITS.maxLabel}
            placeholder={preset.label}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
            className={`${FIELD_CLASS} w-full`}
          />
        </Field>
      </div>

      <Field label={preset.keyRequired ? 'API key' : 'API key (optional)'} htmlFor={showKeyInput ? ids.key : undefined}>
        {hasSavedKey && keyAction === 'keep' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="type-body text-text-dim">
              Saved key <span className="font-mono text-text">{saved?.keyHint ?? '…'}</span>
            </span>
            <Button
              variant="ghost"
              size="sm" ringOn="card"
              disabled={disabled}
              onClick={() => {
                setKeyAction('replace')
                focusById(ids.key)
              }}
            >
              Replace
            </Button>
            <Button variant="danger" size="sm" ringOn="card" disabled={disabled} onClick={() => setKeyAction('remove')}>
              Remove
            </Button>
          </div>
        )}
        {keyAction === 'remove' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="type-caption text-text-dim">The saved key will be deleted when you save.</span>
            <Button variant="ghost" size="sm" ringOn="card" onClick={() => setKeyAction('keep')}>
              Undo
            </Button>
          </div>
        )}
        {showKeyInput && (
          <div className="flex items-center gap-2">
            <input
              ref={keyRef}
              id={ids.key}
              type="password"
              value={keyInput}
              maxLength={AI_LIMITS.maxKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={preset.keyRequired ? 'Paste your API key' : 'Leave empty if the server needs none'}
              aria-describedby={`${ids.keyHelp}${hint ? ` ${ids.keyHint}` : ''}`}
              disabled={disabled}
              onChange={(e) => setKeyInput(e.target.value)}
              className={`${FIELD_CLASS} min-w-0 flex-1 font-mono select-text`}
            />
            {hasSavedKey && (
              <Button
                variant="ghost"
                size="sm" ringOn="card"
                onClick={() => {
                  setKeyInput('')
                  setKeyAction('keep')
                }}
              >
                Keep saved key
              </Button>
            )}
          </div>
        )}
        <p id={ids.keyHelp} className="type-caption text-text-faint">
          {preset.keyHelp} Stored encrypted on this computer and never shown again.
        </p>
        {hint && (
          <p id={ids.keyHint} aria-live="polite" className="type-caption text-text-dim">
            {hint}
          </p>
        )}
      </Field>

      {!baseUrlAlwaysVisible(preset) && (
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
          className="inline-flex h-7 items-center gap-1 self-start rounded-md type-caption text-text-dim transition-colors duration-150 hover:text-text focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none"
        >
          Advanced
          <Icon name={advanced ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
      )}
      {showBaseUrl && (
        <Field label="Base URL" htmlFor={ids.baseUrl}>
          <input
            id={ids.baseUrl}
            value={draft.baseUrl}
            maxLength={AI_LIMITS.maxBaseUrl}
            inputMode="url"
            spellCheck={false}
            placeholder={preset.baseUrl || 'https://your-server.example.com/v1'}
            aria-describedby={ids.baseUrlHelp}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            className={`${FIELD_CLASS} w-full font-mono select-text`}
          />
          <p id={ids.baseUrlHelp} className="type-caption text-text-faint">
            {baseUrlAlwaysVisible(preset)
              ? 'Where the server listens. Use https://, or http:// for this computer (localhost).'
              : 'Leave as is unless you route requests through a proxy.'}
          </p>
          {dropsKey === 'address' && (
            <p className="type-caption text-text-dim">
              A different server address removes the saved key unless you enter a new one.
            </p>
          )}
        </Field>
      )}

      <Field label="Model" htmlFor={ids.model}>
        <div className="flex items-center gap-2">
          <input
            id={ids.model}
            value={draft.model}
            list={ids.models}
            maxLength={AI_LIMITS.maxModel}
            spellCheck={false}
            placeholder={preset.models[0] ?? 'e.g. qwen3-vl'}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            className={`${FIELD_CLASS} min-w-0 flex-1 font-mono select-text`}
          />
          <datalist id={ids.models}>
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Button size="sm" ringOn="card" pending={disabled} onClick={() => void loadModels()}>
            {loadingModels ? 'Loading…' : 'Load models'}
          </Button>
        </div>
        <p aria-live="polite" className={`type-caption ${modelsNote && !modelsNote.ok ? 'text-coral' : 'text-text-faint'}`}>
          {modelsNote
            ? modelsNote.text
            : unsaved
              ? `Choose a model that can read images. Load models saves your ${connId ? 'changes' : 'connection'} first.`
              : 'Choose a model that can read images.'}
        </p>
      </Field>

      {error && (
        <p role="alert" className="type-caption text-coral">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-white/[0.06] pt-4">
        <Button type="submit" variant="primary" size="sm" ringOn="card" pending={disabled}>
          {saving ? 'Saving…' : 'Save and test'}
        </Button>
        <Button variant="ghost" size="sm" ringOn="card" disabled={saving} onClick={onCancel}>
          {savedOnce ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  htmlFor,
  children
}: {
  label: string
  htmlFor: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="type-caption text-text-dim">
          {label}
        </label>
      ) : (
        <p className="type-caption text-text-dim">{label}</p>
      )}
      {children}
    </div>
  )
}
