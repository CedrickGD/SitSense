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

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    if (useAppStore.getState().settings === null) routeFirstRun()
    subscribeSitting()
    subscribeUpdates()
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
