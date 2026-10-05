import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { PostureSnapshot, StatMinute, TodayStats } from '../shared/posture'
import { STATS_RANGE_MAX_DAYS, computeStreak, emptyDay, lastDateKeys, summarizeDay, type DaySummary, type StatsRange } from '../shared/stats'
import { getPauseState } from './pause'

/**
 * Per-minute posture log for the dashboard's Today strip.
 * Samples the last known snapshot every 5s; each finished minute stores its
 * dominant state. Files: userData/stats/YYYY-MM-DD.json, pruned after 90 days.
 */

const SAMPLE_MS = 5_000
const KEEP_DAYS = 90
/** snapshots older than this are treated as "not detecting" (logged as paused) */
const STALE_MS = 15_000

let lastSnapshot: PostureSnapshot | null = null
let lastSnapshotAt = 0
let currentMinute = -1
let minuteCounts = new Map<StatMinute['s'], number>()
let minutes: StatMinute[] = []
/** today's posture nudges / breaks taken (stored in the day file next to the minutes) */
let alerts = 0
let breaks = 0
let sampleTimer: NodeJS.Timeout | null = null
let writePending = false
/** summaries of finished days (their files no longer change); dropped at midnight rollover */
const pastDayCache = new Map<string, DaySummary>()

const statsDir = (): string => join(app.getPath('userData'), 'stats')
const todayKey = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
let loadedDate = ''

export function initStats(): void {
  loadToday()
  pruneOld()
  sampleTimer = setInterval(sample, SAMPLE_MS)
}

export function stopStats(): void {
  if (sampleTimer) clearInterval(sampleTimer)
  finishMinute()
  flush()
}

export function statsPostureUpdate(snapshot: PostureSnapshot): void {
  lastSnapshot = snapshot
  lastSnapshotAt = Date.now()
}

export function getTodayStats(): TodayStats {
  const partial = dominant()
  const out = [...minutes]
  if (partial && currentMinute > 0) out.push({ m: currentMinute, s: partial })
  return { date: loadedDate || todayKey(), minutes: out, alerts, breaks }
}

/** a posture nudge was shown (counted per day for the history view) */
export function statsRecordAlert(): void {
  rollDayIfNeeded()
  alerts++
  scheduleWrite()
}

/** the user took a break after a sitting stretch (main/breaks.ts) */
export function statsRecordBreak(): void {
  rollDayIfNeeded()
  breaks++
  scheduleWrite()
}

export function getBreaksToday(): number {
  return loadedDate === todayKey() ? breaks : 0
}

/** Clamp/validate the IPC argument: a whole number of days in 1..90. */
export function normalizeRangeDays(days: unknown): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) throw new TypeError('days must be a number in 1..90')
  return Math.min(STATS_RANGE_MAX_DAYS, Math.max(1, Math.round(days)))
}

async function readDaySummary(date: string): Promise<DaySummary> {
  const cached = pastDayCache.get(date)
  if (cached) return cached
  let summary: DaySummary
  try {
    const raw = JSON.parse(await readFile(join(statsDir(), `${date}.json`), 'utf8')) as Partial<TodayStats>
    summary = summarizeDay(date, raw)
  } catch (err) {
    // a missing file is a day without data; anything else (locked, half-written) is retried next time
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return emptyDay(date)
    summary = emptyDay(date)
  }
  if (pastDayCache.size > STATS_RANGE_MAX_DAYS * 2) pastDayCache.clear()
  pastDayCache.set(date, summary)
  return summary
}

/** Per-day summaries for the last `days` local days (today included, oldest first) plus the streak. */
export async function getStatsRange(rawDays: unknown): Promise<StatsRange> {
  const days = normalizeRangeDays(rawDays)
  rollDayIfNeeded()
  const today = todayKey()
  const keys = lastDateKeys(new Date(), days)
  const list = await Promise.all(keys.map((d) => (d === today ? Promise.resolve(summarizeDay(d, getTodayStats())) : readDaySummary(d))))
  return { days: list, streak: computeStreak(list) }
}

