import { describe, expect, it } from 'vitest'
import type { IssueId, IssueSnapshot, PostureSnapshot, StatMinute } from '@shared/posture'
import type { Landmark } from '@renderer/posture/types'
import {
  backAngleText,
  bestGoodStretch,
  coachThread,
  dismissedForBaseline,
  GAUGE_GATE_COPY,
  distanceText,
  fmtLiveDuration,
  gaugeGate,
  gaugeModels,
  headText,
  hourTicks,
  lastAssistantText,
  lastExchange,
  offByIssue,
  leanText,
  pickBanner,
  poseTracking,
  previewText,
  sittingHeightText,
  sittingToday,
  sittingView,
  statusView,
  trackingLevel,
  TRACKING_COPY,
  worstIssue,
  type StatusInput
} from '../liveModel'

const issue = (id: IssueId, stage: 0 | 1 | 2 | 3 = 0, activeForMs: number | null = null): IssueSnapshot => ({
  issue: id,
  stage,
  activeForMs,
  metric: 0
})

const issues = (over: Partial<Record<IssueId, 0 | 1 | 2 | 3>> = {}): Record<IssueId, IssueSnapshot> => ({
  sink: issue('sink', over.sink ?? 0),
  headForward: issue('headForward', over.headForward ?? 0),
  lean: issue('lean', over.lean ?? 0),
  tooClose: issue('tooClose', over.tooClose ?? 0)
})

const base: StatusInput = {
  paused: false,
  running: true,
  cameraError: null,
  detectorError: null,
  calibrated: true,
  mismatch: false,
  snapshot: { presence: 'active', issues: issues() }
}

describe('statusView', () => {
  it('says Good with no issues', () => {
    expect(statusView(base)).toMatchObject({ kind: 'good', word: 'Good' })
  })
  it('names the worst issue', () => {
    const v = statusView({ ...base, snapshot: { presence: 'active', issues: issues({ lean: 1, sink: 2 }) } })
    expect(v).toMatchObject({ kind: 'issue', word: 'Slouching', worst: { issue: 'sink', stage: 2 } })
  })
  it('ties keep the ISSUES order', () => {
    expect(worstIssue(issues({ headForward: 2, sink: 2 }))).toEqual({ issue: 'sink', stage: 2 })
  })
  it('pause and camera trouble win over a frozen snapshot (audit)', () => {
    const bad = { presence: 'active' as const, issues: issues({ sink: 3 }) }
    expect(statusView({ ...base, paused: true, snapshot: bad }).word).toBe('Paused')
    expect(statusView({ ...base, cameraError: 'in-use', snapshot: bad }).word).toBe('Camera off')
    expect(statusView({ ...base, detectorError: 'model', snapshot: bad }).word).toBe('Camera off')
  })
  it('uses the saved settings for "not set up", not a missing frame', () => {
    expect(statusView({ ...base, calibrated: false }).word).toBe('Not set up')
    expect(statusView({ ...base, snapshot: null }).kind).toBe('starting')
    expect(statusView({ ...base, running: false }).kind).toBe('starting')
  })
  it('never says Good when nothing could be measured', () => {
    const empty = { view: 'front' as const, neckFwd: null, trunkFwd: null, drop: null, forward: null, lateral: null }
    expect(statusView({ ...base, snapshot: { presence: 'active', issues: issues(), readout: empty } })).toMatchObject({ kind: 'unseen', word: 'Not in view' })
    expect(gaugeGate('unseen')).toBe('waiting')
    // an active issue is still the detector's call
    expect(statusView({ ...base, snapshot: { presence: 'active', issues: issues({ sink: 1 }), readout: empty } }).kind).toBe('issue')
    expect(statusView({ ...base, snapshot: { presence: 'active', issues: issues(), readout: { ...empty, neckFwd: 2 } } }).kind).toBe('good')
  })
  it('away and mismatch', () => {
    expect(statusView({ ...base, snapshot: { presence: 'away', issues: issues({ sink: 2 }) } }).word).toBe('Away')
    expect(statusView({ ...base, mismatch: true }).kind).toBe('mismatch')
  })
  it('never says Good while the detectors are suspended (view-changed drift)', () => {
    // the engine forces every stage to 0 while suspended; the readout still shows the drift
    const r = { view: 'front' as const, neckFwd: 6, trunkFwd: 4, drop: 2, forward: 30, lateral: 1 }
    const v = statusView({ ...base, snapshot: { presence: 'active', issues: issues(), readout: r, suspended: true } })
    expect(v).toMatchObject({ kind: 'changed', word: 'View changed', worst: null })
    expect(gaugeGate('changed')).toBe('changed')
    expect(GAUGE_GATE_COPY.changed).toMatch(/redo setup/)
    // stronger states still win; detection resumed (suspended false) judges again
    expect(statusView({ ...base, paused: true, snapshot: { presence: 'active', issues: issues(), suspended: true } }).kind).toBe('paused')
    expect(statusView({ ...base, snapshot: { presence: 'away', issues: issues(), suspended: true } }).kind).toBe('away')
    expect(statusView({ ...base, snapshot: { presence: 'active', issues: issues(), readout: r, suspended: false } }).kind).toBe('good')
  })
  it('gauges show only while posture is judged', () => {
    expect(gaugeGate('good')).toBeNull()
    expect(gaugeGate('issue')).toBeNull()
    expect(gaugeGate('paused')).toBe('paused')
    expect(gaugeGate('away')).toBe('waiting')
    expect(gaugeGate('setup')).toBe('setup')
    expect(gaugeGate('restarting')).toBe('restarting')
    expect(gaugeGate('starting')).toBe('starting')
  })
})

