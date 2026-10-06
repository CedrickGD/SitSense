// Smoke-renders the Live screen in its main states (static markup, no DOM): catches
// runtime errors and checks the spec's copy (ui-v3.md §3, §10.2) lands on screen.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { IssueId, PostureSnapshot } from '@shared/posture'

const state: Record<string, unknown> = {}

vi.mock('@renderer/state/store', async () => {
  const actual = await vi.importActual<typeof import('@renderer/state/store')>('@renderer/state/store')
  const useAppStore = Object.assign((sel: (s: unknown) => unknown) => sel(state), { setState: () => undefined, getState: () => state })
  return { ...actual, useAppStore }
})
vi.mock('@renderer/detection/controller', () => ({ detectionController: { acquireMesh: () => () => undefined, getStream: () => null } }))
vi.mock('@renderer/screens/coach/coachStore', () => ({
  useCoachStore: (sel: (s: unknown) => unknown) => sel({ messages: (state.coachMessages as unknown[]) ?? [] })
}))
vi.mock('@renderer/components/MeshOverlay', () => ({ default: () => null }))

const { default: LiveScreen } = await import('../../LiveScreen')

const baseline = {
  version: 2,
  capturedAt: Date.now() - 2 * 86_400_000,
  cameraDeviceId: null,
  up: [0, -1, 0],
  upSource: 'body',
  forward: [0, 0, -1],
  view: { kind: 'angled', yawDeg: 30, elevationDeg: 0 },
  verified: true,
  neckFwd: 8,
  neckLat: 0,
  headPitch: 0,
  headRollRel: 0,
  shoulderTilt: 0,
  trunkFwd: 2,
  trunkLat: 0,
  torsoLen: 0.5,
  neckH: null,
  ppm: 1,
  anchor: [0, 0, 1]
}

const iss = (stages: Partial<Record<IssueId, 0 | 1 | 2 | 3>> = {}): PostureSnapshot['issues'] =>
  Object.fromEntries(
    (['sink', 'headForward', 'lean', 'tooClose'] as IssueId[]).map((id) => [
      id,
      { issue: id, stage: stages[id] ?? 0, activeForMs: stages[id] ? 130_000 : null, metric: 0 }
    ])
  ) as PostureSnapshot['issues']

const snapshot = (stages: Partial<Record<IssueId, 0 | 1 | 2 | 3>> = {}, presence: 'active' | 'away' = 'active'): PostureSnapshot => ({
  presence,
  issues: iss(stages),
  worstStage: 0,
  calibrated: true,
  recalibrationSuggested: false,
  readout: { view: 'angled', neckFwd: 4, trunkFwd: null, drop: 3, forward: 5, lateral: 2 },
  ts: Date.now()
})

function render(extra: Record<string, unknown> = {}, settingsPatch: Record<string, unknown> = {}): string {
  for (const k of Object.keys(state)) delete state[k]
  Object.assign(state, {
    settings: { ...DEFAULT_SETTINGS, calibration: baseline, ...settingsPatch },
    snapshot: snapshot(),
    detection: { running: true, delegate: 'GPU', targetFps: 10, measuredFps: 10, cameraError: null },
    detectorError: null,
    camera: { activeDeviceId: null, activeLabel: null, usingFallback: false },
    cameras: [],
    pause: { paused: false, resumeAt: null },
    baselineCameraMismatch: false,
    meshUnavailable: false,
    pose: null,
    today: { date: '2026-10-05', minutes: [], alerts: 0, breaks: 0 },
    sitting: { sittingMinutes: 38, sittingSince: Date.now() - 38 * 60_000, onBreak: false, breakSince: null, nextReminderAt: Date.now() + 12 * 60_000, breaksToday: 2 },
    route: 'live',
    coachPending: false,
    setRoute: () => undefined,
    openSetup: () => undefined,
    openSettings: () => undefined,
    askCoach: () => undefined,
    checkPostureInCoach: () => undefined,
    patchSettings: async () => undefined,
    ...extra
  })
  return renderToStaticMarkup(createElement(LiveScreen))
}

