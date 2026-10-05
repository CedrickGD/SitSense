import { describe, expect, it } from 'vitest'
import { IDLE_SETUP, type BaselineSummary, type SetupUiState } from '@renderer/state/store'
import {
  CAMERA_STARTING_COPY,
  HOLD_STILL_COPY,
  SEARCHING_COPY,
  aiSetupState,
  baselineReadout,
  primaryCopy,
  progressKind,
  unverifiedCopy,
  aiHintCopy,
  backWarning,
  essentialsChecked,
  guideFocus,
  probeRows,
  rowKind,
  shortHint,
  splitInstruction,
  verificationBadge
} from '../copy'

const OK_ENV = { paused: false, cameraError: false, detectorError: null } as const
const ui = (p: Partial<SetupUiState>): SetupUiState => ({ ...IDLE_SETUP, ...p })
const summary = (p: Partial<BaselineSummary> = {}): BaselineSummary => ({
  view: 'side',
  verified: true,
  forced: false,
  neckFwdDeg: 9.2,
  trunkFwdDeg: 1.5,
  headPitchDeg: null,
  shoulderTiltDeg: 0.8,
  headRollDeg: null,
  trunkLatDeg: null,
  gravity: 'body',
  ...p
})

describe('primaryCopy', () => {
  it('uses the phase copy when the session has no instruction', () => {
    expect(primaryCopy(ui({ phase: 'searching' }), OK_ENV).text).toBe(SEARCHING_COPY)
    expect(primaryCopy(ui({ phase: 'holding' }), OK_ENV).text).toBe(HOLD_STILL_COPY)
    expect(primaryCopy(ui({ phase: 'capturing' }), OK_ENV).text).toBe(HOLD_STILL_COPY)
  })

  it("prefers the session's instruction", () => {
    const c = primaryCopy(ui({ phase: 'coaching', instruction: 'Sit back.' }), OK_ENV)
    expect(c).toEqual({ text: 'Sit back.', sub: null, tone: 'normal', attribution: null })
  })

  it("labels a reviewer's instruction with the model name", () => {
    const reviewResult = {
      label: 'Google Gemini',
      model: 'gemini-2.5-flash',
      verdict: 'adjust' as const,
      summary: 'Back is rounded.',
      instructions: ['Sit back against the chair.']
    }
    const c = primaryCopy(ui({ phase: 'coaching', instruction: 'Sit back against the chair.', reviewResult }), OK_ENV)
    expect(c.attribution).toBe('Suggested by Google Gemini')
    // the local judge's own instruction is not attributed to the model
    const local = primaryCopy(ui({ phase: 'coaching', instruction: 'Bring your head back.', reviewResult }), OK_ENV)
    expect(local.attribution).toBeNull()
  })

  it('shows failures as their own tone and says it recovers by itself', () => {
    const c = primaryCopy(ui({ phase: 'failed', failReason: 'lost', failMessage: 'We lost sight of you.' }), OK_ENV)
    expect(c.tone).toBe('fail')
    expect(c.text).toBe('We lost sight of you.')
    expect(c.sub).toMatch(/by itself/)
  })

  it('pausing, camera and model trouble block coaching but never the Done screen', () => {
    expect(primaryCopy(ui({ suspended: 'paused' }), OK_ENV).tone).toBe('blocked')
    expect(primaryCopy(ui({ phase: 'coaching' }), { ...OK_ENV, cameraError: true }).tone).toBe('blocked')
    expect(primaryCopy(ui({ phase: 'coaching' }), { ...OK_ENV, detectorError: 'model' }).tone).toBe('blocked')
    const done = primaryCopy(ui({ phase: 'done' }), { ...OK_ENV, paused: true })
    expect(done.text).toBe('This is your good posture.')
  })

  it('a failed save turns the Done headline into an error', () => {
    const c = primaryCopy(ui({ phase: 'done', saveError: "Couldn't save." }), OK_ENV)
    expect(c.tone).toBe('fail')
    // the controller's message already says "Couldn't save your posture" — don't repeat it
    expect(c.text).toBe("Couldn't save your posture.")
    expect(c.sub).toBe('Redo setup to try again.')
  })
})

describe('searching copy', () => {
  const notInView: SetupUiState['checks'] = [
    { id: 'inView', label: 'In view', status: 'adjust', instruction: 'Move so your head and at least one shoulder are in the picture.' },
    { id: 'trunkUpright', label: 'Upright back', status: 'unknown', instruction: null }
  ]
  it('says where to sit while nobody is in view, not the In view instruction', () => {
    const c = primaryCopy(ui({ phase: 'searching', instruction: notInView[0].instruction, checks: notInView }), OK_ENV)
    expect(c.text).toBe(SEARCHING_COPY)
  })
  it('says the camera is starting while no frames arrive', () => {
    const c = primaryCopy(ui({ phase: 'searching', checks: notInView }), { ...OK_ENV, running: false })
    expect(c.text).toBe(CAMERA_STARTING_COPY)
  })
})