describe('fmtLiveDuration', () => {
  it('formats a live issue timer', () => {
    expect(fmtLiveDuration(42_000)).toBe('42s')
    expect(fmtLiveDuration(130_000)).toBe('2m 10s')
    expect(fmtLiveDuration(65 * 60_000)).toBe('1h 05m')
    expect(fmtLiveDuration(null)).toBe('—')
    expect(fmtLiveDuration(-5)).toBe('—')
  })
})

describe('gauge value texts (§10.2)', () => {
  it('head', () => {
    expect(headText(4.4)).toBe('+4° forward')
    expect(headText(0.6)).toBe('level with baseline')
    expect(headText(-3.2)).toBe('3° back')
  })
  it('back / sitting height', () => {
    expect(backAngleText(6)).toBe('6° forward')
    expect(backAngleText(-4)).toBe('4° reclined')
    expect(backAngleText(0.3)).toBe('level')
    expect(sittingHeightText(3)).toBe('3 cm lower')
    expect(sittingHeightText(-2)).toBe('2 cm higher')
    expect(sittingHeightText(0.2)).toBe('same')
  })
  it('lean / distance', () => {
    expect(leanText(2)).toBe('2° to your left')
    expect(leanText(-5)).toBe('5° to your right')
    expect(leanText(0)).toBe('centered')
    expect(distanceText(5)).toBe('5 cm closer')
    expect(distanceText(-4)).toBe('4 cm farther')
    expect(distanceText(0.4)).toBe('same')
  })
})

describe('gaugeModels', () => {
  const readout = { view: 'front' as const, neckFwd: 4, trunkFwd: 6, drop: 2, forward: -4, lateral: 2 }
  it('always four rows in order', () => {
    expect(gaugeModels(readout).map((g) => g.label)).toEqual(['Head position', 'Back angle', 'Side lean', 'Screen distance'])
    expect(gaugeModels(null).map((g) => g.key)).toEqual(['head', 'back', 'lean', 'distance'])
  })
  it('divides the ticks by sensitivity', () => {
    const [head] = gaugeModels(readout, { headForward: 2 })
    expect(head.ticks).toEqual([5, 9, 14])
  })
  it('falls back to sitting height without a back angle', () => {
    const g = gaugeModels({ ...readout, trunkFwd: null })[1]
    expect(g).toMatchObject({ label: 'Sitting height', value: 2, valueText: '2 cm lower' })
  })
  it('marks unavailable values', () => {
    const g = gaugeModels({ ...readout, trunkFwd: null, drop: null, neckFwd: null })
    expect(g[0].value).toBeNull()
    expect(g[1]).toMatchObject({ label: 'Back angle', value: null })
    expect(g[1].unavailableReason).toMatch(/hips/)
  })
  it('side-lean zones follow the sub-metric the value came from', () => {
    // trunk (or unknown source): trunkLat stages
    expect(gaugeModels(readout)[2]).toMatchObject({ ticks: [6, 11, 18], range: [-20, 20] })
    expect(gaugeModels({ ...readout, lateralFrom: 'trunk' } as typeof readout)[2].ticks).toEqual([6, 11, 18])
    // hips not usable → neck tilt: neckLat stages, wider track so the 22° tick stays on it
    const neck = gaugeModels({ ...readout, lateral: 7, lateralFrom: 'neck' } as typeof readout)[2]
    expect(neck).toMatchObject({ ticks: [8, 14, 22], range: [-25, 25], valueText: '7° to your left' })
    expect(gaugeModels({ ...readout, lateralFrom: 'neck' } as typeof readout, { lean: 2 })[2].ticks).toEqual([4, 7, 11])
  })
  it('side lean reads like the mirrored preview (your left on the left)', () => {
    const lean = gaugeModels(readout)[2]
    expect(lean.value).toBe(-2)
    expect(lean.twoSided).toBe(true)
    expect(lean.valueText).toBe('2° to your left')
  })
})

