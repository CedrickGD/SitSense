// The v3 app shell (docs/specs/ui-v3.md §2): a labeled 220 px sidebar (Live, Coach,
// History, Settings; a 64 px icon rail below 1000 px), a 44 px top bar over the content
// column (page title + page actions + window controls), and the content area.
// Posture setup is not a place: <SetupFrame> replaces the whole shell while it runs.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import type { Stage } from '@shared/posture'
import { aiAvailable } from '@renderer/ai/helpers'
import { NAV_ROUTES, useAppStore, type NavRoute } from '@renderer/state/store'
import { fmtCountdown } from '@renderer/lib/format'
import { focusWhenReady } from '@renderer/lib/focus'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { isSuspended, NOT_JUDGED_COLOR } from '@renderer/lib/score'
import { breakpointFor, monitoringPillState, useMonitoring, useNow, useWindowWidth } from '@renderer/lib/hooks'
import { shortVersion } from '@renderer/screens/settings/update-view'
import { privacyNotice } from './CameraFeed'
import { Icon, type IconName } from './icons'
import { ConfirmPopover, focusRing, IconButton, Menu, StatusDot, Stepper, Tooltip, type MenuItem } from './primitives'

// ───────────────────────────── places ─────────────────────────────

export const PLACE_META: Record<NavRoute, { label: string; icon: IconName }> = {
  live: { label: 'Live', icon: 'live' },
  coach: { label: 'Coach', icon: 'coach' },
  history: { label: 'History', icon: 'history' },
  settings: { label: 'Settings', icon: 'settings' }
}

/** Places whose screen fills the content height itself (no page scroll), e.g. the chat. */
const FILL_ROUTES: readonly NavRoute[] = ['coach']
/** id of the coach composer's <textarea> (screens/coach/Composer.tsx) — Ctrl+L focuses it */
const COACH_COMPOSER_ID = 'coach-composer'

// ───────────────────────────── top bar slots ─────────────────────────────

interface TopBarSlots {
  sub: HTMLElement | null
  actions: HTMLElement | null
}

const SlotsContext = createContext<TopBarSlots>({ sub: null, actions: null })

/**
 * A page's contribution to the top bar: `sub` next to the title (caption, e.g. the
 * model name or History's date) and `children` = page actions on the right (before the
 * window controls). Render it anywhere inside the page; it portals into the bar.
 *
 *   <TopBarContent sub="Gemini · gemini-3.5-flash-lite">
 *     <Button size="sm" variant="ghost" icon="trash">Clear chat</Button>
 *   </TopBarContent>
 */
export function TopBarContent({ sub, children }: { sub?: ReactNode; children?: ReactNode }): JSX.Element {
  const slots = useContext(SlotsContext)
  return (
    <>
      {sub !== undefined && slots.sub && createPortal(sub, slots.sub)}
      {children !== undefined && slots.actions && createPortal(children, slots.actions)}
    </>
  )
}

// ───────────────────────────── window controls ─────────────────────────────

/** Minimize + close-to-tray (44×44 each). Used by the top bar and the setup frame. */
export function WindowControls(): JSX.Element {
  return (
    <div className="titlebar-no-drag flex h-11 shrink-0">
      <Tooltip content="Minimize" placement="bottom">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => void window.sitsense.windowControl('minimize')}
          className="flex h-11 w-11 items-center justify-center text-text-dim transition-colors duration-150 hover:bg-white/[0.06] hover:text-text focus-visible:bg-white/[0.06] focus-visible:outline-none"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0" y="4.25" width="10" height="1.5" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip content="Closes to the tray — monitoring continues" placement="bottom" align="end">
        <button
          type="button"
          aria-label="Close to tray"
          onClick={() => void window.sitsense.windowControl('hide')}
          className="flex h-11 w-11 items-center justify-center text-text-dim transition-colors duration-150 hover:bg-coral/80 hover:text-ink focus-visible:bg-coral/80 focus-visible:text-ink focus-visible:outline-none"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </Tooltip>
    </div>
  )
}

// ───────────────────────────── sidebar ─────────────────────────────

/**
 * The brand mark: the spine icon in the live state color — sage while fine (or idle),
 * the worst issue's stage color while watching, slate while paused or while nothing is
 * judged (the view drifted far from setup).
 */