describe('an essential the camera cannot check (§7.4.1)', () => {
  const unk = (instruction: string): SetupUiState['checks'] => [
    { id: 'inView', label: 'In view', status: 'good', instruction: null },
    { id: 'trunkUpright', label: 'Upright back', status: 'unknown', instruction },
    { id: 'headOverShoulders', label: 'Head over shoulders', status: 'good', instruction: null }
  ]
  const HIDDEN = "Sit tall against your backrest — your hips are hidden, so SitSense can't check your back from this camera."
  const FRONT = "Sit tall against your backrest — SitSense can't judge your back angle from straight in front."
  it('without an AI model, asks for a better camera view instead of "sit tall"', () => {
    const hips = primaryCopy(ui({ phase: 'coaching', instruction: HIDDEN, checks: unk(HIDDEN), view: 'angled' }), { ...OK_ENV, ai: 'none' })
    expect(hips.text).toBe("I can't see your hips from here.")
    expect(hips.sub).toMatch(/Tilt the camera down.*AI model/)
    const front = primaryCopy(ui({ phase: 'coaching', instruction: FRONT, checks: unk(FRONT), view: 'front' }), { ...OK_ENV, ai: 'off-in-setup' })
    expect(front.text).toBe("I can't judge your back angle from straight in front.")
    expect(front.sub).toMatch(/Turn the camera a little to the side/)
  })
  it('keeps "sit tall" when an AI model really judges it, and an actionable fix first', () => {
    expect(primaryCopy(ui({ phase: 'coaching', instruction: FRONT, checks: unk(FRONT), view: 'front' }), { ...OK_ENV, ai: 'on' }).text).toBe(FRONT)
    const withAdjust = [...unk(FRONT), { id: 'sideLean' as const, label: 'Centered weight', status: 'adjust' as const, instruction: 'x' }]
    expect(primaryCopy(ui({ phase: 'coaching', instruction: 'x', checks: withAdjust, view: 'front' }), { ...OK_ENV, ai: 'none' }).text).toBe('x')
  })
  it('on hold after rejections: names the model (its label, not the raw id) and the fix', () => {
    const reviewResult = { label: 'Google Gemini', model: 'gemini-x', verdict: 'adjust' as const, summary: 'Slumped.', instructions: ['Sit up tall.'] }
    const c = primaryCopy(ui({ phase: 'coaching', autoCapture: false, reviewResult, checks: unk('y').map((r) => ({ ...r, status: 'good' as const })) }), OK_ENV)
    expect(c).toEqual({ text: 'Google Gemini still sees a problem', sub: 'Sit up tall.', tone: 'normal', attribution: null })
  })
  it('while reviewing: a short "Stay like this." whatever the live instruction', () => {
    expect(primaryCopy(ui({ phase: 'reviewing', instruction: 'Sit back.' }), OK_ENV)).toMatchObject({ text: 'Stay like this.', sub: null })
  })
})

describe('aiSetupState', () => {
  const conn = { id: 'a', enabled: true } as never
  const s = (ai: Record<string, unknown>) => ({ ai: { enabled: true, useInSetup: true, connections: [conn], share: 'sketch', ...ai } }) as never
  it('tells a saved-but-switched-off model apart from none at all', () => {
    expect(aiSetupState(null)).toBe('none')
    expect(aiSetupState(s({ connections: [] }))).toBe('none')
    expect(aiSetupState(s({ enabled: false }))).toBe('turned-off')
    expect(aiSetupState(s({ connections: [{ id: 'a', enabled: false }] }))).toBe('turned-off')
    expect(aiSetupState(s({ useInSetup: false }))).toBe('off-in-setup')
    expect(aiSetupState(s({}))).toBe('on')
  })
})

describe('progressKind', () => {
  it('maps phases to the progress widget', () => {
    expect(progressKind(ui({ phase: 'holding' }))).toBe('hold')
    expect(progressKind(ui({ phase: 'capturing' }))).toBe('capture')
    expect(progressKind(ui({ phase: 'reviewing' }))).toBe('review')
    expect(progressKind(ui({ phase: 'coaching' }))).toBeNull()
  })
})

