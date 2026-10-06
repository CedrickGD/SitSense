// Settings › About (ui-v3 §6.2): identity + version, updates from GitHub, keyboard
// shortcuts, credits.

import { Fragment, useId, useState, type JSX } from 'react'
import type { Settings } from '@shared/settings'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { Icon } from '@renderer/components/icons'
import { Button, Kbd, ProgressBar, Spinner, Toggle } from '@renderer/components/primitives'
import { useAppStore } from '@renderer/state/store'
import { SHORTCUTS } from './meta'
import { CardFooter, GroupDivider, SettingRow, SettingsCard, SettingsGrid, useCommit } from './parts'
import { updateCardView, updatePrivacyNote, type UpdateTone } from './update-view'

const CREDITS: { what: string; who: string; license: string }[] = [
  { what: 'Pose tracking', who: 'MediaPipe', license: 'Apache 2.0' },
  { what: 'Display type', who: 'Bricolage Grotesque', license: 'SIL OFL 1.1' },
  { what: 'Interface type', who: 'Hanken Grotesk', license: 'SIL OFL 1.1' },
  { what: 'Numbers', who: 'IBM Plex Mono', license: 'SIL OFL 1.1' }
]

const MODE_LINE = {
  installed: 'Installed · updates from GitHub',
  portable: 'Portable · updates from GitHub',
  dev: 'Development build'
} as const

export default function AboutPage({ settings }: { settings: Settings }): JSX.Element {
  const version = useAppStore((s) => s.appVersion)
  const mode = useAppStore((s) => s.update?.mode ?? null)
  return (
    <SettingsGrid>
      <SettingsCard span={6} eyebrow="SitSense">
        <div className="flex flex-1 items-center gap-5">
          <div className="flex h-20 w-16 shrink-0 items-center justify-center">
            <SpineGlyph size={64} issue={null} stage={0} />
          </div>
          <div className="min-w-0">
            <p className="type-h3 text-text">SitSense</p>
            <p className="type-value-lg text-text">Version {version || '—'}</p>
            {mode && <p className="type-caption text-text-faint">{MODE_LINE[mode]}</p>}
            <p className="mt-2 type-body text-text-dim">Posture coaching that runs on your PC.</p>
          </div>
        </div>
      </SettingsCard>

      <UpdatesCard settings={settings} />

      <SettingsCard span={6} eyebrow="Keyboard shortcuts">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5">
          {SHORTCUTS.map((s) => (
            <Fragment key={s.label}>
              <dt className="flex items-center gap-1">
                {s.keys.map((k, i) => (
                  <Fragment key={k}>
                    {i > 0 && (
                      <span aria-hidden className="type-caption text-text-faint">
                        +
                      </span>
                    )}
                    <Kbd>{k}</Kbd>
                  </Fragment>
                ))}
              </dt>
              <dd className="min-w-0 type-body text-text-dim">{s.label}</dd>
            </Fragment>
          ))}
        </dl>
      </SettingsCard>

      <SettingsCard span={6} eyebrow="Credits">
        <ul className="grid grid-cols-1 gap-3 @min-[420px]:grid-cols-2">
          {CREDITS.map((c) => (
            <li key={c.who} className="flex flex-col gap-0.5 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
              <span className="type-micro text-text-faint">{c.what}</span>
              <span className="type-body text-text">{c.who}</span>
              <span className="type-caption text-text-dim">{c.license}</span>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </SettingsGrid>
  )
}

const TONE: Record<UpdateTone, string> = {
  sage: 'bg-sage-soft text-sage',
  amber: 'bg-amber/12 text-amber',
  coral: 'bg-coral/12 text-coral',
  neutral: 'bg-card-2 text-text-dim ring-1 ring-white/[0.06]'
}

/** Update status + the one action, and the auto-check toggle (architecture.md §2 "App updates"). */
function UpdatesCard({ settings }: { settings: Settings }): JSX.Element {
  const status = useAppStore((s) => s.update)
  const { commit } = useCommit()
  const [busy, setBusy] = useState(false)
  const noteId = useId()
  const autoCheck = settings.updates.autoCheck
  const view = updateCardView(status, autoCheck)
  const api = window.sitsense

  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true)
    // the new status arrives through onUpdateState; a rejected call leaves the card as it was
    void fn()
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  const a = view.action
  let button: JSX.Element
  if (a.kind === 'install') {
    button = (
      <Button variant="primary" size="sm" icon="refresh" ringOn="card" pending={busy} onClick={() => run(() => api.updateInstall())}>
        {a.label}
      </Button>
    )
  } else if (a.kind === 'download') {
    button = (
      <Button
        variant="primary"
        size="sm"
        icon={a.external ? undefined : 'arrow-down'}
        iconRight={a.external ? 'arrow-right' : undefined}
        ringOn="card"
        pending={busy}
        onClick={() => run(() => api.updateDownload())}
      >
        {a.label}
      </Button>
    )
  } else {
    button = (
      <Button
        variant="secondary"
        size="sm"
        icon={a.loading ? undefined : 'refresh'}
        ringOn="card"
        loading={a.loading}
        pending={busy && !a.loading}
        disabled={a.disabled}
        onClick={() => run(() => api.updateCheck())}
      >
        {a.label}
      </Button>
    )
  }

  const portable = status?.mode === 'portable'
  return (
    <SettingsCard span={6} eyebrow="Updates">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3" role="status" aria-live="polite">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${TONE[view.tone]}`}>
            {view.icon === 'spinner' ? <Spinner size={14} /> : <Icon name={view.icon} size={14} strokeWidth={2} />}
          </span>
          <div className="min-w-0">
            <p className="type-body font-medium text-text">{view.title}</p>
            {view.sub && <p className={`mt-0.5 max-w-[60ch] type-caption ${view.tone === 'coral' ? 'text-coral' : 'text-text-dim'} line-clamp-3`}>{view.sub}</p>}
          </div>
        </div>
        <div className="shrink-0">{button}</div>
      </div>
      {view.progress !== null && (
        <div className="mt-3 flex items-center gap-3">
          <ProgressBar value={view.progress / 100} height={6} label="Update download" />
          <span className="w-10 shrink-0 text-right type-value text-text-dim">{view.progress}%</span>
        </div>
      )}
      <div className="mt-4">
        <GroupDivider />
      </div>
      <div className="mt-3">
        <SettingRow
          label="Check automatically"
          description={updatePrivacyNote(status?.mode ?? null)}
          descriptionId={noteId}
          savedKey="updates.autoCheck"
          control={
            <Toggle
              checked={autoCheck}
              label="Check for updates automatically"
              describedBy={noteId}
              onChange={(v) => commit('updates.autoCheck', { updates: { autoCheck: v } })}
            />
          }
        />
      </div>
      {portable && <CardFooter>Portable copy: new versions download from the GitHub release page — replace this exe with the new one.</CardFooter>}
    </SettingsCard>
  )
}
