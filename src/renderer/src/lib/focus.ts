// Moving keyboard focus into things that only become focusable a frame or two later:
// a portal popover (Floating renders hidden at -9999 until its layout effect places it,
// and focus() on a visibility:hidden element is a no-op) or a screen that mounts after a
// route change (Ctrl+L → the coach composer). Pure scheduling; unit-tested.

/** Something that can be focused (an HTMLElement in the app; a stub in tests). */
export interface Focusable {
  focus(): void
}

/** The subset of Element used to pick an initial focus target. */
export interface FocusRoot {
  querySelector(selector: string): unknown
}

/** First focusable control inside a popover when nothing is marked data-autofocus. */
export const FIRST_FOCUSABLE =
  '[role="menuitem"]:not([disabled]), button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]'

/** An explicit `data-autofocus` marker wins over the first focusable control. */
export function initialFocusTarget(root: FocusRoot | null | undefined): Focusable | null {
  if (!root) return null
  return ((root.querySelector('[data-autofocus]') ?? root.querySelector(FIRST_FOCUSABLE)) as Focusable | null) ?? null
}

export interface FrameScheduler {
  request: (cb: () => void) => number
  cancel: (handle: number) => void
}

const browserFrames = (): FrameScheduler => ({
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h)
})

/**
 * From the next animation frame on, look for the target with `find()` (null = not ready
 * yet: not mounted, still hidden…) and focus it; retries for up to `frames` frames, then
 * gives up silently. Never focuses synchronously. Returns a cancel function (call it from
 * an effect cleanup so a closed popover / left screen never steals focus later).
 */
export function focusWhenReady(
  find: () => Focusable | null | undefined,
  frames = 4,
  scheduler: FrameScheduler = browserFrames()
): () => void {
  let handle = 0
  let left = Math.max(1, frames)
  let done = false
  const tick = (): void => {
    if (done) return
    const target = find()
    if (target) {
      done = true
      target.focus()
      return
    }
    left -= 1
    if (left > 0) handle = scheduler.request(tick)
    else done = true
  }
  handle = scheduler.request(tick)
  return () => {
    if (done) return
    done = true
    scheduler.cancel(handle)
  }
}
