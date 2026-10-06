// Regression: confirm popovers (Clear chat, Delete and redo setup, Remove all keys, Reset,
// Leave setup) never got keyboard focus — the focus() ran while the portal box was still
// visibility:hidden, which is a no-op. focusWhenReady waits for the box to be ready.
import { describe, expect, it } from 'vitest'
import { FIRST_FOCUSABLE, focusWhenReady, initialFocusTarget, type FrameScheduler } from '../focus'

function fakeFrames(): FrameScheduler & { flush: () => void; pending: () => number } {
  let queue: { id: number; cb: () => void }[] = []
  let next = 1
  return {
    request: (cb) => {
      const id = next++
      queue.push({ id, cb })
      return id
    },
    cancel: (id) => {
      queue = queue.filter((q) => q.id !== id)
    },
    flush: () => {
      const run = queue
      queue = []
      for (const q of run) q.cb()
    },
    pending: () => queue.length
  }
}

const target = (): { focus: () => void; focused: number } => {
  const t = { focused: 0, focus: () => void (t.focused += 1) }
  return t
}

describe('focusWhenReady', () => {
  it('never focuses synchronously: the floating box is still hidden in the same commit', () => {
    const f = fakeFrames()
    const t = target()
    focusWhenReady(() => t, 4, f)
    expect(t.focused).toBe(0)
    f.flush()
    expect(t.focused).toBe(1)
    expect(f.pending()).toBe(0)
  })

  it('waits while the target is not ready (hidden / not mounted), then focuses once', () => {
    const f = fakeFrames()
    const t = target()
    let visible = false
    focusWhenReady(() => (visible ? t : null), 4, f)
    f.flush()
    expect(t.focused).toBe(0)
    visible = true
    f.flush()
    expect(t.focused).toBe(1)
    f.flush()
    expect(t.focused).toBe(1)
  })

  it('gives up after the frame budget', () => {
    const f = fakeFrames()
    let calls = 0
    focusWhenReady(
      () => {
        calls += 1
        return null
      },
      3,
      f
    )
    for (let i = 0; i < 6; i++) f.flush()
    expect(calls).toBe(3)
    expect(f.pending()).toBe(0)
  })

  it('cancel (popover closed / effect cleanup) stops a pending focus', () => {
    const f = fakeFrames()
    const t = target()
    const cancel = focusWhenReady(() => t, 4, f)
    cancel()
    f.flush()
    expect(t.focused).toBe(0)
    expect(() => cancel()).not.toThrow()
  })
})

describe('initialFocusTarget', () => {
  const root = (hits: Record<string, unknown>): { querySelector: (s: string) => unknown } => ({
    querySelector: (s) => hits[s] ?? null
  })

  it('prefers the data-autofocus marker (Confirm focuses Cancel, not the first button)', () => {
    const cancel = target()
    const first = target()
    expect(initialFocusTarget(root({ '[data-autofocus]': cancel, [FIRST_FOCUSABLE]: first }))).toBe(cancel)
  })

  it('falls back to the first enabled focusable control, or null', () => {
    const first = target()
    expect(initialFocusTarget(root({ [FIRST_FOCUSABLE]: first }))).toBe(first)
    expect(initialFocusTarget(root({}))).toBeNull()
    expect(initialFocusTarget(null)).toBeNull()
    expect(FIRST_FOCUSABLE).toContain('[role="menuitem"]:not([disabled])')
    expect(FIRST_FOCUSABLE).toContain('button:not([disabled])')
  })
})
