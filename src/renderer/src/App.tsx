import { useEffect, useRef, type JSX } from 'react'
import { isUpdateStatus } from '@shared/update'
import { detectionController } from './detection/controller'
import { useAppStore } from './state/store'
import AppShell, { SetupFrame } from './components/AppShell'
import SpineGlyph from './components/SpineGlyph'
import PostureSetup from './screens/PostureSetup'
import LiveScreen from './screens/LiveScreen'
import CoachScreen from './screens/CoachScreen'
import HistoryScreen from './screens/HistoryScreen'
import SettingsScreen from './screens/SettingsScreen'

/**
 * First run (no saved baseline) opens Posture setup — decided the moment settings
 * arrive, not after the camera and model finished starting (seconds later), and only
 * if nobody navigated anywhere in the meantime (the user, the tray, or a deep link).
 */
function routeFirstRun(): void {
  let navigated = false
  const unsubscribe = useAppStore.subscribe((s, prev) => {
    if (s.route !== prev.route || (s.setupFlow.open && !prev.setupFlow.open)) navigated = true
    if (!s.settings || prev.settings) return
    unsubscribe()
    if (!navigated && !s.setupFlow.open && !s.settings.calibration) s.openSetup('live')
  })
}

/** Keep the sitting / break state from main in the store (Live's Sitting card, History). */
function subscribeSitting(): void {
  const api = window.sitsense
  api
    .getAppStatus()
    .then((status) => {
      if (status.sitting) useAppStore.setState({ sitting: status.sitting })
    })
    .catch(() => {})
  api.onSittingChanged?.((sitting) => useAppStore.setState({ sitting }))
}

/** Keep main's update status in the store (Settings › About, the sidebar's "Restart to update"). */
function subscribeUpdates(): void {
  const api = window.sitsense
  const apply = (s: unknown): void => {
    // a malformed status (version skew) is ignored rather than rendered
    if (isUpdateStatus(s)) useAppStore.setState({ update: s })
  }
  api
    .updateGetState?.()
    .then(apply)
    .catch(() => {})
  api.onUpdateState?.(apply)
}

/**
 * The window's close button hides SitSense to the tray: that means "put it away", so an
 * open posture setup is left (SetupFlow's unmount cancels the session) and nudges resume.
 * A minimize keeps setup open.
 */
function subscribeClosedToTray(): void {
  window.sitsense.onWindowClosedToTray?.(() => useAppStore.getState().closeSetup())
}

/**
 * Ctrl+W hides to the tray and Ctrl+M minimizes, everywhere (setup included). The packaged
 * build has no application menu (main/window.ts), so the menu's own accelerators are gone.
 */
function useWindowShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.defaultPrevented || e.repeat) return
      const k = e.key.toLowerCase()
      if (k !== 'w' && k !== 'm') return
      e.preventDefault()
      void window.sitsense.windowControl(k === 'w' ? 'hide' : 'minimize').catch(() => undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** App boot (§8.5): a centered breathing glyph + "Starting SitSense…". */
function BootScreen(): JSX.Element {
  return (
    <div className="titlebar-drag flex h-full flex-col items-center justify-center gap-5 bg-ink" role="status">
      <SpineGlyph size={48} issue={null} stage={0} breathing />
      <p className="type-body text-text-dim">Starting SitSense…</p>
    </div>
  )
}

function Screen(): JSX.Element {
  const route = useAppStore((s) => s.route)
  switch (route) {
    case 'coach':
      return <CoachScreen />
    case 'history':
      return <HistoryScreen />
    case 'settings':
      return <SettingsScreen />
    default:
      return <LiveScreen />
  }
}

export default function App(): JSX.Element {
  const settingsLoaded = useAppStore((s) => s.settings !== null)
  const setupOpen = useAppStore((s) => s.setupFlow.open)
  const booted = useRef(false)
  useWindowShortcuts()

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    if (useAppStore.getState().settings === null) routeFirstRun()
    subscribeSitting()
    subscribeUpdates()
    subscribeClosedToTray()
    detectionController.init().catch((err) => console.error('[app] startup failed:', err))
  }, [])

  if (!settingsLoaded) return <BootScreen />
  if (setupOpen) {
    return (
      <SetupFrame>
        <PostureSetup />
      </SetupFrame>
    )
  }
  return (
    <AppShell>
      <Screen />
    </AppShell>
  )
}
