// Number and date formatting — the single source (docs/specs/ui-v3.md §8.3).
// Pure; unit-tested in __tests__/format.test.ts. Never returns NaN / null / undefined /
// negative durations: anything unusable becomes "—".

export const DASH = '—'
/** U+2212 — the real minus sign for signed deviations */
export const MINUS = '−'

const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

// ───────────────────────────── durations ─────────────────────────────

/**
 * A duration in milliseconds.
 * ≥ 1 h → `4h 06m`; < 1 h → `38 min`; < 1 min → `42s` (live counters) or `<1 min` (totals).
 */
export function fmtDuration(ms: number | null | undefined, opts: { live?: boolean } = {}): string {
  if (!ok(ms) || ms < 0) return DASH
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return opts.live ? `${Math.floor(ms / 1000)}s` : '<1 min'
  return fmtMinutes(totalMin)
}

/** Whole minutes as a total: `0 min`, `38 min`, `4h 06m`. */
export function fmtMinutes(min: number | null | undefined): string {
  if (!ok(min) || min < 0) return DASH
  const n = Math.floor(min)
  if (n < 60) return `${n} min`
  return `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, '0')}m`
}

/** Countdown `m:ss` (e.g. a pause that ends by itself). */
export function fmtCountdown(msLeft: number | null | undefined): string {
  if (!ok(msLeft)) return DASH
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ───────────────────────────── values ─────────────────────────────

/** Integer percent, no space: `82%`. Accepts 0–100 (or a 0–1 share with `{ share: true }`). */
export function fmtPercent(v: number | null | undefined, opts: { share?: boolean } = {}): string {
  if (!ok(v)) return DASH
  return `${Math.round(opts.share ? v * 100 : v)}%`
}

/** The score number, integer, no unit (the "/100" is a separate caption). */
export function fmtScore(v: number | null | undefined): string {
  if (!ok(v)) return DASH
  return String(Math.round(Math.min(100, Math.max(0, v))))
}

/** An angle in whole degrees; `signed` adds + / − (deviations): `+4°`, `−3°`, `0°`. */
export function fmtAngle(deg: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (!ok(deg)) return DASH
  const r = Math.round(Math.abs(deg))
  if (!opts.signed || r === 0) return `${r}°`
  return `${deg > 0 ? '+' : MINUS}${r}°`
}

/** A distance in whole centimetres with a space: `5 cm`. */
export function fmtCm(cm: number | null | undefined): string {
  if (!ok(cm)) return DASH
  return `${Math.round(Math.abs(cm))} cm`
}

/** Counts with locale grouping: `1,204` / `1.204`. */
export function fmtCount(n: number | null | undefined): string {
  if (!ok(n)) return DASH
  return new Intl.NumberFormat().format(Math.round(n))
}

/** `1 break` / `3 breaks` (English plural with an s, or the given plural). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtCount(n)} ${n === 1 ? one : many}`
}

// ───────────────────────────── clock and dates ─────────────────────────────

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/** Clock time in the user's locale (24 h for de-DE): `14:20`. Takes epoch ms or a Date. */
export function fmtClock(t: number | Date | null | undefined): string {
  const d = t instanceof Date ? t : ok(t) ? new Date(t) : null
  if (!d || Number.isNaN(d.getTime())) return DASH
  return clockFmt.format(d)
}

/** Clock time of an epoch minute (StatMinute.m). */
export function fmtClockMinute(epochMinute: number | null | undefined): string {
  return ok(epochMinute) ? fmtClock(epochMinute * 60_000) : DASH
}

const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' })

/** `Mon 5 Oct` (localized names, fixed order). Takes a Date, epoch ms or `YYYY-MM-DD`. */
export function fmtDate(t: number | Date | string | null | undefined): string {
  const d = toDate(t)
  if (!d) return DASH
  return `${weekdayFmt.format(d).replace(/\.$/, '')} ${d.getDate()} ${monthFmt.format(d).replace(/\.$/, '')}`
}

/** `Today, Mon 5 Oct` / `Yesterday, Sun 4 Oct` / `Thu 1 Oct`. */
export function fmtDayLabel(t: number | Date | string | null | undefined, now: Date = new Date()): string {
  const d = toDate(t)
  if (!d) return DASH
  const diff = dayDiff(d, now)
  if (diff === 0) return `Today, ${fmtDate(d)}`
  if (diff === 1) return `Yesterday, ${fmtDate(d)}`
  return fmtDate(d)
}

/** `just now`, `2 min ago`, `3 h ago`, `yesterday`, `2 days ago`. */
export function fmtRelative(t: number | Date | null | undefined, now: number | Date = Date.now()): string {
  const d = toDate(t)
  if (!d) return DASH
  const nowD = now instanceof Date ? now : new Date(now)
  const ms = nowD.getTime() - d.getTime()
  if (ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min ago`
  const days = dayDiff(d, nowD)
  if (days === 0) return `${Math.floor(min / 60)} h ago`
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/** Local `YYYY-MM-DD` → Date at local midnight. */
export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

function toDate(t: number | Date | string | null | undefined): Date | null {
  if (t instanceof Date) return Number.isNaN(t.getTime()) ? null : t
  if (typeof t === 'string') return parseDateKey(t)
  if (ok(t)) return new Date(t)
  return null
}

/** Whole calendar days from `a` to `b` (local), e.g. yesterday → today = 1. */
function dayDiff(a: Date, b: Date): number {
  const a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const b0 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((b0 - a0) / 86_400_000)
}
