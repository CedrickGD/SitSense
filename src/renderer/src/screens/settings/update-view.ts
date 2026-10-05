// Settings › About › Updates: what the card says for each update status
// (src/shared/update.ts). Pure; unit-tested in __tests__/update-view.test.ts.

import type { UpdateStatus } from '@shared/update'
import type { IconName } from '@renderer/components/icons'
import { fmtRelative } from '@renderer/lib/format'

export type UpdateTone = 'sage' | 'amber' | 'coral' | 'neutral'

/** The card's one button: what it does and says. */
export type UpdateAction =
  | { kind: 'check'; label: string; loading?: boolean; disabled?: boolean }
  | { kind: 'download'; label: string; external: boolean }
  | { kind: 'install'; label: string }

export interface UpdateCardView {
  tone: UpdateTone
  icon: IconName | 'spinner'
  title: string
  /** one caption line (release notes are clamped to two lines by the card) */
  sub: string
  action: UpdateAction
  /** 0..100 while downloading */
  progress: number | null
}

export const UPDATE_PRIVACY_NOTE = 'Asks GitHub for the latest version — no posture data is sent.'

/** "v0.2.0" for the sidebar footer ('' while unknown). */
export function shortVersion(v: string | null | undefined): string {
  return v ? `v${v}` : ''
}

export function updateCardView(status: UpdateStatus | null, autoCheck: boolean, now: number = Date.now()): UpdateCardView {
  const check = (label = 'Check for updates'): UpdateAction => ({ kind: 'check', label })
  if (!status) {
    return { tone: 'neutral', icon: 'info', title: 'Checking the update service…', sub: '', action: { kind: 'check', label: 'Check for updates', disabled: true }, progress: null }
  }
  const checked = status.lastCheckedAt ? `Checked ${fmtRelative(status.lastCheckedAt, now)}.` : ''
  const st = status.state
  if (status.mode === 'dev') {
    return {
      tone: 'neutral',
      icon: 'info',
      title: 'Updates come with the installed app',
      sub: 'This development build never checks for updates.',
      action: { kind: 'check', label: 'Check for updates', disabled: true },
      progress: null
    }
  }
  switch (st.kind) {
    case 'checking':
      return { tone: 'neutral', icon: 'spinner', title: 'Checking for updates…', sub: 'Asking GitHub for the latest version.', action: { kind: 'check', label: 'Checking…', loading: true }, progress: null }
    case 'up-to-date':
      return {
        tone: 'sage',
        icon: 'check',
        title: 'You’re up to date',
        sub: [`SitSense ${status.currentVersion} is the latest version.`, checked].filter(Boolean).join(' '),
        action: check(),
        progress: null
      }
    case 'available':
      return {
        tone: 'amber',
        icon: 'spark',
        title: `Version ${st.version} is available`,
        sub: st.notes ?? `You have ${status.currentVersion}.`,
        action: { kind: 'download', label: st.portable ? 'Download' : 'Download update', external: st.portable },
        progress: null
      }
    case 'downloading':
      return {
        tone: 'sage',
        icon: 'arrow-down',
        title: `Downloading version ${st.version}`,
        sub: 'SitSense keeps working while it downloads.',
        action: { kind: 'check', label: 'Downloading…', loading: true },
        progress: st.percent
      }
    case 'ready':
      return {
        tone: 'sage',
        icon: 'refresh',
        title: `Version ${st.version} is ready`,
        sub: 'Restart to finish (a few seconds), or it installs when SitSense quits.',
        action: { kind: 'install', label: 'Restart to update' },
        progress: null
      }
    case 'error':
      return { tone: 'coral', icon: 'alert', title: 'Update didn’t go through', sub: st.message, action: check('Try again'), progress: null }
    case 'idle':
    default:
      return {
        tone: 'neutral',
        icon: 'info',
        title: 'Not checked yet',
        sub: autoCheck ? 'SitSense checks GitHub shortly after it starts, then every few hours.' : 'Automatic checks are off.',
        action: check(),
        progress: null
      }
  }
}
