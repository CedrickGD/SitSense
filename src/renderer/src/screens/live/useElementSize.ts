import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** The element's border-box size, kept current with a ResizeObserver (0×0 until measured). */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = (): void => {
      const r = el.getBoundingClientRect()
      setSize((s) => (Math.round(s.width) === Math.round(r.width) && Math.round(s.height) === Math.round(r.height) ? s : { width: r.width, height: r.height }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}
