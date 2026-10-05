// Stand-up reminders: feeds BreakTracker from posture snapshots and the pause state,
// shows the reminder toast (with a "Snooze 10 min" action), counts breaks in the day
// stats and tells the renderer how long the user has been sitting.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Notification } from 'electron'
import { IPC, type SittingState } from '../shared/ipc'
import type { PostureSnapshot } from '../shared/posture'
import { BreakTracker, SNOOZE_DEFAULT_MIN, type SittingInput } from './break-tracker'
import { getPauseState, onPauseChanged } from './pause'
import { resourcesDir } from './resources'
import { getSettings } from './settings-store'
import { getBreaksToday, statsRecordBreak } from './stats'
import { sendToRenderer, showMainWindow } from './window'

const TICK_MS = 15_000
/** a snapshot older than this means "not detecting" */
const STALE_MS = 15_000

let tracker: BreakTracker | null = null
let timer: NodeJS.Timeout | null = null
let lastSnapshot: PostureSnapshot | null = null
let lastSnapshotAt = 0
let lastSentKey = ''
/** held so the toast's click/action handlers aren't garbage-collected */
let toast: Notification | null = null

export function reminderCopy(minutes: number): { title: string; body: string } {
  return {
    title: 'Time to stand up',
    body: `You’ve been sitting for ${minutes} min. A 2-minute walk resets your back.`
  }
}

function currentInput(now: number): SittingInput {
  if (getPauseState().paused) return 'absent'
  if (!lastSnapshot || now - lastSnapshotAt > STALE_MS) return 'absent'
  return lastSnapshot.presence === 'active' ? 'sitting' : 'absent'
}

function showReminder(minutes: number): void {
  if (!Notification.isSupported()) return
  const { title, body } = reminderCopy(minutes)
  const icon = join(resourcesDir(), 'toast', 'good.png')
  const n = new Notification({
    title,
    body,
    silent: !getSettings().notifications.sound,
    actions: [{ type: 'button', text: `Snooze ${SNOOZE_DEFAULT_MIN} min` }],
    ...(existsSync(icon) ? { icon } : {})
  })
  n.on('click', () => showMainWindow())
  n.on('action', () => {
    snoozeBreak(SNOOZE_DEFAULT_MIN)
  })
  n.on('close', () => {
    if (toast === n) toast = null
  })
  toast?.close()
  toast = n
  n.show()
}

export function getSittingState(now = Date.now()): SittingState {
  if (!tracker) return { sittingMinutes: 0, sittingSince: null, onBreak: false, breakSince: null, nextReminderAt: null, breaksToday: getBreaksToday() }
  return tracker.state(now, getBreaksToday())
}

/** push the state to the renderer when something it shows changed */
function publish(force = false): void {
  const s = getSittingState()
  const key = `${s.sittingMinutes}|${s.sittingSince}|${s.onBreak}|${s.breakSince}|${s.nextReminderAt}|${s.breaksToday}`
  if (!force && key === lastSentKey) return
  lastSentKey = key
  sendToRenderer(IPC.sittingChanged, s)
}

function tick(): void {
  if (!tracker) return
  const now = Date.now()
  tracker.tick(now, currentInput(now))
  publish()
}

export function initBreaks(): void {
  if (tracker) return
  tracker = new BreakTracker({
    settings: () => getSettings().breaks,
    remind: (minutes) => {
      // a frame can race the pause switch; never nag while paused
      if (!getPauseState().paused) showReminder(minutes)
    },
    breakTaken: () => {
      statsRecordBreak()
      toast?.close()
      toast = null
    }
  })
  timer = setInterval(tick, TICK_MS)
  onPauseChanged(() => tick())
}

export function stopBreaks(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** posture:update — the snapshot only updates the input; the state machine runs on its own tick */
export function breaksPostureUpdate(snapshot: PostureSnapshot): void {
  const wasSitting = lastSnapshot?.presence === 'active'
  lastSnapshot = snapshot
  lastSnapshotAt = Date.now()
  // react at once when the user sits down or leaves, not up to 15 s later
  if ((snapshot.presence === 'active') !== wasSitting) tick()
}

/** breaks:snooze IPC and the toast action */
export function snoozeBreak(minutes: unknown = SNOOZE_DEFAULT_MIN): SittingState {
  const m = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : SNOOZE_DEFAULT_MIN
  tracker?.snooze(Date.now(), m)
  toast?.close()
  toast = null
  publish(true)
  return getSittingState()
}

/** settings changed (interval / enabled): the next reminder time moved */
export function breaksSettingsChanged(): void {
  publish()
}
