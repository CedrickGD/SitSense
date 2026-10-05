// Posture setup — the focused full-window flow (docs/specs/ui-v3.md §7). It renders inside
// <SetupFrame> (header, stepper, Exit, Esc) and owns the three steps:
//   1 Camera  — what the camera can see; no session runs, nothing can be saved yet
//   2 Posture — the AI coach; saves by itself only once every essential check is verified
//   3 Saved   — what was stored and who verified it
// Leaving the flow cancels setup (the controller saves nothing unless it reached 'done').

import { useCallback, useEffect, useState, type JSX } from 'react'
import { detectionController } from '@renderer/detection/controller'
import { useBreakpoint } from '@renderer/lib/hooks'
import { useAppStore } from '@renderer/state/store'
import AiSheet from './AiSheet'
import { SETUP_KEYFRAMES } from './parts'
import StepCamera from './StepCamera'
import StepPosture from './StepPosture'
import StepSaved from './StepSaved'

/** a good AI verdict stays on screen this long before Saved (§7.5) */
const REVIEW_GOOD_HOLD_MS = 1200

export default function SetupFlow(): JSX.Element {
  const bp = useBreakpoint()
  const step = useAppStore((s) => s.setupFlow.step)
  const phase = useAppStore((s) => s.setup.phase)
  const reviewGood = useAppStore((s) => s.setup.reviewResult?.verdict === 'good')
  const [coachSince, setCoachSince] = useState<number | null>(null)
  const [aiOpen, setAiOpen] = useState(false)

  const redo = useCallback((): void => {
    detectionController.startSetup()
    useAppStore.getState().setSetupStep(1)
    setCoachSince(null)
  }, [])

  const start = useCallback((): void => {
    useAppStore.getState().setSetupStep(2)
    setCoachSince(Date.now())
    detectionController.beginSetupCoaching()
  }, [])

  // the flow opened: step 1 (camera check); closing it cancels setup
  useEffect(() => {
    redo()
    // the tray's "Redo posture setup" while Saved is showing: start over
    const off = window.sitsense.onRequestCalibration(() => {
      if (useAppStore.getState().setup.phase === 'done') redo()
    })
    return () => {
      off()
      detectionController.cancelSetup()
    }
  }, [redo])

  // the session saved: on to Saved (after a moment when the AI just said "Looks good")
  useEffect(() => {
    if (phase !== 'done' || step !== 2) return
    const t = setTimeout(() => useAppStore.getState().setSetupStep(3), reviewGood ? REVIEW_GOOD_HOLD_MS : 0)
    return () => clearTimeout(t)
  }, [phase, step, reviewGood])

  const openAi = useCallback(() => setAiOpen(true), [])
  const closeAi = useCallback(() => setAiOpen(false), [])

  return (
    <div data-setup-body className="h-full">
      <style>{SETUP_KEYFRAMES}</style>
      <div key={step} className="h-full motion-safe:animate-[screenIn_180ms_ease-out]">
        {step === 1 ? (
          <StepCamera bp={bp} onStart={start} onOpenAi={openAi} />
        ) : step === 2 ? (
          <StepPosture bp={bp} coachSince={coachSince} onOpenAi={openAi} />
        ) : (
          <StepSaved bp={bp} onRedo={redo} onOpenAi={openAi} />
        )}
      </div>
      {aiOpen && <AiSheet onClose={closeAi} />}
    </div>
  )
}
