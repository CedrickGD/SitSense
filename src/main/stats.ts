import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { PostureSnapshot, StatMinute, TodayStats } from '../shared/posture'
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
let sampleTimer: NodeJS.Timeout | null = null
let writePending = false

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
  return { date: loadedDate || todayKey(), minutes: out }
}

function currentStateKey(): StatMinute['s'] {
  if (getPauseState().paused) return 'paused'
  if (!lastSnapshot || Date.now() - lastSnapshotAt > STALE_MS) return 'paused'
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
    if (todayKey() !== loadedDate) {
      // midnight rollover — start a fresh day file
      flush()
      minutes = []
      loadedDate = todayKey()
    }
  }
  const key = currentStateKey()
  minuteCounts.set(key, (minuteCounts.get(key) ?? 0) + 1)
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
    minutes.push({ m: currentMinute, s: state })
    scheduleWrite()
  }
  minuteCounts = new Map()
}

function loadToday(): void {
  loadedDate = todayKey()
  try {
    const raw = JSON.parse(readFileSync(join(statsDir(), `${loadedDate}.json`), 'utf8')) as TodayStats
    if (Array.isArray(raw.minutes)) minutes = raw.minutes.filter((m) => typeof m?.m === 'number')
  } catch {
    minutes = []
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
    writeFileSync(tmp, JSON.stringify({ date: loadedDate, minutes } satisfies TodayStats))
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
