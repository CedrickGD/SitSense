import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface FillLayout<R extends HTMLElement, L extends HTMLElement> {
  /** on the page root */
  rootRef: RefObject<R | null>
  /** on the last row, which takes the spare height */
  lastRowRef: RefObject<L | null>
  /** min-height that fills the scrolling viewport, undefined until measured */
  fill: number | undefined
  /** the height the last row gets when nothing scrolls (0 until measured) */
  lastRowRoom: number
}

/**
 * Fill the shell's scrolling `main` and report how tall the last row will be. CSS alone
 * can't fill: the shell's page wrapper only has a min-height, so a `min-h-full` child
 * resolves to auto. The room is measured from the row's top edge, which only depends on
 * what sits above it — cards may size themselves from it without a feedback loop.
 */
export function useFillHeight<R extends HTMLElement, L extends HTMLElement>(): FillLayout<R, L> {
  const rootRef = useRef<R>(null)
  const lastRowRef = useRef<L>(null)
  const [m, setM] = useState<{ fill: number | undefined; room: number }>({ fill: undefined, room: 0 })
  useLayoutEffect(() => {
    const root = rootRef.current
    const parent = root?.parentElement
    const scroller = root?.closest('main') ?? null
    if (!root || !parent || !scroller || typeof ResizeObserver === 'undefined') return
    const read = (): void => {
      const cs = getComputedStyle(parent)
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      const fill = Math.max(0, Math.floor(scroller.clientHeight - pad))
      const row = lastRowRef.current
      const room = row ? Math.max(0, Math.floor(fill - (row.getBoundingClientRect().top - root.getBoundingClientRect().top))) : 0
      setM((prev) => (prev.fill === fill && prev.room === room ? prev : { fill, room }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(scroller)
    ro.observe(root)
    // when something above the row changes (a banner, row 1) either the root grows or the
    // flex-1 row shrinks — observing both catches every move of the row's top edge
    if (lastRowRef.current) ro.observe(lastRowRef.current)
    return () => ro.disconnect()
  }, [])
  return { rootRef, lastRowRef, fill: m.fill, lastRowRoom: m.room }
}
