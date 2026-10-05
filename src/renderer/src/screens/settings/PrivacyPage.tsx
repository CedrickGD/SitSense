// Settings › Privacy & data (ui-v3 §6.2): what stays on this PC, what can leave it,
// the data kept here (with its delete actions) and Reset all settings.

import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { aiErrorMessage } from '@shared/ai'
import type { Settings } from '@shared/settings'
import { Icon, type IconName } from '@renderer/components/icons'
import { Button, ConfirmButton, LinkButton, Tooltip } from '@renderer/components/primitives'
import { recipientPhrases, setupLine, shareDisclosure } from '@renderer/components/ai-settings'
import { clearCoachHistory, coachHistoryCount, useCoachStore } from '@renderer/screens/coach/coachStore'
import { plural } from '@renderer/lib/format'
import { useAppStore } from '@renderer/state/store'
import { historyLine, isAtDefaults, keysLine, resetPatch, updateCheckLine } from './meta'
import { SettingsCard, SettingsGrid } from './parts'

const STAYS: { icon: IconName; text: string; sub: string }[] = [
  { icon: 'camera', text: 'Your camera image', sub: 'Analyzed live, never saved' },
  { icon: 'spine', text: 'Your posture numbers and setup', sub: 'Angles and stages, no pictures' },
  { icon: 'history', text: 'Your daily history', sub: 'The last 90 days' },
  { icon: 'coach', text: 'Your coach chat', sub: 'Text only, never an image' }
]

export default function PrivacyPage({ settings }: { settings: Settings }): JSX.Element {
  return (
    <SettingsGrid>
      <SettingsCard span={6} eyebrow="Stays on this PC">
        <ul className="flex flex-col gap-3">
          {STAYS.map((s) => (
            <li key={s.text} className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sage-soft text-sage">
                <Icon name="check" size={14} strokeWidth={2.2} />
              </span>
              <span className="min-w-0">
                <span className="block type-body text-text">{s.text}</span>
                <span className="block type-caption text-text-dim">{s.sub}</span>
              </span>
            </li>
          ))}
        </ul>
      </SettingsCard>
      <CanLeaveCard settings={settings} />
      <DataCard settings={settings} />
      <ResetCard settings={settings} />
    </SettingsGrid>
  )
}