describe('LiveScreen', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('monitoring, good posture: score, gauges, cards', () => {
    const html = render()
    expect(html).toContain('Good')
    expect(html).toContain('Posture score 100 out of 100')
    expect(html).toContain('Head position')
    expect(html).toContain('+4° forward')
    // no back angle from this view → sitting height
    expect(html).toContain('Sitting height')
    expect(html).toContain('3 cm lower')
    expect(html).toContain('2° to your left')
    expect(html).toContain('5 cm closer')
    expect(html).toContain('Monitoring')
    expect(html).toContain('Seeing head &amp; shoulders')
    expect(html).toContain('Lines')
    expect(html).toContain('Hide preview (monitoring continues)')
    expect(html).toContain('Your day fills in here')
    expect(html).toContain('38 min')
    expect(html).toContain('Next break in 12 min')
    expect(html).toContain('2 breaks today')
  })

  it('an active issue shows its stage and duration', () => {
    const html = render({ snapshot: snapshot({ headForward: 2 }) })
    expect(html).toContain('Head forward')
    expect(html).toContain('clear')
    expect(html).toContain('for 2m 10s')
  })

  it('not set up: primary CTA, no gauges', () => {
    const html = render({ snapshot: null }, { calibration: null })
    expect(html).toContain('Not set up')
    expect(html).toContain('Set up your posture to see live measurements.')
    expect(html).toContain('Set up posture')
    expect(html).not.toContain('Head position')
    expect(html).toContain('Posture score unavailable')
  })

  it('paused: frozen snapshot is not shown as live (audit)', () => {
    const html = render({ snapshot: snapshot({ sink: 3 }), pause: { paused: true, resumeAt: null } })
    expect(html).toContain('Paused — gauges resume with monitoring.')
    expect(html).not.toContain('Slouching')
    expect(html).toContain('Posture score unavailable')
  })

  it('suspended detectors: no Good, no score, a redo-setup prompt (view-changed drift)', () => {
    // what the engine sends after 10 s far off the setup distance: every stage forced to 0
    const s = { ...snapshot(), recalibrationSuggested: true, suspended: true, readout: { view: 'angled' as const, neckFwd: 4, trunkFwd: null, drop: 3, forward: 30, lateral: 2 } }
    const html = render({ snapshot: s })
    expect(html).toContain('View changed')
    expect(html).not.toContain('>Good<')
    expect(html).not.toContain('aligned with your setup')
    expect(html).toContain('Posture score unavailable')
    expect(html).toContain('Your view changed a lot since setup — redo setup to measure again.')
    expect(html).toContain('Redo posture setup')
    // no gauge reading "30 cm closer" in a neutral color
    expect(html).not.toContain('30 cm closer')
  })

  it('away with a baseline for another camera does not promise monitoring resumes', () => {
    const html = render({ snapshot: snapshot({}, 'away'), baselineCameraMismatch: true })
    expect(html).toContain('Looks like you stepped away')
    expect(html).not.toContain('Monitoring resumes the moment')
    expect(html).toContain('Your saved posture is for another camera')
    // the ordinary away copy is unchanged
    expect(render({ snapshot: snapshot({}, 'away') })).toContain('Monitoring resumes the moment')
  })

  it('the dim mesh backdrop is its own setting: Mesh after Lines is still dimmed', () => {
    const dim = render({}, { overlay: { ...DEFAULT_SETTINGS.overlay, style: 'mesh', meshBackdrop: 'dim' } })
    expect(dim).toContain('hologram-scanlines')
    const plain = render({}, { overlay: { ...DEFAULT_SETTINGS.overlay, style: 'mesh', meshBackdrop: 'camera' } })
    expect(plain).not.toContain('hologram-scanlines')
    const lines = render({}, { overlay: { ...DEFAULT_SETTINGS.overlay, style: 'skeleton', meshBackdrop: 'dim' } })
    expect(lines).not.toContain('hologram-scanlines')
  })

  it('camera error shows the fix inside the frame', () => {
    const html = render({ detection: { running: false, delegate: null, targetFps: 10, measuredFps: 0, cameraError: 'in-use' } })
    expect(html).toContain('Your camera is busy')
    expect(html).toContain('Camera off')
  })

  it('hidden preview', () => {
    const html = render({}, { general: { ...DEFAULT_SETTINGS.general, hidePreview: true } })
    expect(html).toContain('Preview hidden — SitSense is still watching.')
    expect(html).toContain('Show preview')
  })

  it('banners: camera mismatch first, then unverified', () => {
    expect(render({ baselineCameraMismatch: true })).toContain('This posture was set up with a different camera.')
    const html = render({}, { calibration: { ...baseline, verified: false, trunkFwd: null } })
    expect(html).toContain('couldn&#x27;t check your back from this angle')
    expect(html).toContain('Connect an AI model for a second opinion')
    expect(html).toContain('Unverified baseline')
  })

  it('coach card without AI, AI off, and with a model', () => {
    expect(render()).toContain('Connect a model')
    const conn = { id: 'a', kind: 'gemini', label: 'Gemini', model: 'gemini-x', enabled: true, hasKey: true }
    const off = render({}, { ai: { ...DEFAULT_SETTINGS.ai, enabled: false, connections: [conn] } })
    expect(off).toContain('Your AI model is turned off.')
    const on = render({ coachMessages: [{ role: 'assistant', kind: 'text', text: 'Raise your **screen** a bit.' }] }, { ai: { ...DEFAULT_SETTINGS.ai, enabled: true, connections: [conn] } })
    expect(on).toContain('Ask your coach…')
    expect(on).toContain('Check my posture now')
    expect(on).toContain('Raise your screen a bit.')
    expect(on).toContain('on-device · AI: Gemini')
  })

  it('today with data', () => {
    const now = Math.floor(Date.now() / 60_000)
    const minutes = Array.from({ length: 30 }, (_, i) => ({ m: now - 30 + i, s: i < 20 ? 'good' : 'sink:1' }))
    const html = render({ today: { date: '2026-10-05', minutes, alerts: 3, breaks: 1 } })
    expect(html).toContain('67%')
    expect(html).toContain('20 min good · 10 min off')
    expect(html).toContain('Best stretch 20 min · 3 nudges')
  })
})