function BrandMark({ size }: { size: number }): JSX.Element {
  const m = useMonitoring()
  const stage = useAppStore((s) => s.snapshot?.worstStage ?? 0)
  const suspended = useAppStore((s) => isSuspended(s.snapshot))
  const color = m.paused ? 'var(--color-slate-cool)' : m.watching && suspended ? NOT_JUDGED_COLOR : STAGE_COLOR[m.watching ? stage : 0]
  return <AppMark size={size} color={color} />
}

/**
 * The app icon in small: a dark rounded tile with the five-segment spine (same as the
 * installer / toast icon), in `color`.
 */
export function AppMark({ size = 28, color = 'var(--color-sage)' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden className="shrink-0">
      <rect x="0.5" y="0.5" width="27" height="27" rx="8" fill="var(--color-card-2)" stroke="rgb(255 255 255 / 0.08)" />
      {[6.2, 10.1, 14, 17.9, 21.8].map((cy) => (
        <circle key={cy} cx="14" cy={cy} r="1.9" fill={color} style={{ transition: 'fill 300ms ease-out' }} />
      ))}
    </svg>
  )
}

/** Worst live issue stage, only while watching (Live nav dot). */
function useLiveAlertStage(): Stage {
  const m = useMonitoring()
  const stage = useAppStore((s) => s.snapshot?.worstStage ?? 0)
  const suspended = useAppStore((s) => isSuspended(s.snapshot))
  return m.watching && !suspended ? stage : 0
}

interface NavItemProps {
  route: NavRoute
  active: boolean
  compact: boolean
  tabIndex: number
  onSelect: () => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void
  buttonRef: (el: HTMLButtonElement | null) => void
  badge: ReactNode
  /** compact rail: the badge becomes a 6 px dot */
  dot: string | null
}

function NavItem({ route, active, compact, tabIndex, onSelect, onKeyDown, buttonRef, badge, dot }: NavItemProps): JSX.Element {
  const meta = PLACE_META[route]
  const button = (
    <button
      ref={buttonRef}
      type="button"
      tabIndex={tabIndex}
      aria-current={active ? 'page' : undefined}
      aria-label={compact ? meta.label : undefined}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`titlebar-no-drag group relative flex items-center rounded-[10px] transition-colors duration-150 ${focusRing('surface')} ${
        compact ? 'h-11 w-11 justify-center' : 'h-10 w-full gap-3 px-3'
      } ${active ? 'bg-sage-soft' : 'hover:bg-white/[0.04]'}`}
    >
      {active && <span aria-hidden className={`absolute top-2.5 bottom-2.5 w-[3px] rounded-full bg-sage ${compact ? '-left-[10px]' : '-left-2'}`} />}
      <Icon name={meta.icon} size={20} className={active ? 'text-sage' : 'text-text-faint transition-colors duration-150 group-hover:text-text-dim'} />
      {!compact && (
        <span className={`type-nav ${active ? 'text-sage' : 'text-text-dim transition-colors duration-150 group-hover:text-text'}`}>{meta.label}</span>
      )}
      {!compact && badge && <span className="ml-auto">{badge}</span>}
      {compact && dot && <span aria-hidden className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dot }} />}
    </button>
  )
  return compact ? (
    <Tooltip content={meta.label} placement="right" delay={120}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}

