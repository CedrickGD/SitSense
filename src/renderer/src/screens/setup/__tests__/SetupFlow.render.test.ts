// Smoke-renders the posture-setup flow in every step and phase (static markup, no DOM):
// catches runtime errors and checks the spec's copy (ui-v3.md §7, §10.6) lands on screen.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupUiState } from '@renderer/state/store'
import type { SetupProbeState } from '@renderer/detection/setup-ui'

const state: Record<string, unknown> = {}
const probe: { current: SetupProbeState | null } = { current: null }

vi.mock('@renderer/state/store', async () => {
  const actual = await vi.importActual<typeof import('@renderer/state/store')>('@renderer/state/store')
  return { ...actual, useAppStore: (sel: (s: unknown) => unknown) => sel(state) }
})
vi.mock('@renderer/detection/setup-ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/detection/setup-ui')>('@renderer/detection/setup-ui')
  return {
    ...actual,
    useSetupProbe: (sel?: (s: SetupProbeState) => unknown) => {
      const s = probe.current ?? actual.IDLE_PROBE
      return sel ? sel(s) : s
    }
  }
})
vi.mock('@renderer/detection/controller', () => ({ detectionController: {} }))
vi.mock('@renderer/components/CameraFeed', () => ({ default: () => null }))
vi.mock('@renderer/components/AiModelsSection', () => ({ default: () => null }))

const { IDLE_SETUP } = await import('@renderer/state/store')
const { IDLE_PROBE } = await import('@renderer/detection/setup-ui')
const { default: SetupFlow } = await import('../SetupFlow')

const conn = { id: 'g', kind: 'gemini', label: 'Google Gemini', baseUrl: null, model: 'gemini-x', enabled: true, hasKey: true, keyHint: null, lastTest: null }
const AI_ON = { ai: { enabled: true, connections: [conn], useInSetup: true, share: 'sketch' } }
const AI_NONE = { ai: { enabled: false, connections: [], useInSetup: true, share: 'sketch' } }

function render(step: 1 | 2 | 3, setup: Partial<SetupUiState>, extra: Record<string, unknown> = {}): string {
  Object.assign(state, {
    setup: { ...IDLE_SETUP, ...setup },
    setupFlow: { open: true, returnTo: 'live', step },
    pause: { paused: false, resumeAt: null },
    detection: { running: true, delegate: 'GPU', targetFps: 10, measuredFps: 10, cameraError: null },
    detectorError: null,
    settings: { ...AI_NONE, calibration: null, cameraDeviceId: null },
    cameras: [],
    setRoute: () => undefined,
    patchSettings: async () => undefined,
    ...extra
  })
  return renderToStaticMarkup(createElement(SetupFlow))
}

const checks = (p: Partial<Record<string, SetupUiState['checks'][number]['status']>> = {}): SetupUiState['checks'] =>
  (
    [
      ['inView', 'In view'],
      ['trunkUpright', 'Upright back'],
      ['headOverShoulders', 'Head over shoulders'],
      ['sideLean', 'Centered weight'],
      ['shouldersLevel', 'Level shoulders'],
      ['headLevel', 'Level head'],
      ['gaze', 'Comfortable gaze']
    ] as const
  ).map(([id, label]) => ({
    id,
    label,
    status: p[id] ?? 'good',
    instruction:
      p[id] === 'adjust'
        ? id === 'trunkUpright'
          ? "Slide your hips back and sit up tall — you're lying in the chair."
          : 'Bring your head back until your ears sit over your shoulders.'
        : null
  }))