function CanLeaveCard({ settings }: { settings: Settings }): JSX.Element {
  const setCategory = useAppStore((s) => s.setSettingsCategory)
  // only connections a request can really call (on, with key/model/address) are named
  const recipients = recipientPhrases(settings.ai.connections)
  const on = settings.ai.enabled && recipients.length > 0
  const noneReady = settings.ai.enabled && !on
  return (
    <SettingsCard
      span={6}
      eyebrow="Can leave this PC"
      action={
        <Button size="sm" variant="ghost" iconRight="chevron-right" ringOn="card" onClick={() => setCategory('ai')}>
          AI models
        </Button>
      }
    >
      {on ? (
        <div className="flex flex-1 items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber/12 text-amber">
            <Icon name="spark" size={14} />
          </span>
          <p className="max-w-[68ch] type-body text-text-dim">{shareDisclosure(settings.ai.share, recipients)}</p>
        </div>
      ) : (
        <div className="flex flex-1 items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sage-soft text-sage">
            <Icon name="lock" size={14} />
          </span>
          <div className="min-w-0">
            {noneReady ? (
              <>
                <p className="type-body-lg text-text">Nothing yet.</p>
                <p className="type-body text-text-dim">
                  No connection is ready (missing key or model), so SitSense can’t send anything.
                </p>
                <p className="mt-3 max-w-[60ch] type-caption text-text-faint">
                  Once a connection is ready, this card spells out exactly what is sent, to whom, and when.
                </p>
              </>
            ) : (
              <>
                <p className="type-body-lg text-text">{settings.updates.autoCheck ? 'Only an update check.' : 'Nothing.'}</p>
                <p className="type-body text-text-dim">
                  {settings.updates.autoCheck
                    ? 'With AI models off, the only request SitSense makes is asking GitHub for its latest version.'
                    : 'With AI models and automatic update checks off, SitSense makes no network requests.'}
                </p>
                <p className="mt-3 max-w-[60ch] type-caption text-text-faint">
                  If you connect a model later, this card spells out exactly what is sent, to whom, and when.
                </p>
              </>
            )}
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-white/[0.06] pt-3">
        <p className="min-w-0 flex-1 basis-64 type-caption text-text-dim">{updateCheckLine(settings.updates.autoCheck)}</p>
        <LinkButton tone="dim" arrow onClick={() => setCategory('about')}>
          Updates
        </LinkButton>
      </div>
    </SettingsCard>
  )
}

function DataRow({
  icon,
  title,
  value,
  sub,
  action
}: {
  icon: IconName
  title: string
  value: string
  sub?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <li className="grid min-h-14 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-3 @min-[600px]:grid-cols-[28px_minmax(0,1fr)_152px_184px]">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-card-2 text-text-dim ring-1 ring-white/[0.06]">
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0">
        <span className="block truncate type-body font-medium text-text">{title}</span>
        {sub && <span className="block type-caption text-text-dim">{sub}</span>}
      </span>
      <span className="col-start-2 row-start-2 type-value text-text-dim @min-[600px]:col-start-3 @min-[600px]:row-start-1 @min-[600px]:text-right">
        {value}
      </span>
      <span className="col-start-3 row-span-2 row-start-1 flex justify-end @min-[600px]:col-start-4 @min-[600px]:row-span-1">
        {action}
      </span>
    </li>
  )
}

function DataCard({ settings }: { settings: Settings }): JSX.Element {
  const openSetup = useAppStore((s) => s.openSetup)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const [days, setDays] = useState<number | null>(null)
  // re-render when the conversation changes; the count itself comes from the coach store
  useCoachStore((s) => s.messages)
  const chatCount = coachHistoryCount()

  useEffect(() => {
    let alive = true
    window.sitsense
      .getStatsRange(90)
      .then((r) => alive && setDays(r.days.filter((d) => d.hasData).length))
      .catch(() => alive && setDays(null))
    return () => {
      alive = false
    }
  }, [])

  const baseline = settings.calibration
  const line = baseline ? setupLine(baseline, Date.now()) : null

  // keys can always be removed here, even with AI off (the connections card is hidden then)
  const [removingKeys, setRemovingKeys] = useState(false)
  const [keysError, setKeysError] = useState<string | null>(null)
  const keyCount = settings.ai.connections.filter((c) => c.hasKey).length
  const removeKeys = async (): Promise<void> => {
    setRemovingKeys(true)
    setKeysError(null)
    try {
      let next: Settings | null = null
      for (const c of settings.ai.connections) {
        if (c.hasKey) next = await window.sitsense.aiSaveConnection({ id: c.id }, null)
      }
      if (next) useAppStore.setState({ settings: next })
    } catch (e) {
      setKeysError(aiErrorMessage(e))
    } finally {
      setRemovingKeys(false)
    }
  }

  return (
    <SettingsCard span={12} eyebrow="Data on this PC">
      <ul className="-my-2.5 flex flex-col divide-y divide-white/[0.06]">
        <DataRow
          icon="history"
          title="Posture history"
          sub="One summary per day. Days older than 90 are removed automatically."
          value={historyLine(days)}
        />
        <DataRow
          icon="coach"
          title="Coach chat"
          sub="Your conversation with the coach, text only."
          value={chatCount > 0 ? plural(chatCount, 'message') : 'Empty'}
          action={
            <ConfirmButton
              variant="danger"
              size="sm"
              icon="trash"
              ringOn="card"
              disabled={chatCount === 0}
              message="Clear the whole coach conversation? This can’t be undone."
              confirmLabel="Clear chat"
              onConfirm={() => clearCoachHistory()}
            >
              Clear chat
            </ConfirmButton>
          }
        />
        <DataRow
          icon="setup"
          title="Your saved posture"
          sub={line ? `${line.view} · ${line.verdict}` : 'Numbers only — no picture of you.'}
          value={line ? line.ago : 'Not set up'}
          action={
            line ? (
              <ConfirmButton
                variant="danger"
                size="sm"
                icon="trash"
                ringOn="card"
                message="Delete your saved posture and start setup?"
                confirmLabel="Delete and redo"
                onConfirm={() => {
                  void patchSettings({ calibration: null }).then(() => openSetup('settings'))
                }}
              >
                Delete and redo setup
              </ConfirmButton>
            ) : (
              <Button size="sm" variant="secondary" icon="setup" ringOn="card" onClick={() => openSetup('settings')}>
                Set up posture
              </Button>
            )
          }
        />
        <DataRow
          icon="lock"
          title="AI keys"
          sub="Stored only on this PC. Removing a key keeps its connection, so you can add a new one later."
          value={keysLine(settings.ai.connections)}
          action={
            <ConfirmButton
              variant="danger"
              size="sm"
              icon="trash"
              ringOn="card"
              disabled={keyCount === 0 || removingKeys}
              message={`Remove ${keyCount === 1 ? 'the saved key' : `all ${keyCount} saved keys`} from this PC? This can’t be undone.`}
              confirmLabel="Remove keys"
              onConfirm={() => void removeKeys()}
            >
              Remove all keys
            </ConfirmButton>
          }
        />
      </ul>
      {keysError && (
        <p role="alert" className="mt-3 flex items-center gap-2 type-caption text-coral">
          <Icon name="alert" size={14} />
          {keysError}
        </p>
      )}
    </SettingsCard>
  )
}

function ResetCard({ settings }: { settings: Settings }): JSX.Element {
  const patchSettings = useAppStore((s) => s.patchSettings)
  const [done, setDone] = useState(false)
  const atDefaults = isAtDefaults(settings)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 2500)
    return () => clearTimeout(t)
  }, [done])
  return (
    <SettingsCard span={12} eyebrow="Reset">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <p className="type-body font-medium text-text">Reset all settings</p>
          <p className="mt-0.5 max-w-[68ch] type-caption text-text-dim">
            Puts every setting back to its default. Your history, saved posture and AI keys stay.
          </p>
        </div>
        <span className="flex items-center gap-3">
          {done && (
            <span role="status" className="type-caption text-text-faint">
              Settings reset
            </span>
          )}
          <Tooltip content="Everything is already at its default" disabled={!atDefaults}>
            <span tabIndex={atDefaults ? 0 : -1} className="inline-flex rounded-[10px]">
              <ConfirmButton
                variant="danger"
                icon="refresh"
                ringOn="card"
                disabled={atDefaults}
                message="Reset every setting to its default?"
                confirmLabel="Reset"
                onConfirm={() => {
                  void patchSettings(resetPatch()).then(() => setDone(true))
                }}
              >
                Reset all settings
              </ConfirmButton>
            </span>
          </Tooltip>
        </span>
      </div>
    </SettingsCard>
  )
}