function NavList({ compact }: { compact: boolean }): JSX.Element {
  const route = useAppStore((s) => s.route)
  const setRoute = useAppStore((s) => s.setRoute)
  const settings = useAppStore((s) => s.settings)
  const coachPending = useAppStore((s) => s.coachPending)
  const liveStage = useLiveAlertStage()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const noAi = settings !== null && !aiAvailable(settings)

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number): void => {
    const n = NAV_ROUTES.length
    let next: number | null = null
    if (e.key === 'ArrowDown') next = (i + 1) % n
    else if (e.key === 'ArrowUp') next = (i - 1 + n) % n
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    if (next === null) return
    e.preventDefault()
    refs.current[next]?.focus()
  }

  const activeIndex = Math.max(0, NAV_ROUTES.indexOf(route))
  return (
    <nav aria-label="Main" className={`flex flex-col gap-1 ${compact ? 'items-center px-0' : 'px-2'}`}>
      {NAV_ROUTES.map((r, i) => {
        let badge: ReactNode = null
        let dot: string | null = null
        if (r === 'coach') {
          if (coachPending && route !== 'coach') {
            badge = <StatusDot color="var(--color-sage)" pulse />
            dot = 'var(--color-sage)'
          } else if (noAi) {
            badge = (
              <span className="inline-flex h-[18px] items-center rounded-full bg-white/5 px-1.5 type-micro text-[10px] text-text-faint" title="No AI model connected">
                AI
              </span>
            )
          }
        } else if (r === 'live' && route !== 'live' && liveStage >= 2) {
          badge = <StatusDot color={STAGE_COLOR[liveStage]} />
          dot = STAGE_COLOR[liveStage]
        }
        return (
          <NavItem
            key={r}
            route={r}
            active={route === r}
            compact={compact}
            tabIndex={i === activeIndex ? 0 : -1}
            onSelect={() => setRoute(r)}
            onKeyDown={(e) => onKeyDown(e, i)}
            buttonRef={(el) => {
              refs.current[i] = el
            }}
            badge={badge}
            dot={dot}
          />
        )
      })}
    </nav>
  )
}

const PAUSE_ITEMS = (pause: (minutes: number | null) => void): MenuItem[] => [
  { label: '15 minutes', onClick: () => pause(15) },
  { label: '30 minutes', onClick: () => pause(30) },
  { label: '60 minutes', onClick: () => pause(60) },
  { label: 'Until I resume', onClick: () => pause(null) }
]

/** Sidebar footer pill (§2.3): monitoring / paused (countdown) / camera unavailable / not set up / new camera. */
function MonitoringPill({ compact }: { compact: boolean }): JSX.Element {
  const m = useMonitoring()
  const setRoute = useAppStore((s) => s.setRoute)
  const openSetup = useAppStore((s) => s.openSetup)
  const state = monitoringPillState(m)
  const now = useNow(1000, state === 'paused' && m.resumeAt !== null)
  const pause = (minutes: number | null): void => void window.sitsense.setPause(true, minutes)

  const dot =
    state === 'monitoring'
      ? 'var(--color-sage)'
      : state === 'paused'
        ? 'var(--color-slate-cool)'
        : state === 'camera'
          ? 'var(--color-coral)'
          : 'var(--color-amber)'
  const label =
    state === 'monitoring'
      ? 'Monitoring'
      : state === 'paused'
        ? m.resumeAt
          ? `Paused · ${fmtCountdown(m.resumeAt - now)}`
          : 'Paused'
        : state === 'camera'
          ? 'Camera unavailable'
          : state === 'mismatch'
            ? 'Nudges off · new camera'
            : 'Not set up'
  // camera trouble and a baseline for another camera are both sorted out on Live
  const opensLive = state === 'camera' || state === 'mismatch'

  if (compact) {
    const overlay = <StatusDot color={dot} pulse={state === 'monitoring'} size={7} className="absolute top-1.5 right-1.5 ring-2 ring-surface" />
    if (state === 'monitoring') {
      return (
        <Menu
          placement="right"
          ariaLabel="Pause for"
          items={PAUSE_ITEMS(pause)}
          trigger={<IconButton icon="pause" label={`${label} — pause`} size={40} variant="secondary" ringOn="surface" tooltipPlacement="right" overlay={overlay} />}
        />
      )
    }
    return (
      <IconButton
        icon={state === 'paused' ? 'play' : 'chevron-right'}
        label={state === 'paused' ? `${label} — resume` : opensLive ? `${label} — open Live` : `${label} — set up posture`}
        size={40}
        variant="secondary"
        ringOn="surface"
        tooltipPlacement="right"
        overlay={overlay}
        onClick={() => (state === 'paused' ? void window.sitsense.setPause(false) : opensLive ? setRoute('live') : openSetup())}
      />
    )
  }

  let action: ReactNode
  if (state === 'monitoring') {
    action = (
      <Menu
        placement="top"
        align="right"
        ariaLabel="Pause for"
        items={PAUSE_ITEMS(pause)}
        trigger={<IconButton icon="pause" label="Pause monitoring" size={28} ringOn="card" />}
      />
    )
  } else if (state === 'paused') {
    action = <IconButton icon="play" label="Resume" size={28} ringOn="card" onClick={() => void window.sitsense.setPause(false)} />
  } else if (opensLive) {
    action = <IconButton icon="chevron-right" label="Open Live" size={28} ringOn="card" onClick={() => setRoute('live')} />
  } else {
    action = <IconButton icon="chevron-right" label="Set up posture" size={28} ringOn="card" onClick={() => openSetup()} />
  }

  return (
    <div className="surface-card flex h-11 items-center gap-2.5 rounded-xl pr-2 pl-3" role="status" aria-live="polite">
      <StatusDot color={dot} pulse={state === 'monitoring'} />
      <span className="min-w-0 flex-1 truncate type-body text-text">
        {state === 'paused' && m.resumeAt ? (
          <>
            Paused <span className="text-text-faint">·</span> <span className="type-value text-text-dim">{fmtCountdown(m.resumeAt - now)}</span>
          </>
        ) : (
          label
        )}
      </span>
      {action}
    </div>
  )
}

