import { Notification } from 'electron'
import type { IssueId, PostureAlert, Stage } from '../shared/posture'
import { getSettings } from './settings-store'
import { showMainWindow } from './window'

interface ToastCopy {
  title: string
  body: string
}

// Friendly coach, never a scold — escalation adds urgency through specificity,
// not blame. {side} → lean direction, {n} → minutes in the episode.
const COPY: Record<IssueId, Record<1 | 2 | 3, ToastCopy>> = {
  sink: {
    1: { title: 'Sinking a little', body: 'A gentle lift through the chest fixes it.' },
    2: { title: "You've settled into a slouch", body: 'Roll your shoulders back and sit tall.' },
    3: { title: 'Deep slouch, {n} min now', body: 'Worth a reset: sit back, feet flat, spine tall.' }
  },
  headForward: {
    1: { title: "Head's creeping forward", body: 'Tuck your chin back a touch.' },
    2: { title: "Head's well past your shoulders", body: 'Bring your ears back over them.' },
    3: { title: "Neck's doing all the work", body: 'Chin back and screen up — your neck will thank you.' }
  },
  lean: {
    1: { title: 'Listing to the {side}', body: 'Re-center over both sit bones.' },
    2: { title: 'Propped up on one side', body: 'Level your shoulders and square up to the screen.' },
    3: { title: 'Strong lean, {n} min now', body: 'Plant both feet and re-center — maybe stretch that side.' }
  },
  tooClose: {
    1: { title: 'Drifting toward the screen', body: 'Ease back a few centimeters.' },
    2: { title: 'Getting close to the screen', body: 'Sit back — about an arm’s length is right.' },
    3: { title: 'Nose-to-screen territory', body: 'Push back from the desk and reset your distance.' }
  }
}

function interpolate(text: string, alert: PostureAlert): string {
  return text
    .replace('{side}', alert.direction ?? 'side')
    .replace('{n}', String(Math.max(1, Math.round(alert.durationMs / 60_000))))
}

/**
 * The renderer's episode state machines decide WHEN an alert is warranted
 * (dwell, hysteresis, cooldown, escalation) — this module only decides
 * WHETHER the user wants to hear about it, and renders the toast.
 */
export function fireAlert(alert: PostureAlert): void {
  const s = getSettings()
  if (!s.notifications.enabled) return
  if (alert.kind === 'recovery') return // v1: tracked silently
  const issue = s.issues[alert.issue]
  if (!issue?.enabled) return
  if (alert.stage < 1 || alert.stage > 3) return
  if (!issue.notifyStages[(alert.stage - 1) as 0 | 1 | 2]) return
  if (alert.kind === 'escalation' && !s.notifications.escalation) return

  const copy = COPY[alert.issue][alert.stage as 1 | 2 | 3]
  const body =
    alert.kind === 'escalation' ? `Still going — ${interpolate(copy.body, alert)}` : interpolate(copy.body, alert)

  showToast(interpolate(copy.title, alert), body, !s.notifications.sound)
}

export function testNotification(): void {
  showToast(
    'SitSense test notification',
    'Nudges will look like this. If you never see them, check Windows notification settings for SitSense.',
    !getSettings().notifications.sound
  )
}

export function trayHint(): void {
  showToast('SitSense is still watching', 'Monitoring continues from the tray. Quit via the tray menu.', true)
}

function showToast(title: string, body: string, silent: boolean): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent })
  n.on('click', () => showMainWindow())
  n.show()
}

export function stageLabel(stage: Stage): string {
  return (['fine', 'slight', 'clear', 'severe'] as const)[stage]
}
