// Settings › AI models as a modal sheet inside the setup flow (ui-v3.md §7.4.4), so
// connecting a model for a second opinion doesn't lose setup. 720×560 (smaller windows:
// fits with a 24 px margin), e3, its own close; Esc closes the sheet, not setup.

import { useEffect, useRef, type JSX } from 'react'
import { createPortal } from 'react-dom'
import AiModelsSection from '@renderer/components/AiModelsSection'
import { Icon } from '@renderer/components/icons'
import { Button, IconButton } from '@renderer/components/primitives'

export default function AiSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    // focus the sheet itself (not the close button, whose tooltip would pop up at once)
    panelRef.current?.focus()
    // Esc inside the panel is handled by the panel's onKeyDown (below), so the section's own
    // Esc handlers (cancel the add/edit form, the remove confirm, a menu) win first. This
    // capture listener is only the fallback for focus outside the panel, and the Tab trap.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const t = e.target as Node
        // menus and listboxes portal to <body>: their own Esc closes them, not the sheet
        const inLayer = t instanceof Element && t.closest('[role="menu"], [role="listbox"], [role="dialog"]') !== null
        if (!panelRef.current?.contains(t) && !inLayer) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      // keep focus inside the sheet
      const items = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, a[href], [tabindex]:not([tabindex="-1"])'
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (before?.isConnected) before.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className="titlebar-no-drag fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6 backdrop-blur-sm motion-safe:animate-[fadeIn_150ms_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-sheet-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          // bubbles here only if nothing inside handled it (handlers there stopPropagation);
          // React's stopPropagation also keeps it from the setup frame's window listener
          if (e.key !== 'Escape' || e.defaultPrevented) return
          e.stopPropagation()
          e.preventDefault()
          // a menu opened by mouse leaves focus on its trigger, so its own Esc never runs:
          // close the topmost layer (the menu) first, the sheet on the next Esc
          const layer = document.querySelector<HTMLElement>('[role="menu"], [role="listbox"]')
          if (layer) {
            layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
            return
          }
          onClose()
        }}
        className="surface-popover flex h-[min(560px,100%)] outline-none w-[min(720px,100%)] flex-col overflow-hidden rounded-2xl motion-safe:animate-[ss-sheet_220ms_ease-out]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-white/[0.06] px-6 pt-5 pb-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sage-soft text-sage">
            <Icon name="spark" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="ai-sheet-title" className="type-h3 text-text">
              AI models
            </h2>
            <p className="mt-0.5 type-body text-text-dim">
              A connected model can check what the camera can’t — setup keeps running behind this sheet.
            </p>
          </div>
          <IconButton ref={closeRef} icon="close" label="Close AI models" ringOn="card-2" tooltipPlacement="bottom" onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5">
          <AiModelsSection />
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.06] px-6 py-3">
          <p className="flex items-center gap-2 type-caption text-text-faint">
            <Icon name="lock" size={14} />
            Keys stay encrypted on this PC.
          </p>
          <Button variant="primary" onClick={onClose} ringOn="card-2">
            Back to setup
          </Button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