/** "On-device" (· AI: label) — tooltip = the exact disclosure; click → Settings › Privacy & data. */
function PrivacyBadge({ compact }: { compact: boolean }): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const openSettings = useAppStore((s) => s.openSettings)
  const { ai, tip } = privacyNotice(settings)
  const aiLabel = ai ? (ai.label.length > 14 ? `${ai.label.slice(0, 13)}…` : ai.label) : null
  const text = aiLabel ? `On-device · AI: ${aiLabel}` : 'On-device'
  return (
    <Tooltip content={tip} placement={compact ? 'right' : 'top'} align={compact ? 'center' : 'start'}>
      <button
        type="button"
        aria-label={`Privacy: ${text}. Open Privacy & data`}
        onClick={() => openSettings('privacy')}
        className={`titlebar-no-drag flex h-8 items-center gap-2 rounded-lg text-text-dim transition-colors duration-150 hover:text-text ${focusRing('surface')} ${
          compact ? 'w-10 justify-center' : 'w-full px-2'
        }`}
      >
        <Icon name="shield" size={16} className={ai ? 'text-sage' : 'text-text-faint'} />
        {!compact && <span className="truncate type-caption">{text}</span>}
      </button>
    </Tooltip>
  )
}

/**
 * "Update ready" (§2.3 footer): shown only while a downloaded update waits for a restart.
 * One click restarts SitSense into the new version (main runs the installer silently).
 */
function UpdateReadyButton({ compact }: { compact: boolean }): JSX.Element | null {
  const ready = useAppStore((s) => (s.update?.state.kind === 'ready' ? s.update.state.version : null))
  const [busy, setBusy] = useState(false)
  if (!ready) return null
  const install = (): void => {
    setBusy(true)
    void window.sitsense
      .updateInstall()
      .catch(() => false)
      .then((ok) => {
        if (!ok) setBusy(false)
      })
  }
  const tip = `SitSense ${ready} is downloaded. Restart to install it — takes a few seconds.`
  if (compact) {
    return (
      <IconButton
        icon="refresh"
        label={`Update ${ready} ready — restart to update`}
        tooltip={tip}
        size={40}
        variant="secondary"
        ringOn="surface"
        tooltipPlacement="right"
        disabled={busy}
        overlay={<StatusDot color="var(--color-sage)" size={7} className="absolute top-1.5 right-1.5 ring-2 ring-surface" />}
        onClick={install}
      />
    )
  }
  return (
    <Tooltip content={tip} placement="top" align="start">
      <button
        type="button"
        onClick={install}
        disabled={busy}
        aria-label={`Update ${ready} ready. Restart to update`}
        className={`titlebar-no-drag flex h-9 w-full items-center gap-2 rounded-xl bg-sage-soft px-3 text-sage ring-1 ring-sage/20 transition-[filter,box-shadow] duration-150 enabled:hover:ring-sage/40 disabled:opacity-60 ${focusRing('surface')}`}
      >
        <Icon name="refresh" size={16} />
        <span className="min-w-0 flex-1 truncate text-left type-body font-medium">Update ready</span>
        <span className="shrink-0 type-caption">{busy ? 'Restarting…' : 'Restart'}</span>
      </button>
    </Tooltip>
  )
}

