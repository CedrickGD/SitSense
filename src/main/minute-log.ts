import type { StatMinute } from '../shared/posture'

/**
 * Keeps the log strictly increasing by minute. Normally this appends; a
 * restart within the same minute or a clock stepped backwards must replace
 * or insert instead of duplicating (the timeline would double-count).
 */
export function upsertMinute(list: StatMinute[], entry: StatMinute): void {
  const last = list[list.length - 1]
  if (!last || last.m < entry.m) {
    list.push(entry)
    return
  }
  const i = list.findIndex((x) => x.m >= entry.m)
  if (list[i].m === entry.m) list[i] = entry
  else list.splice(i, 0, entry)
}