describe('SetupFlow', () => {
  beforeEach(() => {
    for (const k of Object.keys(state)) delete state[k]
    probe.current = null
  })

  describe('step 1 — camera', () => {
    it('asks to check the camera; Start coaching waits for the user to be in view', () => {
      const html = render(1, {})
      expect(html).toContain('Step 1 of 3')
      expect(html).toContain('Let’s check your camera.')
      expect(html).toContain('Any camera angle is fine')
      expect(html).toContain('Starting the camera…')
      expect(html).toMatch(/<button[^>]* aria-disabled="true"[^>]*>Start coaching/)
    })

    it('in view with hips: full tracking, Start coaching enabled', () => {
      probe.current = { ...IDLE_PROBE, frames: true, inView: true, ready: true, view: 'side', hips: 'seen', backCheckable: true }
      const html = render(1, {})
      expect(html).toContain('I can see you')
      expect(html).toContain('I can see your hips — full tracking')
      expect(html).toContain('Side view · works great')
      expect(html).not.toMatch(/<button[^>]* aria-disabled="true"[^>]*>Start coaching/)
      expect(html).toContain('Enter')
    })

    it('hips out of view: amber row and the AI second-opinion warning', () => {
      probe.current = { ...IDLE_PROBE, frames: true, inView: true, ready: true, view: 'front', hips: 'out', backCheckable: false }
      const html = render(1, {})
      expect(html).toContain('I can&#x27;t see your hips')
      expect(html).toContain('Tilt the camera down a little or sit a bit farther back.')
      expect(html).toContain('Without your hips in view, setup needs an AI second opinion')
      expect(html).toContain('connect an AI model for one')
      expect(html).toContain('>Connect an AI model<')
    })

    it('a redo says the saved posture is only replaced once confirmed', () => {
      const html = render(1, {}, { settings: { ...AI_NONE, calibration: { verified: true }, cameraDeviceId: null } })
      expect(html).toContain('Redoing setup replaces your saved posture once the new one is confirmed.')
    })

    it('paused: says so and offers Resume', () => {
      const html = render(1, { suspended: 'paused' }, { pause: { paused: true, resumeAt: null } })
      expect(html).toContain('Monitoring is paused.')
      expect(html).toContain('Resume monitoring')
    })
  })

  describe('step 2 — posture', () => {
    it('coaches with the big instruction split into head and reason, attributed to on-device AI', () => {
      const html = render(2, {
        phase: 'coaching',
        view: 'side',
        instruction: "Slide your hips back and sit up tall — you're lying in the chair.",
        checks: checks({ trunkUpright: 'adjust' })
      })
      expect(html).toContain('Step 2 of 3')
      expect(html).toContain('Slide your hips back and sit up tall')
      expect(html).toContain('You&#x27;re lying in the chair.')
      expect(html).toContain('Suggested by on-device AI')
      expect(html).toContain('sit up tall')
      expect(html).toMatch(/Essentials checked:.*>2<\/span> of <span[^>]*>3</)
      expect(html).toContain('Waiting for a good posture')
      expect(html).not.toMatch(/good enough|close enough|looks OK/i)
      expect(html).not.toContain('Save this posture anyway')
    })

    it('unverifiable essential without AI: "can\'t check yet", blocked progress and the AI hint card', () => {
      const html = render(2, {
        phase: 'coaching',
        view: 'front',
        needsVerification: true,
        instruction: "Sit tall against your backrest — your hips are hidden, so SitSense can't check your back from this camera.",
        checks: checks({ trunkUpright: 'unknown', gaze: 'unknown' })
      })
      expect(html).toContain('can&#x27;t check yet')
      expect(html).toContain('not visible from here')
      expect(html).toContain('Can’t confirm this from here yet')
      expect(html).toContain('I can&#x27;t see your hips from here')
      expect(html).toContain('Show the camera your hips, or let an AI model check your back.')
      expect(html).not.toContain('Follow the instruction above')
      expect(html).toContain('Want a second opinion? Connect an AI model')
      expect(html).toContain('Open AI settings')
      expect(html).toMatch(/Essentials checked:.*>2<\/span> of <span[^>]*>3</)
    })

    it('with a reviewer, the unverifiable rest is left to the model', () => {
      const html = render(
        2,
        { phase: 'coaching', checks: checks({ trunkUpright: 'unknown' }) },
        { settings: { ...AI_ON, calibration: null, cameraDeviceId: null } }
      )
      expect(html).toContain('Google Gemini double-checks the rest')
      expect(html).not.toContain('Want a second opinion?')
    })

    it('never shows "Save anyway" before 20 s, even when the session allows it', () => {
      const html = render(2, { phase: 'coaching', canForce: true, checks: checks({ trunkUpright: 'unknown' }) })
      expect(html).not.toContain('Save this posture anyway')
    })

    it('shows the hold and capture rings', () => {
      const hold = render(2, { phase: 'holding', holdProgress: 0.5, checks: checks() })
      expect(hold).toContain('Hold it…')
      expect(hold).toContain('That&#x27;s it — hold still.')
      const cap = render(2, { phase: 'capturing', captureProgress: 0.3, holdProgress: 1, checks: checks() })
      expect(cap).toContain('Capturing your posture…')
      expect(cap).toContain('aria-valuenow="30"')
    })

    it('reviewing: the second-opinion card with Skip (which doesn’t save an unverified capture)', () => {
      const html = render(2, {
        phase: 'reviewing',
        reviewing: { label: 'Google Gemini' },
        unverifiedChecks: ['trunkUpright'],
        checks: checks({ trunkUpright: 'unknown' })
      })
      expect(html).toContain('Second opinion')
      expect(html).toContain('Asking Google Gemini for a second opinion…')
      expect(html).toContain('Skip')
      expect(html).toContain('Skipping means this posture isn’t saved')
    })

    it('a rejection shows the Adjust card with numbered instructions, attributed', () => {
      const reviewResult = {
        label: 'Google Gemini',
        model: 'gemini-x',
        verdict: 'adjust' as const,
        summary: 'You are slumped.',
        instructions: ['Sit back against the chair.', 'Raise the screen.']
      }
      const html = render(2, { phase: 'coaching', instruction: 'Sit back against the chair.', reviewResult, reviewRejections: 1, checks: checks() })
      expect(html).toContain('Adjust')
      expect(html).toContain('“You are slumped.”')
      expect(html).toContain('Raise the screen.')
      expect(html).toContain('Suggested by Google Gemini')
    })

    it('rejected twice: the model still sees a problem, saving is on hold, Start over', () => {
      const reviewResult = { label: 'Google Gemini', model: 'gemini-x', verdict: 'adjust' as const, summary: 'Slumped.', instructions: ['Sit up tall.'] }
      const html = render(2, { phase: 'coaching', autoCapture: false, reviewResult, reviewRejections: 2, checks: checks() })
      expect(html).toContain('Google Gemini still sees a problem')
      expect(html).toContain('Sit up tall.')
      expect(html).not.toContain('gemini-x still sees')
      expect(html).toContain('Saving is on hold')
      expect(html).toContain('Start over')
    })

    it('failed: the amber fail message and that it recovers by itself', () => {
      const html = render(2, { phase: 'failed', failReason: 'unstable', failMessage: 'Hold still for a moment.', checks: checks() })
      expect(html).toContain('Hold still for a moment.')
      expect(html).toContain('setup picks up again by itself')
    })

    it('out of view: only In view is judged, the rest waits', () => {
      const away = checks({ inView: 'adjust', trunkUpright: 'unknown', headOverShoulders: 'unknown' })
      const html = render(2, { phase: 'searching', checks: away })
      expect(html).toContain('Sit where you normally work.')
      expect(html).not.toContain('can&#x27;t check yet')
      expect(html).toMatch(/Essentials checked:.*>0<\/span> of <span[^>]*>3</)
    })
  })

  describe('step 3 — saved', () => {
    const summary = {
      view: 'side' as const,
      verified: true,
      forced: false,
      neckFwdDeg: 9,
      trunkFwdDeg: 2,
      headPitchDeg: null,
      shoulderTiltDeg: 1,
      headRollDeg: null,
      trunkLatDeg: null,
      gravity: 'body' as const
    }

    it('readout, badge, reviewer quote, buttons and footnote', () => {
      const html = render(3, {
        phase: 'done',
        baselineSummary: summary,
        reviewResult: { label: 'Google Gemini', model: 'gemini-x', verdict: 'good', summary: 'Upright and relaxed.', instructions: [] }
      })
      expect(html).toContain('This is your good posture.')
      expect(html).toContain('Neck 9° · Trunk upright · Shoulders level — seen from the side')
      expect(html).toContain('Verified by on-device AI and Google Gemini')
      expect(html).toContain('“Upright and relaxed.”')
      expect(html).toContain('Start monitoring')
      expect(html).toContain('Redo setup')
      expect(html).toContain('Only these numbers are stored, on this device.')
    })

    it('a forced save is plainly marked unverified', () => {
      const html = render(3, { phase: 'done', forced: true, baselineSummary: { ...summary, verified: false, forced: true } })
      expect(html).toContain('Your posture is saved — unverified.')
      expect(html).not.toContain('This is your good posture.')
      expect(html).toContain('Not verified — saved anyway')
      expect(html).toContain('Your score will be marked unverified until you redo setup.')
    })

    it('a failed save offers Redo setup', () => {
      const html = render(3, { phase: 'done', saveError: 'x', baselineSummary: summary })
      expect(html).toContain('Couldn’t save your posture.')
      expect(html).toContain('Redo setup to try again.')
      expect(html).not.toContain('Start monitoring')
    })
  })
})
