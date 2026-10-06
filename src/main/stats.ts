import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { PostureSnapshot, StatMinute, TodayStats } from '../shared/posture'
import { STATS_RANGE_MAX_DAYS, computeStreak, emptyDay, lastDateKeys, summarizeDay, type DaySummary, type StatsRange } from '../shared/stats'
import { getPauseState } from './pause'

/**
 * Per-minute posture log for the dashboard's Today strip.
 * Samples the last known snapshot every 5s; each finished minute stores its
 * dominant state. Files: userData/stats/YYYY-MM-DD.json, pruned after 90 days (at
 * start and at every day change). A day file that can't be read is never written over
 * blindly: it is quarantined (corrupt) or merged in once readable (locked).
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
  // the view drifted far from setup: nothing is judged, so the minute is not "good" either
  if (lastSnapshot.suspended === true) return 'paused'
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

/** date change (midnight, or the clock set back/corrected) — write out the old day, load the new one */
function rollDayIfNeeded(): void {
  if (!loadedDate || todayKey() === loadedDate) return
  // the minute in progress still belongs to the day that just ended
  finishMinute()
  flush()
  pastDayCache.delete(loadedDate)
  // the new date may already have a file (clock set back): continue it instead of overwriting it
  loadDay(todayKey())
  pastDayCache.delete(loadedDate)
  // the tray app can run for weeks; keep the 90-day retention promise without a restart
  pruneOld()
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

/** keep `minutes` sorted by m with one entry per minute (the clock may have been set back) */
function upsertMinute(m: number, s: StatMinute['s']): void {
  const last = minutes[minutes.length - 1]
  // common case: append, or overwrite after an app restart within the same minute
  if (!last || last.m < m) minutes.push({ m, s })
  else if (last.m === m) last.s = s
  else {
    const i = minutes.findIndex((e) => e.m >= m)
    if (minutes[i].m === m) minutes[i].s = s
    else minutes.splice(i, 0, { m, s })
  }
}

function finishMinute(): void {
  const state = dominant()
  if (state && currentMinute > 0) {
    upsertMinute(currentMinute, state)
    scheduleWrite()
  }
  minuteCounts = new Map()
}

const dayFile = (date: string): string => join(statsDir(), `${date}.json`)
const READ_RETRY_DELAY_MS = 150
const errCode = (err: unknown): string => (err as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN'

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type ReadResult = { ok: true; text: string } | { ok: false; code: string; error: unknown }

/** Read the file; on anything but "does not exist", retry after a short pause (`attempts` total). */
function readDayText(file: string, attempts: number): ReadResult {
  let last: ReadResult = { ok: false, code: 'UNKNOWN', error: null }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return { ok: true, text: readFileSync(file, 'utf8') }
    } catch (err) {
      last = { ok: false, code: errCode(err), error: err }
      if (last.code === 'ENOENT') return last
      if (attempt < attempts - 1) sleepSync(READ_RETRY_DELAY_MS)
    }
  }
  return last
}

type DayData = { minutes: StatMinute[]; alerts: number; breaks: number }

/** Parse a day file; null when it isn't a JSON object (truncated / garbage). A leading BOM is fine. */
function parseDay(text: string): DayData | null {
  let raw: unknown
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Partial<TodayStats>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  return {
    minutes: Array.isArray(r.minutes) ? r.minutes.filter((m) => typeof m?.m === 'number').sort((a, b) => a.m - b.m) : [],
    alerts: n(r.alerts),
    breaks: n(r.breaks)
  }
}

/** Move a day file that doesn't parse out of the way so no later write destroys it. */
function quarantineCorrupt(file: string): boolean {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    renameSync(file, backup)
  } catch {
    try {
      copyFileSync(file, backup)
    } catch (err) {
      console.error('[stats] could not back up the corrupt day file:', err)
      return false
    }
  }
  console.error(`[stats] ${file} is corrupt; moved it to ${backup}`)
  return true
}

/**
 * Today's file exists but couldn't be read (locked by AV/backup at login) or couldn't be
 * moved aside: the day is tracked in memory from zero and must be merged into the file
 * before anything is written over it (see flush()).
 */
let unmergedDisk = false

function loadToday(): void {
  loadDay(todayKey())
}

/** Make `date` the day in memory: every field is reset first, then its file (if any) is loaded. */
function loadDay(date: string): void {
  loadedDate = date
  minutes = []
  alerts = 0
  breaks = 0
  unmergedDisk = false
  const file = dayFile(date)
  const read = readDayText(file, 2)
  if (!read.ok) {
    if (read.code === 'ENOENT') return // no data for this day yet
    unmergedDisk = true
    console.error(`[stats] ${file} is unreadable (${read.code}); tracking continues and is merged into it later:`, read.error)
    return
  }
  const data = parseDay(read.text)
  if (!data) {
    // if the backup failed, the original stays and must never be overwritten
    unmergedDisk = !quarantineCorrupt(file)
    return
  }
  ;({ minutes, alerts, breaks } = data)
}

/**
 * Fold the on-disk day into memory once it can be read. Returns false while it still can't
 * be (the write must then be skipped so the file's earlier minutes survive).
 */
function mergeUnmergedDisk(file: string): boolean {
  const read = readDayText(file, 1)
  if (!read.ok) {
    if (read.code !== 'ENOENT') return false
    unmergedDisk = false
    return true
  }
  const disk = parseDay(read.text)
  if (!disk) {
    if (!quarantineCorrupt(file)) return false
    unmergedDisk = false
    return true
  }
  const inMemory = new Set(minutes.map((e) => e.m))
  minutes = [...disk.minutes.filter((e) => !inMemory.has(e.m)), ...minutes].sort((a, b) => a.m - b.m)
  // the in-memory counters started at 0 when the read failed
  alerts += disk.alerts
  breaks += disk.breaks
  unmergedDisk = false
  return true
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
    const file = dayFile(loadedDate || todayKey())
    if (unmergedDisk && !mergeUnmergedDisk(file)) {
      // still locked/unreadable: keep the data in memory and try again on the next write
      console.warn(`[stats] ${file} still can't be read; postponing the write so its earlier data isn't lost`)
      return
    }
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
  unmergedDisk = false
  writePending = false
  pastDayCache.clear()
}
