// Continuous-sitting tracker behind the stand-up reminders. Pure (no Electron) so it
// can be tested with a fake clock; main/breaks.ts feeds it and renders the toast.
//
// Rules:
// - "sitting" = a fresh posture snapshot says the user is at the desk (presence
//   'active'), monitoring not paused. Calibration doesn't matter.
// - Anything else (away, paused, no fresh snapshot) is "absent". Absences shorter
//   than BREAK_MIN_MS don't interrupt the stretch (reaching for a coffee isn't a break);
//   once an absence reaches BREAK_MIN_MS the stretch ends.
// - A gap of BREAK_MIN_MS or more between ticks (system sleep) also ends the stretch.
// - A break counts toward "breaks taken" when the stretch it ends lasted at least
//   MIN_COUNTED_STRETCH_MS — so every break that follows a reminder counts.
// - The reminder fires while sitting once the stretch reaches the interval, then
//   repeats every REPEAT_MS if ignored; snoozing pushes it out.

import type { SittingState } from '../shared/ipc'
import type { BreakSettings } from '../shared/settings'

export const BREAK_MIN_MS = 3 * 60_000
export const MIN_COUNTED_STRETCH_MS = 20 * 60_000
export const REPEAT_MS = 15 * 60_000
export const SNOOZE_DEFAULT_MIN = 10
export const SNOOZE_MAX_MIN = 120

export type SittingInput = 'sitting' | 'absent'

export interface BreakTrackerDeps {
  settings(): BreakSettings
  /** show the stand-up reminder for a stretch of `minutes` */
  remind(minutes: number): void
  /** a counted break just happened */
  breakTaken(): void
}

export class BreakTracker {
  private sittingSince: number | null = null
  private absentSince: number | null = null
  private lastReminderAt: number | null = null
  private snoozeUntil: number | null = null
  private lastTickAt: number | null = null
  private lastInput: SittingInput = 'absent'
  /** when the last stretch ended (= when its break began); null until one has ended */
  private stretchEndedAt: number | null = null

  constructor(private readonly deps: BreakTrackerDeps) {}

  /** Feed the current status (call every few seconds and on posture updates). */
  tick(now: number, input: SittingInput): void {
    // a long gap between ticks = the computer slept; nobody was sitting through it
    if (this.lastTickAt !== null && now - this.lastTickAt >= BREAK_MIN_MS && this.sittingSince !== null) {
      this.endStretch(this.absentSince ?? this.lastTickAt)
    }
    this.lastTickAt = now
    this.lastInput = input

    if (input === 'sitting') {
      this.absentSince = null
      if (this.sittingSince === null) this.sittingSince = now
      const due = this.dueAt()
      if (due !== null && now >= due) {
        this.lastReminderAt = now
        this.snoozeUntil = null
        this.deps.remind(this.minutes(now))
      }
      return
    }

    if (this.sittingSince === null) return
    if (this.absentSince === null) this.absentSince = now
    if (now - this.absentSince >= BREAK_MIN_MS) this.endStretch(this.absentSince)
  }

  /** postpone the reminder by `minutes` from now (1..SNOOZE_MAX_MIN) */
  snooze(now: number, minutes: number = SNOOZE_DEFAULT_MIN): void {
    const m = Number.isFinite(minutes) ? Math.min(SNOOZE_MAX_MIN, Math.max(1, minutes)) : SNOOZE_DEFAULT_MIN
    this.snoozeUntil = now + m * 60_000
  }

  state(now: number, breaksToday: number): SittingState {
    // during a stretch a break is under way once the user is away; after a stretch it runs
    // from the stretch end until they sit again. Before any stretch nothing is a break.
    const breakSince =
      this.sittingSince !== null ? this.absentSince : this.lastInput === 'absent' ? this.stretchEndedAt : null
    return {
      sittingMinutes: this.minutes(now),
      sittingSince: this.sittingSince,
      onBreak: breakSince !== null,
      breakSince,
      nextReminderAt: this.dueAt(),
      breaksToday
    }
  }

  /** when the next reminder is due; null = not sitting or reminders off */
  private dueAt(): number | null {
    const s = this.deps.settings()
    if (!s.enabled || this.sittingSince === null) return null
    const base = this.sittingSince + s.intervalMinutes * 60_000
    // an explicit snooze replaces the automatic repeat ("Snooze 10 min" means 10, not 15)
    if (this.snoozeUntil !== null) return Math.max(base, this.snoozeUntil)
    if (this.lastReminderAt !== null) return Math.max(base, this.lastReminderAt + REPEAT_MS)
    return base
  }

  private minutes(now: number): number {
    return this.sittingSince === null ? 0 : Math.max(0, Math.floor((now - this.sittingSince) / 60_000))
  }

  private endStretch(stoppedAt: number): void {
    const since = this.sittingSince
    this.sittingSince = null
    this.absentSince = null
    this.lastReminderAt = null
    this.snoozeUntil = null
    if (since !== null) this.stretchEndedAt = stoppedAt
    if (since !== null && stoppedAt - since >= MIN_COUNTED_STRETCH_MS) this.deps.breakTaken()
  }
}
