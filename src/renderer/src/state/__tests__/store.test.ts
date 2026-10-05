import { beforeEach, describe, expect, it } from 'vitest'
import { CLOSED_SETUP_FLOW, resolveRoute, useAppStore } from '../store'

describe('resolveRoute', () => {
  it('maps legacy names and places', () => {
    expect(resolveRoute('dashboard')).toEqual({ route: 'live' })
    expect(resolveRoute('calibrate')).toEqual({ setup: true })
    expect(resolveRoute('settings')).toEqual({ route: 'settings' })
    expect(resolveRoute('coach')).toEqual({ route: 'coach' })
    expect(resolveRoute('history')).toEqual({ route: 'history' })
    expect(resolveRoute('bogus')).toEqual({ route: 'live' })
    expect(resolveRoute(undefined)).toEqual({ route: 'live' })
  })
})

describe('navigation store', () => {
  beforeEach(() => {
    useAppStore.setState({ route: 'live', setupFlow: CLOSED_SETUP_FLOW, settingsCategory: 'general', coachIntent: null })
  })

  it("'calibrate' opens setup over the current place and closeSetup returns there", () => {
    const s = useAppStore.getState()
    s.setRoute('history')
    s.setRoute('calibrate')
    expect(useAppStore.getState().setupFlow).toEqual({ open: true, returnTo: 'history', step: 1 })
    expect(useAppStore.getState().route).toBe('history')
    useAppStore.getState().closeSetup()
    expect(useAppStore.getState().setupFlow.open).toBe(false)
    expect(useAppStore.getState().route).toBe('history')
  })

  it("'dashboard' goes to Live and closes setup", () => {
    useAppStore.getState().openSetup('coach')
    useAppStore.getState().setRoute('dashboard')
    expect(useAppStore.getState().route).toBe('live')
    expect(useAppStore.getState().setupFlow.open).toBe(false)
  })

  it('openSetup is a no-op while open; setSetupStep only works while open', () => {
    const s = useAppStore.getState()
    s.setSetupStep(2)
    expect(useAppStore.getState().setupFlow.step).toBe(1)
    s.openSetup('live')
    s.setSetupStep(2)
    s.openSetup('settings')
    expect(useAppStore.getState().setupFlow).toEqual({ open: true, returnTo: 'live', step: 2 })
  })

  it('openSettings keeps the last category unless one is given', () => {
    const s = useAppStore.getState()
    s.openSettings('ai')
    expect(useAppStore.getState().route).toBe('settings')
    expect(useAppStore.getState().settingsCategory).toBe('ai')
    s.setRoute('live')
    s.openSettings()
    expect(useAppStore.getState().settingsCategory).toBe('ai')
  })

  it('hands questions and checks to Coach exactly once', () => {
    const s = useAppStore.getState()
    s.askCoach('   ')
    expect(useAppStore.getState().coachIntent).toBeNull()
    s.askCoach(' Why does my neck hurt? ')
    const intent = useAppStore.getState().coachIntent
    expect(intent).toMatchObject({ kind: 'ask', text: 'Why does my neck hurt?' })
    expect(useAppStore.getState().route).toBe('coach')
    useAppStore.getState().consumeCoachIntent(intent!.id + 1)
    expect(useAppStore.getState().coachIntent).not.toBeNull()
    useAppStore.getState().consumeCoachIntent(intent!.id)
    expect(useAppStore.getState().coachIntent).toBeNull()
    useAppStore.getState().checkPostureInCoach()
    expect(useAppStore.getState().coachIntent).toMatchObject({ kind: 'check' })
  })
})
