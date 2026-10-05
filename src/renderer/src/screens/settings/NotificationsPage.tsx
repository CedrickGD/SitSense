// Settings › Notifications & breaks (ui-v3 §6.2): nudges, a toast preview, break reminders.

import { Fragment, useId, useState, type JSX, type ReactNode } from 'react'
import { ISSUE_LABELS, ISSUES, type IssueId } from '@shared/posture'
import { BREAK_INTERVAL_RANGE, type Settings } from '@shared/settings'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { Icon, type IconName } from '@renderer/components/icons'
import { Button, SegmentedControl, Select, Toggle } from '@renderer/components/primitives'
import { fmtClock, fmtMinutes, plural } from '@renderer/lib/format'
import { STAGE_COLOR, STAGE_LABEL } from '@renderer/lib/ui'
import { useAppStore } from '@renderer/state/store'
import { breakHint, notifyFrom, stagesFrom, TOAST_PREVIEW } from './meta'
import { GroupDivider, Saved, SettingRow, SettingsCard, SettingsGrid, SliderRow, useCommit } from './parts'

export default function NotificationsPage({ settings }: { settings: Settings }): JSX.Element {
  return (
    <SettingsGrid>
      <NudgesCard settings={settings} />
      <ToastPreviewCard settings={settings} />
      <BreaksCard settings={settings} />
    </SettingsGrid>
  )
}

// ───────────────────────────── nudges ─────────────────────────────

const STAGE_KEYS = ['1', '2', '3'] as const

