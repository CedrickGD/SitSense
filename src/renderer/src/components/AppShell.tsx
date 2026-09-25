import type { JSX, ReactNode } from 'react'
import type { AppRoute } from '@shared/ipc'
import { useAppStore } from '@renderer/state/store'
import SpineGlyph from './SpineGlyph'

function TitleBar(): JSX.Element {
  return (
    <header className="titlebar-drag flex h-9 shrink-0 items-center justify-between bg-surface pl-3">
      <div className="flex items-center gap-2">
        <SpineGlyph size={16} issue={null} stage={0} breathing={false} />
        <span className="text-[13px] font-medium text-text">SitSense</span>
      </div>
      <div className="titlebar-no-drag flex h-full">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => window.sitsense.windowControl('minimize')}
          className="flex h-full w-11 items-center justify-center text-text-dim hover:bg-white/5 hover:text-text"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0" y="4.25" width="10" height="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Close to tray"
          title="Closes to the tray — monitoring continues"
          onClick={() => window.sitsense.windowControl('hide')}
          className="flex h-full w-11 items-center justify-center text-text-dim hover:bg-coral/80 hover:text-ink"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
    </header>
  )
}

const NAV: { route: AppRoute; label: string; icon: JSX.Element }[] = [
  {
    route: 'dashboard',
    label: 'Dashboard',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <circle cx="10" cy="4" r="2.2" />
        <circle cx="6" cy="10" r="1.6" />
        <circle cx="14" cy="10" r="1.6" />
        <circle cx="10" cy="10" r="1.6" />
        <circle cx="8" cy="16" r="1.6" />
        <circle cx="12" cy="16" r="1.6" />
      </svg>
    )
  },
  {
    route: 'calibrate',
    label: 'Calibrate',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <circle cx="10" cy="10" r="6" />
        <path d="M10 1v4M10 15v4M1 10h4M15 10h4" />
      </svg>
    )
  },
  {
    route: 'settings',
    label: 'Settings',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <path d="M3 6h14M3 14h14" />
        <circle cx="8" cy="6" r="2" fill="var(--color-surface)" />
        <circle cx="13" cy="14" r="2" fill="var(--color-surface)" />
      </svg>
    )
  }
]

function NavRail(): JSX.Element {
  const route = useAppStore((s) => s.route)
  const setRoute = useAppStore((s) => s.setRoute)
  return (
    <nav aria-label="Main" className="flex w-14 shrink-0 flex-col items-center justify-between bg-surface py-3">
      <div className="flex flex-col gap-1">
        {NAV.map((item) => {
          const active = route === item.route
          return (
            <button
              key={item.route}
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => setRoute(item.route)}
              className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none ${
                active ? 'text-sage' : 'text-text-faint hover:bg-white/5 hover:text-text-dim'
              }`}
            >
              {active && <span className="absolute top-2 -left-1.5 h-7 w-[3px] rounded-full bg-sage" />}
              {item.icon}
            </button>
          )
        })}
      </div>
      <div
        className="flex h-9 w-9 items-center justify-center text-text-faint"
        title="All processing happens on this device. Nothing is uploaded — ever."
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <path d="M9 1.5l6 2.5v4c0 3.6-2.4 6.4-6 8-3.6-1.6-6-4.4-6-8V4z" />
          <circle cx="9" cy="8" r="2.2" />
          <path d="M6.2 12.4c.6-1.2 1.6-1.9 2.8-1.9s2.2.7 2.8 1.9" />
        </svg>
      </div>
    </nav>
  )
}

export default function AppShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col bg-ink">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