describe('baselineReadout', () => {
  it('reads like the spec example', () => {
    expect(baselineReadout(summary())).toBe('Neck 9° · Trunk upright · Shoulders level — seen from the side')
  })

  it('omits what was not measured and describes larger angles', () => {
    expect(baselineReadout(summary({ view: 'front', trunkFwdDeg: null, shoulderTiltDeg: 4.6, neckFwdDeg: -2.4 }))).toBe(
      'Neck −2° · Shoulders tilted 5° — seen from the front'
    )
    expect(baselineReadout(summary({ view: 'angled', trunkFwdDeg: -12, shoulderTiltDeg: null }))).toBe(
      'Neck 9° · Reclined 12° — seen at an angle'
    )
    expect(baselineReadout(summary({ trunkFwdDeg: 8.4, shoulderTiltDeg: null, neckFwdDeg: -0.3 }))).toBe(
      'Neck 0° · Trunk 8° forward — seen from the side'
    )
  })
})

describe('unverifiedCopy', () => {
  const unverified = summary({ verified: false })

  it('says nothing for verified or forced baselines', () => {
    expect(unverifiedCopy(summary(), ['trunkUpright'], 'none')).toBeNull()
    expect(unverifiedCopy(summary({ verified: false, forced: true }), ['trunkUpright'], 'none')).toBeNull()
    expect(unverifiedCopy(unverified, [], 'none')).toBeNull()
  })

  it('points to an AI model kindly when none is connected', () => {
    const c = unverifiedCopy(unverified, ['trunkUpright'], 'none')
    expect(c?.text).toMatch(/^From this angle SitSense can't check your back on its own — connect an AI model in Settings/)
    expect(c?.linkToSettings).toBe(true)
  })

  it('mentions the setup switch, or that the check did not run', () => {
    expect(unverifiedCopy(unverified, ['trunkUpright'], 'off-in-setup')?.text).toMatch(/Use during setup/)
    const off = unverifiedCopy(unverified, ['trunkUpright'], 'turned-off')
    expect(off?.text).toMatch(/Turn on your AI model in Settings → AI models/)
    expect(off?.text).not.toMatch(/connect an AI model/)
    const on = unverifiedCopy(unverified, ['trunkUpright', 'shouldersLevel'], 'on')
    expect(on?.text).toMatch(/your back and your shoulders/)
    expect(on?.linkToSettings).toBe(false)
  })
})

describe('splitInstruction', () => {
  it('splits a long instruction into an imperative and its reason', () => {
    expect(splitInstruction('Sit back — let your back rest against the chair.')).toEqual({
      head: 'Sit back',
      sub: 'Let your back rest against the chair.'
    })
    expect(splitInstruction("Slide your hips back and sit up tall — you're lying in the chair.")).toEqual({
      head: 'Slide your hips back and sit up tall',
      sub: "You're lying in the chair."
    })
  })
  it('keeps short or dash-less sentences and the hold copy whole', () => {
    expect(splitInstruction(HOLD_STILL_COPY)).toEqual({ head: HOLD_STILL_COPY, sub: null })
    const s = 'Bring your head back until your ears sit over your shoulders.'
    expect(splitInstruction(s)).toEqual({ head: s, sub: null })
  })
})

describe('checklist rows', () => {
  const c = (id: string, status: 'good' | 'adjust' | 'unknown', instruction: string | null = null) =>
    ({ id, label: id, status, instruction }) as SetupUiState['checks'][number]

  it('an unknown essential blocks ("can\'t check yet"); an unknown extra does not', () => {
    expect(rowKind(c('trunkUpright', 'unknown'), false)).toBe('unverified')
    expect(rowKind(c('headOverShoulders', 'unknown'), false)).toBe('unverified')
    expect(rowKind(c('gaze', 'unknown'), false)).toBe('na')
    expect(rowKind(c('sideLean', 'adjust'), false)).toBe('adjust')
    expect(rowKind(c('trunkUpright', 'good'), false)).toBe('good')
  })

  it('out of view only In view is judged', () => {
    expect(rowKind(c('inView', 'adjust'), true)).toBe('adjust')
    expect(rowKind(c('trunkUpright', 'unknown'), true)).toBe('pending')
  })

  it('short hints name the body part and direction', () => {
    expect(shortHint({ instruction: "Slide your hips back and sit up tall — you're lying in the chair." })).toBe('sit up tall')
    expect(shortHint({ instruction: 'Sit back — let your back rest against the chair.' })).toBe('sit back')
    expect(shortHint({ instruction: 'Bring your head back until your ears sit over your shoulders.' })).toBe('head back')
    expect(shortHint({ instruction: "You're leaning to your left — center your weight on both hips." })).toBe('center your weight')
  })

  it('counts verified essentials only', () => {
    expect(
      essentialsChecked([c('inView', 'good'), c('trunkUpright', 'unknown'), c('headOverShoulders', 'good'), c('gaze', 'good')])
    ).toEqual({ done: 2, total: 3 })
  })
})

describe('guideFocus', () => {
  const base = { phase: 'coaching' as const, checks: [] as SetupUiState['checks'] }
  const chk = (id: string, status: 'good' | 'adjust' | 'unknown', instruction: string | null = null) =>
    ({ id, label: id, status, instruction }) as SetupUiState['checks'][number]
  it('lying beats everything, then the first check to adjust', () => {
    expect(guideFocus(ui({ ...base, instruction: "Slide your hips back and sit up tall — you're lying in the chair." }))).toBe('lying')
    expect(guideFocus(ui({ ...base, checks: [chk('inView', 'good'), chk('trunkUpright', 'adjust', 'Sit back — x')] }))).toBe('back')
    expect(guideFocus(ui({ ...base, checks: [chk('inView', 'good'), chk('trunkUpright', 'adjust', "Sit up a little — x")] }))).toBe('recline')
    expect(guideFocus(ui({ ...base, checks: [chk('inView', 'good'), chk('headOverShoulders', 'adjust', 'Bring your head back.')] }))).toBe('head')
  })
  it('an unverifiable back points at the hips', () => {
    expect(guideFocus(ui({ ...base, checks: [chk('inView', 'good'), chk('trunkUpright', 'unknown')] }))).toBe('hips')
    expect(guideFocus(ui({ ...base, checks: [chk('inView', 'good'), chk('trunkUpright', 'good')] }))).toBeNull()
  })
})

describe('step 1 probe rows', () => {
  const p = { frames: true, inView: true, ready: true, view: 'side' as const, hips: 'seen' as const, backCheckable: true }
  it('reads the camera, you, your hips and the angle', () => {
    const rows = probeRows(p, { running: true, cameraError: null })
    expect(rows.map((r) => [r.id, r.tone, r.text])).toEqual([
      ['camera', 'good', 'Camera is on'],
      ['you', 'good', 'I can see you'],
      ['hips', 'good', 'I can see your hips — full tracking'],
      ['angle', 'info', 'Side view · works great']
    ])
  })
  it('warns when the hips are out of view or hidden, and before frames arrive', () => {
    expect(probeRows({ ...p, hips: 'out', backCheckable: false }, { running: true, cameraError: null })[2].tone).toBe('warn')
    expect(probeRows({ ...p, hips: 'hidden', backCheckable: false }, { running: true, cameraError: null })[2].text).toMatch(/hidden/)
    const idle = probeRows({ frames: false, inView: false, ready: false, view: null, hips: null, backCheckable: null }, { running: false, cameraError: null })
    expect(idle[0].text).toBe('Starting the camera…')
    expect(idle.slice(1).every((r) => r.tone === 'pending')).toBe(true)
  })
  it('the back warning appears only when the back cannot be confirmed', () => {
    expect(backWarning(p, 'none')).toBeNull()
    expect(backWarning({ ...p, hips: 'out', backCheckable: false }, 'none')).toMatch(/^Without your hips in view, .*connect an AI model for one/)
    expect(backWarning({ ...p, hips: 'out', backCheckable: false }, 'on')).not.toMatch(/connect an AI model/)
  })
})

describe('AI hint and verification badge', () => {
  it('offers the right action per AI state', () => {
    expect(aiHintCopy('none', null)?.action).toBe('Open AI settings')
    expect(aiHintCopy('off-in-setup', 'Google Gemini')?.text).toMatch(/Let Google Gemini double-check setup/)
    expect(aiHintCopy('on', 'x')).toBeNull()
  })
  it('says who verified the saved posture', () => {
    const r = { label: 'Gemini', model: 'm', verdict: 'good' as const, summary: 's', instructions: [] }
    expect(verificationBadge(ui({ baselineSummary: summary() }))?.text).toBe('Verified by on-device AI')
    expect(verificationBadge(ui({ baselineSummary: summary(), reviewResult: r }))?.text).toBe('Verified by on-device AI and Gemini')
    expect(verificationBadge(ui({ baselineSummary: summary(), reviewResult: r, unverifiedChecks: ['trunkUpright'] }))?.text).toBe('Verified by Gemini')
    expect(verificationBadge(ui({ baselineSummary: summary({ verified: false, forced: true }) }))).toEqual({
      tone: 'amber',
      text: 'Not verified — saved anyway'
    })
  })
})