describe('tracking chip (§3.2.1)', () => {
  const snap = (r: Partial<PostureSnapshot['readout'] & object> | undefined, extra: Partial<PostureSnapshot> = {}): Pick<PostureSnapshot, 'presence' | 'recalibrationSuggested' | 'readout'> => ({
    presence: 'active',
    recalibrationSuggested: false,
    readout: r ? { view: 'front', neckFwd: null, trunkFwd: null, drop: null, forward: null, lateral: null, ...r } : undefined,
    ...extra
  })
  it('reads the engine readout', () => {
    expect(trackingLevel(snap({ trunkFwd: 2, neckFwd: 1 }), null)).toBe('full')
    expect(trackingLevel(snap({ neckFwd: 1 }), null)).toBe('upper')
    expect(trackingLevel(snap({ neckFwd: 1 }, { recalibrationSuggested: true }), null)).toBe('changed')
    expect(trackingLevel(snap(undefined, { presence: 'away' }), null)).toBe('looking')
    expect(trackingLevel(null, null)).toBe('looking')
  })
  it('falls back to the raw pose before setup', () => {
    expect(trackingLevel(null, 'upper')).toBe('upper')
  })
  it('poseTracking from landmarks', () => {
    const seen: Landmark = { x: 0.5, y: 0.5, visibility: 0.99 }
    const hidden: Landmark = { x: 0.5, y: 0.5, visibility: 0 }
    const pose = Array.from({ length: 33 }, () => hidden)
    expect(poseTracking(pose)).toBeNull()
    pose[0] = seen
    pose[11] = seen
    expect(poseTracking(pose)).toBe('upper')
    pose[24] = seen
    expect(poseTracking(pose)).toBe('full')
    expect(poseTracking(null)).toBeNull()
  })
})

describe('Today helpers', () => {
  const mins = (states: StatMinute['s'][], start = 1000): StatMinute[] => states.map((s, i) => ({ m: start + i, s }))
  it('bestGoodStretch counts consecutive good minutes', () => {
    expect(bestGoodStretch(mins(['good', 'good', 'sink:1', 'good', 'good', 'good', 'away']))).toBe(3)
    expect(bestGoodStretch([])).toBe(0)
    // a gap in the log breaks the stretch
    expect(bestGoodStretch([{ m: 1, s: 'good' }, { m: 2, s: 'good' }, { m: 9, s: 'good' }])).toBe(2)
  })
  it('hourTicks only from 3 h, at full local hours', () => {
    expect(hourTicks(0, 120, 0)).toEqual([])
    // 08:30 → 11:29 (UTC, offset 0): ticks at 09:00, 10:00, 11:00
    const first = 8 * 60 + 30
    const ticks = hourTicks(first, first + 179, 0)
    expect(ticks.map((t) => Math.round(t * 180))).toEqual([30, 90, 150])
  })
})

