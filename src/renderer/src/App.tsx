import { useEffect, useRef, type JSX } from 'react'
import { detectionController } from './detection/controller'
import { useAppStore } from './state/store'
import AppShell from './components/AppShell'
import CalibrationWizard from './screens/CalibrationWizard'
import Dashboard from './screens/Dashboard'
import SettingsScreen from './screens/SettingsScreen'

export default function App(): JSX.Element {
  const route = useAppStore((s) => s.route)
  const settings = useAppStore((s) => s.settings)
  const setRoute = useAppStore((s) => s.setRoute)
  const booted = useRef(false)

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void detectionController.init().then(() => {
      // first launch: no baseline yet → go straight to the wizard
      if (!useAppStore.getState().settings?.calibration) setRoute('calibrate')
    })
  }, [setRoute])

  return (
    <AppShell>
      {settings === null ? (
        <div className="flex h-full items-center justify-center text-text-faint">Starting…</div>
      ) : route === 'calibrate' ? (
        <CalibrationWizard />
      ) : route === 'settings' ? (
        <SettingsScreen />
      ) : (
        <Dashboard />
      )}
    </AppShell>
  )
}
