// History data: the last 90 days (getStatsRange) plus today's minute log (getTodayStats,
// the only minute-level data main exposes — it drives today's timeline and stretches).
// Refreshed every minute while the page is open and when the window comes back.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TodayStats } from '@shared/posture'
import { STATS_RANGE_MAX_DAYS, summarizeDay, type StatsRange } from '@shared/stats'

export interface HistoryData {
  range: StatsRange | null
  today: TodayStats | null
  loading: boolean
  error: boolean
  reload: () => void
}

const REFRESH_MS = 60_000

export function useHistoryData(): HistoryData {
  const [range, setRange] = useState<StatsRange | null>(null)
  const [today, setToday] = useState<TodayStats | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)

  const load = useCallback((): void => {
    Promise.all([window.sitsense.getStatsRange(STATS_RANGE_MAX_DAYS), window.sitsense.getTodayStats().catch(() => null)])
      .then(([r, t]) => {
        if (!alive.current) return
        // keep today's summary in step with the minute log fetched alongside it
        if (t && r.days.length > 0 && r.days[r.days.length - 1].date === t.date) {
          r = { ...r, days: [...r.days.slice(0, -1), summarizeDay(t.date, t)] }
        }
        setRange(r)
        setToday(t)
        setError(false)
      })
      .catch(() => {
        if (alive.current) setError(true)
      })
      .finally(() => {
        if (alive.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    const timer = setInterval(load, REFRESH_MS)
    const off = window.sitsense.onWindowVisibility((visible) => {
      if (visible) load()
    })
    return () => {
      alive.current = false
      clearInterval(timer)
      off()
    }
  }, [load])

  const reload = useCallback((): void => {
    setLoading(true)
    setError(false)
    load()
  }, [load])

  return { range, today, loading: loading && !range, error: error && !range, reload }
}