function NudgesCard({ settings }: { settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const [fineTune, setFineTune] = useState(false)
  const n = settings.notifications
  const off = !n.enabled
  const ids = { master: useId(), escalate: useId(), sound: useId(), matrix: useId() }
  const patchIssue = (issue: IssueId, stages: [boolean, boolean, boolean]): void =>
    commit(`nudge-${issue}`, { issues: { [issue]: { notifyStages: stages } } })

  return (
    <SettingsCard span={7} eyebrow="Nudges">
      <div className="flex flex-col gap-3">
        <SettingRow
          label="Posture nudges"
          description="A Windows notification when your posture needs a nudge."
          descriptionId={ids.master}
          savedKey="notifications"
          control={
            <Toggle
              label="Posture nudges"
              describedBy={ids.master}
              checked={n.enabled}
              onChange={(v) => commit('notifications', { notifications: { enabled: v } })}
            />
          }
        />
        <GroupDivider />

        <div className={`flex flex-col gap-2 transition-opacity duration-150 ${off ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-between gap-4">
            <p className="type-micro text-text-faint">Issue</p>
            <p className="type-micro text-text-faint">Nudge me from</p>
          </div>
          {ISSUES.map((issue) => {
            const cfg = settings.issues[issue]
            const from = notifyFrom(cfg.notifyStages)
            const watched = cfg.enabled
            return (
              <div key={issue} className="flex min-h-8 items-center justify-between gap-3">
                <span className={`min-w-0 truncate type-body ${watched ? 'text-text' : 'text-text-faint'}`}>
                  {ISSUE_LABELS[issue]}
                  {!watched && <span className="type-caption text-text-faint"> · not watched</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Saved k={`nudge-${issue}`} />
                  {from === 'custom' || from === 'none' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      ringOn="card"
                      disabled={off || !watched}
                      aria-label={`${ISSUE_LABELS[issue]}: ${from === 'none' ? 'never' : 'custom stages'} — reset to every stage`}
                      onClick={() => patchIssue(issue, [true, true, true])}
                    >
                      {from === 'none' ? 'Never' : 'Custom'} · reset
                    </Button>
                  ) : (
                    <SegmentedControl<(typeof STAGE_KEYS)[number]>
                      ariaLabel={`${ISSUE_LABELS[issue]} — nudge me from`}
                      size="sm"
                      disabled={off || !watched}
                      value={String(from) as (typeof STAGE_KEYS)[number]}
                      onChange={(v) => patchIssue(issue, stagesFrom(Number(v) as 1 | 2 | 3))}
                      options={STAGE_KEYS.map((k) => ({
                        value: k,
                        label: STAGE_LABEL[Number(k) as 1 | 2 | 3],
                        color: STAGE_COLOR[Number(k) as 1 | 2 | 3]
                      }))}
                    />
                  )}
                </span>
              </div>
            )
          })}
          <div>
            <button
              type="button"
              aria-expanded={fineTune}
              aria-controls={ids.matrix}
              disabled={off}
              onClick={() => setFineTune((v) => !v)}
              className="inline-flex h-7 items-center gap-1 rounded-md type-caption text-text-dim transition-colors duration-150 enabled:hover:text-text focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none disabled:cursor-not-allowed"
            >
              Fine-tune per stage
              <Icon name={fineTune ? 'chevron-up' : 'chevron-down'} size={14} />
            </button>
          </div>
          {fineTune && (
            <div id={ids.matrix} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
              <div className="grid grid-cols-[1fr_repeat(3,56px)] items-center gap-y-2 text-center">
                <span />
                {([1, 2, 3] as const).map((st) => (
                  <span key={st} className="type-caption font-medium" style={{ color: STAGE_COLOR[st] }}>
                    {STAGE_LABEL[st]}
                  </span>
                ))}
                {ISSUES.map((issue) => (
                  <Fragment key={issue}>
                    <span className="truncate text-left type-body text-text">{ISSUE_LABELS[issue]}</span>
                    {[0, 1, 2].map((k) => (
                      <label key={k} className="flex h-7 items-center justify-center">
                        <input
                          type="checkbox"
                          disabled={off}
                          aria-label={`${ISSUE_LABELS[issue]} – notify at ${STAGE_LABEL[(k + 1) as 1 | 2 | 3]}`}
                          checked={settings.issues[issue].notifyStages[k]}
                          onChange={(e) => {
                            const next = [...settings.issues[issue].notifyStages] as [boolean, boolean, boolean]
                            next[k] = e.target.checked
                            patchIssue(issue, next)
                          }}
                          className="h-4 w-4 cursor-pointer accent-[var(--color-sage)] disabled:cursor-not-allowed"
                        />
                      </label>
                    ))}
                  </Fragment>
                ))}
              </div>
              <p className="mt-3 type-caption text-text-dim">
                Unchecked stages are still tracked and shown on Live — they just don’t notify.
              </p>
            </div>
          )}
        </div>

        <GroupDivider />
        <div className="flex flex-col gap-5">
          <SliderRow
            label="Wait before nudging"
            value={n.dwellSeconds}
            min={5}
            max={30}
            step={1}
            format={(v) => `${v} s`}
            description="How long poor posture must last before the first nudge."
            savedKey="dwell"
            disabled={off}
            onCommit={(v) => commit('dwell', { notifications: { dwellSeconds: v } })}
          />
          <SliderRow
            label="Quiet period between nudges"
            value={n.cooldownMinutes}
            min={1}
            max={10}
            step={1}
            format={(v) => `${v} min`}
            description="Per issue — a repeat nudge waits at least this long."
            savedKey="cooldown"
            disabled={off}
            onCommit={(v) => commit('cooldown', { notifications: { cooldownMinutes: v } })}
          />
        </div>
        <GroupDivider />
        <SettingRow
          label="Escalate if it gets worse"
          description="A worse stage that holds for a few seconds nudges again, even in the quiet period."
          descriptionId={ids.escalate}
          savedKey="escalation"
          muted={off}
          control={
            <Toggle
              label="Escalate if it gets worse"
              describedBy={ids.escalate}
              disabled={off}
              checked={n.escalation}
              onChange={(v) => commit('escalation', { notifications: { escalation: v } })}
            />
          }
        />
        <SettingRow
          label="Sound"
          description="Play the Windows notification sound with each nudge."
          descriptionId={ids.sound}
          savedKey="sound"
          muted={off}
          control={
            <Toggle
              label="Sound"
              describedBy={ids.sound}
              disabled={off}
              checked={n.sound}
              onChange={(v) => commit('sound', { notifications: { sound: v } })}
            />
          }
        />
      </div>
    </SettingsCard>
  )
}

// ───────────────────────────── toast preview ─────────────────────────────

function ToastPreviewCard({ settings }: { settings: Settings }): JSX.Element {
  const [issue, setIssue] = useState<IssueId>('sink')
  const [stage, setStage] = useState<'1' | '2' | '3'>('2')
  const [sent, setSent] = useState(false)
  const st = Number(stage) as 1 | 2 | 3
  const copy = TOAST_PREVIEW[issue][st]
  const notifies = settings.notifications.enabled && settings.issues[issue].enabled && settings.issues[issue].notifyStages[st - 1]

  return (
    <SettingsCard span={5} eyebrow="Preview">
      <div className="flex flex-1 flex-col gap-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <Select<IssueId>
            ariaLabel="Preview issue"
            value={issue}
            onChange={setIssue}
            options={ISSUES.map((i) => ({ value: i, label: ISSUE_LABELS[i] }))}
          />
          <Select<'1' | '2' | '3'>
            ariaLabel="Preview stage"
            value={stage}
            onChange={setStage}
            options={STAGE_KEYS.map((k) => ({ value: k, label: STAGE_LABEL[Number(k) as 1 | 2 | 3] }))}
          />
        </div>

        {/* a Windows 11 toast, drawn in HTML */}
        <div aria-hidden className="w-full max-w-[360px] self-center rounded-lg bg-card-2 p-3 shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_24px_-12px_rgb(0_0_0/0.6)]">
          <div className="flex items-center gap-2 text-text-dim">
            <SpineGlyph size={14} issue={null} stage={0} breathing={false} />
            <span className="type-caption">SitSense</span>
            <span className="ml-auto flex items-center gap-2 text-text-faint">
              <Icon name="more" size={14} />
              <Icon name="close" size={14} />
            </span>
          </div>
          <div className="mt-3 flex items-start gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-ink/60">
              <SpineGlyph size={36} issue={issue} stage={st} direction="left" breathing={false} />
            </span>
            <div className="min-w-0">
              <p className="type-title text-text">{copy.title}</p>
              <p className="mt-0.5 type-body text-text-dim">{copy.body}</p>
            </div>
          </div>
        </div>
        <p className="type-caption text-text-dim" role="status">
          {notifies ? (
            'One of several phrasings — SitSense varies them so nudges don’t repeat.'
          ) : (
            <span className="text-amber">This one is switched off, so you won’t see it.</span>
          )}
        </p>

        <NudgeTimeline settings={settings} />

        <div className="mt-auto flex flex-col gap-2 border-t border-white/[0.06] pt-4">
          <Button
            variant="secondary"
            icon="bell"
            ringOn="card"
            className="self-start"
            onClick={() => {
              setSent(true)
              void window.sitsense.testNotification()
            }}
          >
            Send a test notification
          </Button>
          <p className="type-caption text-text-dim">
            {sent ? 'Sent. ' : ''}If nothing appears, check Windows notification settings for SitSense.
          </p>
        </div>
      </div>
    </SettingsCard>
  )
}

/** "How it plays out" with the current numbers: dwell → nudge → quiet period → escalation. */
function NudgeTimeline({ settings }: { settings: Settings }): JSX.Element {
  const n = settings.notifications
  const steps: { icon: IconName; text: ReactNode }[] = n.enabled
    ? [
        {
          icon: 'alert',
          text: (
            <>
              Poor posture for <span className="type-value text-[12px] text-text">{n.dwellSeconds} s</span> → a nudge
            </>
          )
        },
        {
          icon: 'pause',
          text: (
            <>
              Then quiet for <span className="type-value text-[12px] text-text">{n.cooldownMinutes} min</span> per issue
            </>
          )
        },
        {
          icon: 'arrow-right',
          text: n.escalation ? 'Gets worse? You hear about it sooner' : 'Getting worse waits for the quiet period'
        }
      ]
    : [{ icon: 'bell', text: 'Nudges are off — Live still shows every issue.' }]
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
      <p className="type-micro text-text-faint">How it plays out</p>
      <ol className="flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2 type-caption text-text-dim">
            <Icon name={s.icon} size={14} className="shrink-0 text-text-faint" />
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ───────────────────────────── breaks ─────────────────────────────

function BreaksCard({ settings }: { settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const sitting = useAppStore((s) => s.sitting)
  const paused = useAppStore((s) => s.pause.paused)
  const b = settings.breaks
  const descId = useId()

  return (
    <SettingsCard span={12} eyebrow="Breaks">
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 @min-[600px]:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SettingRow
            label="Remind me to take breaks"
            description="A notification after a long stretch in the chair."
            descriptionId={descId}
            savedKey="breaks"
            control={
              <Toggle
                label="Remind me to take breaks"
                describedBy={descId}
                checked={b.enabled}
                onChange={(v) => commit('breaks', { breaks: { enabled: v } })}
              />
            }
          />
          <SliderRow
            label="Remind me every"
            value={b.intervalMinutes}
            min={BREAK_INTERVAL_RANGE.min}
            max={BREAK_INTERVAL_RANGE.max}
            step={5}
            format={(v) => `${v} min`}
            startLabel={`${BREAK_INTERVAL_RANGE.min} min`}
            endLabel={`${BREAK_INTERVAL_RANGE.max / 60} h`}
            savedKey="interval"
            disabled={!b.enabled}
            onCommit={(v) => commit('interval', { breaks: { intervalMinutes: v } })}
          />
        </div>
        <div className="flex flex-col gap-3 rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/[0.06]">
          <div className="flex items-center gap-2">
            <Icon name="coffee" size={16} className="text-text-faint" />
            <p className="type-micro text-text-faint">Right now</p>
          </div>
          <SittingNow sitting={sitting} paused={paused} enabled={b.enabled} />
          <p className="mt-auto type-caption text-text-dim">{breakHint()}</p>
        </div>
      </div>
    </SettingsCard>
  )
}

function SittingNow({
  sitting,
  paused,
  enabled
}: {
  sitting: ReturnType<typeof useAppStore.getState>['sitting']
  paused: boolean
  enabled: boolean
}): JSX.Element {
  if (!sitting) return <p className="type-body text-text-dim">—</p>
  const breaks = `${plural(sitting.breaksToday, 'break')} today`
  if (paused) return <p className="type-body text-text-dim">Paused — the sitting timer waits. · {breaks}</p>
  if (sitting.onBreak || sitting.sittingSince === null)
    return (
      <p className="type-body text-text">
        Not sitting right now <span className="text-text-dim">· {breaks}</span>
      </p>
    )
  return (
    <div className="flex flex-col gap-1">
      <p className="type-body text-text">
        Sitting for <span className="type-value">{fmtMinutes(sitting.sittingMinutes)}</span>
      </p>
      <p className="type-caption text-text-dim">
        {enabled && sitting.nextReminderAt !== null ? (
          <>
            Next reminder at <span className="type-value text-[12px]">{fmtClock(sitting.nextReminderAt)}</span> ·{' '}
          </>
        ) : null}
        {breaks}
      </p>
    </div>
  )
}