describe('sittingView', () => {
  const now = 1_000_000_000
  const s = (over: object = {}) => ({ sittingMinutes: 38, sittingSince: now - 38 * 60_000, onBreak: false, breakSince: null, nextReminderAt: now + 12 * 60_000, breaksToday: 2, ...over })
  const on = { enabled: true, intervalMinutes: 50 }
  it('next break', () => {
    const v = sittingView(s(), on, now)
    expect(v).toMatchObject({ value: '38 min', line: 'Next break in 12 min', tone: 'sage', footer: '2 breaks today' })
    expect(v.progress).toBeCloseTo(0.76)
  })
  it('amber from 80 %, due at 100 %', () => {
    expect(sittingView(s({ sittingMinutes: 42, nextReminderAt: now + 8 * 60_000 }), on, now).tone).toBe('amber')
    const due = sittingView(s({ sittingMinutes: 55, nextReminderAt: now - 1 }), on, now)
    expect(due.tone).toBe('due')
    expect(due.line).toBe('Break due now — stand up for 3 minutes')
  })
  it('on a break after a minute away', () => {
    expect(sittingView(s({ onBreak: true, breakSince: now - 4 * 60_000 }), on, now).line).toBe('On a break · 4 min')
    expect(sittingView(s({ onBreak: true, breakSince: now - 20_000 }), on, now).line).toMatch(/^Next break/)
    // after the stretch ended: still on the same break, timed from main's breakSince
    const after = sittingView(s({ sittingMinutes: 0, sittingSince: null, nextReminderAt: null, onBreak: true, breakSince: now - 9 * 60_000 }), on, now)
    expect(after).toMatchObject({ value: '—', sittingNow: false, line: 'On a break · 9 min' })
  })
  it('nothing counts down before you sit', () => {
    const v = sittingView(s({ sittingMinutes: 0, sittingSince: null, nextReminderAt: null }), on, now)
    expect(v).toMatchObject({ value: '—', sittingNow: false, line: 'Starts when you sit down' })
  })
  it('breaks off and footers', () => {
    const off = sittingView(s({ breaksToday: 0 }), { enabled: false, intervalMinutes: 50 }, now)
    expect(off).toMatchObject({ line: 'Breaks are off', progress: null, offerTurnOn: true, footer: 'No breaks yet today' })
    expect(sittingView(s({ breaksToday: 1 }), on, now).footer).toBe('1 break today')
    expect(sittingView(null, on, now).value).toBe('—')
  })
})

describe('pickBanner (§3.7 priority)', () => {
  const none = {
    mismatch: false,
    recalibrationSuggested: false,
    recalibrateDismissed: false,
    unverified: false,
    unverifiedDismissed: false,
    usingFallback: false
  }
  it('one at a time, in order', () => {
    expect(pickBanner(none)).toBeNull()
    expect(pickBanner({ ...none, mismatch: true, unverified: true, usingFallback: true })).toBe('mismatch')
    expect(pickBanner({ ...none, recalibrationSuggested: true, unverified: true })).toBe('recalibrate')
    expect(pickBanner({ ...none, recalibrationSuggested: true, recalibrateDismissed: true, unverified: true })).toBe('unverified')
    expect(pickBanner({ ...none, unverified: true, unverifiedDismissed: true, usingFallback: true })).toBe('fallback')
  })
  it('a view-changed dismissal only holds for the baseline it was made for', () => {
    expect(dismissedForBaseline(null, 1000)).toBe(false)
    expect(dismissedForBaseline(1000, 1000)).toBe(true)
    // a new setup re-arms the banner
    expect(dismissedForBaseline(1000, 2000)).toBe(false)
    expect(dismissedForBaseline(1000, undefined)).toBe(false)
  })
})

describe('lastAssistantText', () => {
  it('takes the last real answer as plain text', () => {
    const msgs = [
      { role: 'assistant', kind: 'text', text: 'Your **neck** sits 4° ahead.\n- Tuck your chin' },
      { role: 'user', kind: 'text', text: 'why?' },
      { role: 'assistant', kind: 'error', text: 'Could not reach Gemini' }
    ]
    expect(lastAssistantText(msgs)).toBe('Your neck sits 4° ahead. Tuck your chin')
    expect(lastAssistantText([{ role: 'assistant', kind: 'check', text: '', review: { summary: 'Looks good.' } }])).toBe('Looks good.')
    expect(lastAssistantText([])).toBeNull()
    expect(lastAssistantText('nope')).toBeNull()
  })
})

describe('lastExchange', () => {
  const msgs = [
    { role: 'user', kind: 'text', text: 'Is my chair too low?' },
    { role: 'assistant', kind: 'text', text: 'A little — raise it **2 cm**.' },
    { role: 'user', kind: 'text', text: 'why?' },
    { role: 'assistant', kind: 'error', text: 'Could not reach Gemini' }
  ]
  it('pairs the last real answer with the question before it', () => {
    expect(lastExchange(msgs, false)).toEqual({ question: 'Is my chair too low?', answer: 'A little — raise it 2 cm.' })
    expect(lastExchange([{ role: 'assistant', kind: 'text', text: 'Hi there' }], false)).toEqual({ question: null, answer: 'Hi there' })
  })
  it('shows the pending question without an answer', () => {
    expect(lastExchange(msgs, true)).toEqual({ question: 'why?', answer: null })
  })
  it('is empty without messages', () => {
    expect(lastExchange([], false)).toEqual({ question: null, answer: null })
    expect(lastExchange('nope', true)).toEqual({ question: null, answer: null })
  })
})