/** The running version, subtly (§2.3 footer) → Settings › About. A dot while a newer version waits. */
function VersionTag(): JSX.Element | null {
  const version = useAppStore((s) => s.appVersion)
  const openSettings = useAppStore((s) => s.openSettings)
  const available = useAppStore((s) => (s.update?.state.kind === 'available' ? s.update.state.version : null))
  if (!version) return null
  const tip = available ? `Version ${available} is available — open About` : `SitSense ${version} — About and updates`
  return (
    <Tooltip content={tip} placement="top" align="end">
      <button
        type="button"
        aria-label={tip}
        onClick={() => openSettings('about')}
        className={`titlebar-no-drag flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 type-caption text-text-faint transition-colors duration-150 hover:text-text-dim ${focusRing('surface')}`}
      >
        {available && <StatusDot color="var(--color-amber)" size={6} />}
        {shortVersion(version)}
      </button>
    </Tooltip>
  )
}

function Sidebar({ compact }: { compact: boolean }): JSX.Element {
  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-white/[0.05] bg-surface ${compact ? 'w-16' : 'w-[220px]'}`}
      aria-label="SitSense"
    >
      {/* brand row (draggable — the window title lives here) */}
      <div className={`titlebar-drag flex h-[52px] shrink-0 items-center gap-2.5 ${compact ? 'justify-center' : 'px-5'}`}>
        <BrandMark size={28} />
        {!compact && <span className="font-display text-[16px] leading-none font-semibold tracking-tight text-text">SitSense</span>}
      </div>
      <div className="mt-2 min-h-0 flex-1">
        <NavList compact={compact} />
      </div>
      <div className={`flex shrink-0 flex-col gap-1.5 p-3 ${compact ? 'items-center' : ''}`}>
        <UpdateReadyButton compact={compact} />
        <MonitoringPill compact={compact} />
        {compact ? (
          <PrivacyBadge compact />
        ) : (
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <PrivacyBadge compact={false} />
            </div>
            <VersionTag />
          </div>
        )}
      </div>
    </aside>
  )
}

// ───────────────────────────── top bar ─────────────────────────────

function TopBar({ title, onSlots }: { title: string; onSlots: (s: TopBarSlots) => void }): JSX.Element {
  const subRef = useRef<HTMLSpanElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    onSlots({ sub: subRef.current, actions: actionsRef.current })
  }, [onSlots])
  return (
    <header className="titlebar-drag flex h-11 shrink-0 items-center gap-3 bg-ink pl-6">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="shrink-0 type-title text-text">{title}</h1>
        <span ref={subRef} className="min-w-0 truncate type-caption text-text-faint" />
      </div>
      <div className="min-w-4 flex-1 self-stretch" />
      <div ref={actionsRef} className="titlebar-no-drag flex min-w-0 shrink items-center gap-1.5 empty:hidden" />
      <WindowControls />
    </header>
  )
}

// ───────────────────────────── keyboard ─────────────────────────────

/** The coach composer's textarea (screens/coach/Composer.tsx); null while absent or disabled. */
function coachComposer(): HTMLTextAreaElement | null {
  const el = document.getElementById(COACH_COMPOSER_ID)
  return el instanceof HTMLTextAreaElement && !el.disabled ? el : null
}

/**
 * Ctrl+1…4 places · Ctrl+, Settings · Ctrl+L ask the coach (opens Coach and focuses the
 * message box; on Coach itself CoachScreen's own listener handles it) · Ctrl+Shift+P
 * pause/resume (§2.3, §6.2 About).
 */
function useShellShortcuts(): void {
  useEffect(() => {
    let cancelFocus = (): void => undefined
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return
      const s = useAppStore.getState()
      if (s.setupFlow.open) return
      const n = Number(e.key)
      if (!e.shiftKey && n >= 1 && n <= NAV_ROUTES.length) {
        e.preventDefault()
        s.setRoute(NAV_ROUTES[n - 1])
      } else if (!e.shiftKey && e.key === ',') {
        e.preventDefault()
        s.openSettings()
      } else if (!e.shiftKey && (e.key === 'l' || e.key === 'L') && s.route !== 'coach') {
        e.preventDefault()
        s.setRoute('coach')
        // the composer mounts with the Coach screen a frame or two later
        cancelFocus()
        cancelFocus = focusWhenReady(coachComposer, 10)
      } else if (e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        void window.sitsense.setPause(!s.pause.paused, null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelFocus()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

// ───────────────────────────── shell ─────────────────────────────

export default function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const width = useWindowWidth()
  const compact = breakpointFor(width) === 'compact'
  const route = useAppStore((s) => s.route)
  const [slots, setSlots] = useState<TopBarSlots>({ sub: null, actions: null })
  useShellShortcuts()
  const fill = FILL_ROUTES.includes(route)
  const pad = compact ? 'p-4' : 'p-6'

  return (
    <div className="flex h-full bg-ink">
      <Sidebar compact={compact} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={PLACE_META[route].label} onSlots={setSlots} />
        <SlotsContext.Provider value={slots}>
          {/* stable gutter: the content width never depends on whether the page overflows, so
              width-measured layouts (Settings' category nav) can't loop with the scrollbar.
              Only on scrolling routes — on overflow:hidden it would reserve a useless strip. */}
          <main
            id="content"
            className={`min-h-0 flex-1 ${fill ? 'overflow-hidden' : 'overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]'}`}
          >
            <div
              key={route}
              className={`mx-0 flex w-full max-w-[1280px] flex-col ${pad} pt-2 ${fill ? 'h-full' : 'min-h-full'} motion-safe:animate-[screenIn_180ms_ease-out]`}
            >
              {children}
            </div>
          </main>
        </SlotsContext.Provider>
      </div>
    </div>
  )
}

// ───────────────────────────── setup frame ─────────────────────────────

export const SETUP_STEPS = ['Camera', 'Posture', 'Saved']

/**
 * The full-window posture-setup frame (§7.1): setup background with the sage glow, a
 * 56 px draggable header — [spine] Posture setup · stepper (setupFlow.step; Saved once the
 * session is done) · Exit setup · window controls — and the body. Esc / Exit leave setup
 * (closeSetup()); while capturing they ask first.
 */
export function SetupFrame({ children }: { children: ReactNode }): JSX.Element {
  const width = useWindowWidth()
  const compact = breakpointFor(width) === 'compact'
  const step = useAppStore((s) => s.setupFlow.step)
  const closeSetup = useAppStore((s) => s.closeSetup)
  const exitRef = useRef<HTMLButtonElement>(null)
  const [confirm, setConfirm] = useState(false)

  const requestExit = (): void => {
    if (useAppStore.getState().setup.phase === 'capturing') setConfirm(true)
    else closeSetup()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      if (useAppStore.getState().setup.phase === 'capturing') setConfirm(true)
      else useAppStore.getState().closeSetup()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="flex h-full flex-col bg-setup-bg motion-safe:animate-[setupIn_220ms_ease-out]"
      style={{ backgroundImage: 'radial-gradient(900px 520px at 72% -8%, rgb(147 201 162 / 0.10), transparent 62%)' }}
    >
      <header className="titlebar-drag grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 pl-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <AppMark size={26} />
          <span className="truncate type-title text-text">Posture setup</span>
        </div>
        <Stepper steps={SETUP_STEPS} current={step} compact={compact} />
        <div className="flex items-center justify-end gap-2">
          <button
            ref={exitRef}
            type="button"
            onClick={requestExit}
            className={`titlebar-no-drag inline-flex h-7 items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] font-medium text-text-dim transition-colors duration-150 hover:bg-white/[0.05] hover:text-text ${focusRing('setup')}`}
          >
            <Icon name="close" size={16} />
            Exit setup
          </button>
          <WindowControls />
        </div>
      </header>
      <ConfirmPopover
        open={confirm}
        onClose={() => setConfirm(false)}
        anchorRef={exitRef}
        message="Leave setup? Your posture hasn't been saved yet."
        confirmLabel="Leave"
        cancelLabel="Keep going"
        onConfirm={closeSetup}
      />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>
    </div>
  )
}