function currentStateKey(): StatMinute['s'] {
  if (getPauseState().paused) return 'paused'
  if (!lastSnapshot || Date.now() - lastSnapshotAt > STALE_MS) return 'paused'
  // uncalibrated time must not count as "good" — 'paused' is the existing
  // not-detecting bucket
  if (!lastSnapshot.calibrated) return 'paused'
  if (lastSnapshot.presence === 'away') return 'away'
  if (lastSnapshot.worstStage === 0) return 'good'
  const worst = Object.values(lastSnapshot.issues).reduce((a, b) => (b.stage > a.stage ? b : a))
  return `${worst.issue}:${worst.stage as 1 | 2 | 3}`
}

function sample(): void {
  const nowMinute = Math.floor(Date.now() / 60_000)
  if (currentMinute === -1) currentMinute = nowMinute
  if (nowMinute !== currentMinute) {
    finishMinute()
    currentMinute = nowMinute
    rollDayIfNeeded()
  }
  const key = currentStateKey()
  minuteCounts.set(key, (minuteCounts.get(key) ?? 0) + 1)
}

/** midnight rollover — write out the finished day, start a fresh day file */
function rollDayIfNeeded(): void {
  if (!loadedDate || todayKey() === loadedDate) return
  // the minute in progress still belongs to the day that just ended
  finishMinute()
  flush()
  pastDayCache.delete(loadedDate)
  minutes = []
  alerts = 0
  breaks = 0
  loadedDate = todayKey()
}

function dominant(): StatMinute['s'] | null {
  let best: StatMinute['s'] | null = null
  let bestCount = 0
  for (const [k, c] of minuteCounts) {
    if (c > bestCount) {
      best = k
      bestCount = c
    }
  }
  return best
}

function finishMinute(): void {
  const state = dominant()
  if (state && currentMinute > 0) {
    // an app restart within the same minute would otherwise duplicate the entry
    const last = minutes[minutes.length - 1]
    if (last && last.m === currentMinute) last.s = state
    else minutes.push({ m: currentMinute, s: state })
    scheduleWrite()
  }
  minuteCounts = new Map()
}

function loadToday(): void {
  loadedDate = todayKey()
  try {
    const raw = JSON.parse(readFileSync(join(statsDir(), `${loadedDate}.json`), 'utf8')) as TodayStats
    if (Array.isArray(raw.minutes)) minutes = raw.minutes.filter((m) => typeof m?.m === 'number')
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
    alerts = n(raw.alerts)
    breaks = n(raw.breaks)
  } catch {
    minutes = []
    alerts = 0
    breaks = 0
  }
}

function scheduleWrite(): void {
  if (writePending) return
  writePending = true
  setTimeout(() => {
    writePending = false
    flush()
  }, SAMPLE_MS)
}

function flush(): void {
  try {
    mkdirSync(statsDir(), { recursive: true })
    const file = join(statsDir(), `${loadedDate || todayKey()}.json`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ date: loadedDate, minutes, alerts, breaks } satisfies TodayStats))
    renameSync(tmp, file)
  } catch (err) {
    console.error('[stats] write failed:', err)
  }
}

function pruneOld(): void {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000
    for (const f of readdirSync(statsDir())) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.json$/.exec(f)
      if (!m) continue
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (t < cutoff) unlinkSync(join(statsDir(), f))
    }
  } catch {
    // stats dir may not exist yet
  }
}

/** Test-only: reset module state between cases. */
export function __resetStatsForTests(): void {
  if (sampleTimer) clearInterval(sampleTimer)
  sampleTimer = null
  lastSnapshot = null
  lastSnapshotAt = 0
  currentMinute = -1
  minuteCounts = new Map()
  minutes = []
  alerts = 0
  breaks = 0
  loadedDate = ''
  pastDayCache.clear()
}