describe('offByIssue', () => {
  it('counts off minutes per issue, most first, with the worst stage', () => {
    const mins = [
      { m: 1, s: 'good' },
      { m: 2, s: 'sink:1' },
      { m: 3, s: 'sink:3' },
      { m: 4, s: 'headForward:2' },
      { m: 5, s: 'away' },
      { m: 6, s: 'sink:1' }
    ] as const
    expect(offByIssue(mins)).toEqual([
      { issue: 'sink', minutes: 3, stage: 3 },
      { issue: 'headForward', minutes: 1, stage: 2 }
    ])
    expect(offByIssue([])).toEqual([])
  })
})

describe('tracking copy', () => {
  it('never ends in an ellipsis (in a chip that clips, it reads as truncated)', () => {
    for (const c of Object.values(TRACKING_COPY)) {
      expect(c.text).not.toMatch(/(…|\.\.\.)$/)
      expect(c.short).not.toMatch(/(…|\.\.\.)$/)
    }
  })
})

describe('previewText', () => {
  it('keeps list items and paragraphs on their own lines', () => {
    const md = 'Try **this**:\n\n1. Chin tucks\n2) Shoulder rolls\n- Stand _up_\n* Sit `back`\n\n> Breathe out.'
    expect(previewText(md)).toBe('Try this:\n1. Chin tucks\n2. Shoulder rolls\n• Stand up\n• Sit back\nBreathe out.')
  })
  it('drops heading markers, rules, code blocks and blank lines', () => {
    expect(previewText('## Tips\n---\n```\ncode\n```\nDone')).toBe('Tips\nDone')
    expect(previewText('  \n\n')).toBe('')
  })
})

describe('coachThread', () => {
  const msgs = [
    { role: 'user', kind: 'text', text: 'First?' },
    { role: 'assistant', kind: 'text', text: 'One\n- two' },
    { role: 'system', kind: 'note', text: 'Measurements updated' },
    { role: 'user', kind: 'check', text: 'Checked my posture' },
    { role: 'assistant', kind: 'check', text: '', review: { summary: 'Looks good.' } },
    { role: 'user', kind: 'text', text: 'And now?' },
    { role: 'assistant', kind: 'text', text: 'Sit **back**.\n1. Hips back' },
    { role: 'assistant', kind: 'error', text: 'Could not reach Gemini' }
  ]
  it('returns the last exchange with structured text and the rows before it', () => {
    expect(coachThread(msgs, false, 3)).toEqual({
      question: 'And now?',
      answer: 'Sit back.\n1. Hips back',
      earlier: [
        { role: 'assistant', text: 'One\n• two' },
        { role: 'user', text: 'Checked my posture' },
        { role: 'assistant', text: 'Looks good.' }
      ]
    })
    expect(coachThread(msgs, false, 0).earlier).toEqual([])
  })
  it('while pending: the question just asked, earlier rows before it', () => {
    const t = coachThread([...msgs, { role: 'user', kind: 'text', text: 'Why?' }], true, 1)
    expect(t).toEqual({ question: 'Why?', answer: null, earlier: [{ role: 'assistant', text: 'Sit back.\n1. Hips back' }] })
  })
  it('an answer without a question before it; junk input', () => {
    expect(coachThread([{ role: 'assistant', kind: 'text', text: 'Hi' }], false, 4)).toEqual({ question: null, answer: 'Hi', earlier: [] })
    expect(coachThread('nope', false, 4)).toEqual({ question: null, answer: null, earlier: [] })
  })
})

describe('sittingToday', () => {
  it('sums active minutes and finds the longest stretch between breaks', () => {
    const mins: StatMinute[] = []
    for (let m = 100; m < 130; m++) mins.push({ m, s: m % 7 === 0 ? 'sink:1' : 'good' })
    // a 1-minute absence does not end the stretch; 5 minutes away is a break
    mins.push({ m: 130, s: 'away' })
    for (let m = 131; m < 140; m++) mins.push({ m, s: 'good' })
    for (let m = 140; m < 145; m++) mins.push({ m, s: 'away' })
    for (let m = 145; m < 150; m++) mins.push({ m, s: 'good' })
    expect(sittingToday(mins)).toEqual({ satMinutes: 44, longestMinutes: 40 })
  })
  it('is zero without data', () => {
    expect(sittingToday([])).toEqual({ satMinutes: 0, longestMinutes: 0 })
    expect(sittingToday(null)).toEqual({ satMinutes: 0, longestMinutes: 0 })
    expect(sittingToday([{ m: 1, s: 'away' }])).toEqual({ satMinutes: 0, longestMinutes: 0 })
  })
})
