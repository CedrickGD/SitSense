import { describe, expect, it } from 'vitest'
import { CHECK_IDS, CHECK_LABELS, INSTRUCTIONS, assessPosture } from '../assess'
import type { PostureFeatures } from '../types'

/** Neutral good posture, thigh gravity, frontal view; override what a test needs. */
function feat(over: Partial<PostureFeatures> = {}): PostureFeatures {
  return {
    good: true,
    vis: {
      head: true,
      nose: true,
      ears: 2,
      eyes: 2,
      shoulders: 2,
      hips: 2,
      knees: 2,
      seen: {
        nose: true,
        leftEar: true,
        rightEar: true,
        leftEyeOuter: true,
        rightEyeOuter: true,
        leftShoulder: true,
        rightShoulder: true,
        leftHip: true,
        rightHip: true,
        leftKnee: true,
        rightKnee: true
      }
    },
    up: [0, -1, 0],
    upSource: 'body',
    left: [1, 0, 0],
    forward: [0, 0, -1],
    view: { yawDeg: 5, elevationDeg: 10, kind: 'front', opticalYawDeg: 5 },
    nearSide: 'left',
    neckFwd: 2,
    neckLat: 0,
    neckLatRef: 'trunk',
    lateralAxis: 'hips',
    headPitch: 14,
    headYaw: 0,
    earsBoth: true,
    headRollRel: 0,
    shoulderTilt: 0,
    trunkFwd: 0,
    trunkLat: 0,
    torsoLen: 0.48,
    ppm: 0.6,
    anchor: [0, -0.1, 1.2],
    head: [0, -0.25, 1.2],
    neckH: 0.15,
    labelsSwapped: false,
    ...over
  }
}

describe('assessPosture — vocabulary', () => {
  it('exports stable check ids in priority order with labels', () => {
    expect(CHECK_IDS).toEqual(['inView', 'trunkUpright', 'headOverShoulders', 'sideLean', 'shouldersLevel', 'headLevel', 'gaze'])
    for (const id of CHECK_IDS) expect(CHECK_LABELS[id]).toMatch(/\S/)
    const a = assessPosture(feat())
    expect(a.checks.map((c) => c.id)).toEqual([...CHECK_IDS])
    expect(Object.keys(a.byId).sort()).toEqual([...CHECK_IDS].sort())
  })
})

describe('assessPosture — verdicts', () => {
  it('not in view: only inView adjusts, everything else unknown', () => {
    const a = assessPosture(null)
    expect(a.allGood).toBe(false)
    expect(a.primary?.id).toBe('inView')
    expect(a.primary?.instruction).toBe(INSTRUCTIONS.inView)
    expect(a.checks.filter((c) => c.id !== 'inView').every((c) => c.status === 'unknown')).toBe(true)
  })

  it('good posture is allGood with no primary instruction', () => {
    const a = assessPosture(feat())
    expect(a.allGood).toBe(true)
    expect(a.primary).toBeNull()
    expect(a.checks.every((c) => c.status === 'good')).toBe(true)
    expect(a.gravity).toBe('strong')
  })

  it.each([
    ['leaning forward', { trunkFwd: 20 }, 'trunkUpright', INSTRUCTIONS.trunkForward, 'forward'],
    // past the −25° limit with the head going along (looking up): leaning far back
    ['reclined far back', { trunkFwd: -28, neckFwd: -26, headPitch: -12 }, 'trunkUpright', INSTRUCTIONS.trunkBack, 'back'],
    // past −32°: lying in the chair
    ['lying far back', { trunkFwd: -40, neckFwd: -38, headPitch: -12 }, 'trunkUpright', INSTRUCTIONS.lying, 'back'],
    ['head forward', { neckFwd: 28 }, 'headOverShoulders', INSTRUCTIONS.headForward, 'forward'],
    ['leaning left', { trunkLat: 9 }, 'sideLean', INSTRUCTIONS.sideLean('left'), 'left'],
    ['leaning right', { trunkLat: -9 }, 'sideLean', INSTRUCTIONS.sideLean('right'), 'right'],
    ['left shoulder up', { shoulderTilt: 8 }, 'shouldersLevel', INSTRUCTIONS.shoulderRaised('left'), 'left'],
    ['right shoulder up', { shoulderTilt: -8 }, 'shouldersLevel', INSTRUCTIONS.shoulderRaised('right'), 'right'],
    // + = left ear higher = head tilted toward the right
    ['head tilted right', { headRollRel: 10 }, 'headLevel', INSTRUCTIONS.headTilt('right'), 'right'],
    ['head tilted left', { headRollRel: -10 }, 'headLevel', INSTRUCTIONS.headTilt('left'), 'left'],
    ['looking down', { headPitch: 40 }, 'gaze', INSTRUCTIONS.gazeDown, 'down'],
    ['chin up', { headPitch: -20 }, 'gaze', INSTRUCTIONS.gazeUp, 'up']
  ] as const)('%s → %s', (_n, over, id, instruction, direction) => {
    const a = assessPosture(feat(over))
    expect(a.byId[id]).toMatchObject({ status: 'adjust', instruction, direction })
    expect(a.allGood).toBe(false)
    expect(a.primary?.id).toBe(id)
  })

  it('instructions name the person’s own side and are concrete sentences', () => {
    expect(INSTRUCTIONS.sideLean('left')).toBe("You're leaning to your left — center your weight on both hips.")
    expect(INSTRUCTIONS.shoulderRaised('right')).toBe('Your right shoulder is raised — let it drop and relax.')
    expect(INSTRUCTIONS.headTilt('left')).toBe("Straighten your head — it's tilted toward your left.")
  })

  it('the primary instruction follows the priority order', () => {
    const a = assessPosture(feat({ headPitch: 45, trunkLat: 10, neckFwd: 30, trunkFwd: 20 }))
    expect(a.checks.filter((c) => c.status === 'adjust').map((c) => c.id)).toEqual([
      'trunkUpright',
      'headOverShoulders',
      'sideLean',
      'gaze'
    ])
    expect(a.primary?.id).toBe('trunkUpright')
  })

  it('unmeasurable features are unknown; only the essential ones keep the posture from being verified', () => {
    const a = assessPosture(
      feat({ trunkFwd: null, trunkLat: null, shoulderTilt: null, headRollRel: null, headPitch: null, torsoLen: null })
    )
    for (const id of ['trunkUpright', 'sideLean', 'shouldersLevel', 'headLevel', 'gaze'] as const) {
      expect(a.byId[id].status).toBe('unknown')
      expect(a.byId[id].reason).toMatch(/\S/)
    }
    // nothing to adjust…
    expect(a.allGood).toBe(true)
    expect(a.primary).toBeNull()
    // …but an unseen trunk lean means the posture is not verified, and the judge says how to fix that
    expect(a.unverified).toEqual(['trunkUpright'])
    expect(a.verified).toBe(false)
    expect(a.viewInstruction).toBe(INSTRUCTIONS.showHips)
    expect(a.byId.trunkUpright.viewInstruction).toBe(INSTRUCTIONS.showHips)
  })

  it('a good posture with everything measurable is verified', () => {
    const a = assessPosture(feat())
    expect(a).toMatchObject({ allGood: true, verified: true, unverified: [], viewInstruction: null })
    expect(a.byId.trunkUpright.basis).toBe('absolute')
  })
})

describe('assessPosture — the head on the trunk (gravity-free)', () => {
  const weak = { upSource: 'hips' as const }

  it('lying in the chair: the head tips far forward on the trunk — flagged even where the trunk lean is unknown', () => {
    // weak gravity, frontal: the absolute trunk reading (here 10°) means nothing, the head on the trunk does
    const a = assessPosture(feat({ ...weak, trunkFwd: 10, neckFwd: 40, headPitch: 62 }))
    expect(a.byId.trunkUpright).toMatchObject({ status: 'adjust', instruction: INSTRUCTIONS.lying, direction: 'back', basis: 'relative' })
    expect(a.primary?.id).toBe('trunkUpright')
    expect(a.headOnTrunk).toEqual({ neck: 30, gaze: 52 })
  })

  it('prefers the gravity-free features over the differences of gravity-referenced angles', () => {
    // the gravity-referenced angles look fine; the body-relative ones show the lying posture
    const a = assessPosture(feat({ ...weak, trunkFwd: 0, neckFwd: 2, headPitch: 14, neckOnTrunk: 30, headOnTrunk: 50 }))
    expect(a.byId.trunkUpright).toMatchObject({ status: 'adjust', instruction: INSTRUCTIONS.lying, basis: 'relative' })
    expect(a.headOnTrunk).toEqual({ neck: 30, gaze: 50 })
    // (without a known trunk lean it takes a clearly tipped head: 45° on the trunk is not enough)
    expect(assessPosture(feat({ ...weak, neckOnTrunk: 30, headOnTrunk: 45 })).byId.trunkUpright.status).toBe('unknown')
  })

  it('a plain look down (neck straight on the trunk) is a gaze matter, not lying', () => {
    const a = assessPosture(feat({ ...weak, trunkFwd: 0, neckFwd: 5, headPitch: 48 }))
    expect(a.byId.trunkUpright.status).toBe('unknown')
    expect(a.byId.gaze).toMatchObject({ status: 'adjust', instruction: INSTRUCTIONS.gazeDown })
  })

  it('with a known trunk lean, lying needs a trunk reclined past the comfortable range', () => {
    // thigh gravity: reclined 22° with the head tipped forward on it → lying
    expect(assessPosture(feat({ trunkFwd: -22, neckFwd: 0, headPitch: 20 })).byId.trunkUpright).toMatchObject({
      status: 'adjust',
      instruction: INSTRUCTIONS.lying
    })
    // reclined 12° looking down at the keyboard: not lying (the gaze check handles the look down)
    const a = assessPosture(feat({ trunkFwd: -12, neckFwd: 4, headPitch: 30 }))
    expect(a.byId.trunkUpright.status).toBe('good')
  })

  it('leaning in: the head tips back on the trunk to see the screen', () => {
    const a = assessPosture(feat({ ...weak, trunkFwd: 25, neckFwd: 25, headPitch: 12 }))
    expect(a.byId.trunkUpright).toMatchObject({ status: 'adjust', instruction: INSTRUCTIONS.trunkForward, direction: 'forward', basis: 'relative' })
  })

  it('the neck on the trunk decides the head check only where its absolute angle is unknown', () => {
    // sitting back 15° with the head stacked flexes the neck on the trunk; against gravity the
    // ears sit over the shoulders: fine where gravity is known (thighs)…
    const reclined = { trunkFwd: -15, neckFwd: 15, neckOnTrunk: 30, headOnTrunk: 30, headPitch: 15 }
    expect(assessPosture(feat(reclined)).byId.headOverShoulders).toMatchObject({ status: 'good', basis: 'absolute' })
    // …while without a gravity reference the neck on the trunk is all there is
    expect(assessPosture(feat({ ...reclined, upSource: 'hips' })).byId.headOverShoulders).toMatchObject({
      status: 'adjust',
      instruction: INSTRUCTIONS.headForward,
      basis: 'relative'
    })
  })

  it('an upright trunk reading with the head tipped back on it is not confirmed (the cues disagree)', () => {
    // e.g. hips predicted under a desk make a forward-leaning trunk read upright
    const a = assessPosture(feat({ trunkFwd: 3, neckFwd: 5, headPitch: 9, headOnTrunk: -4, neckOnTrunk: 2 }))
    expect(a.byId.trunkUpright.status).toBe('unknown')
    expect(a.unverified).toEqual(['trunkUpright'])
    expect(a.viewInstruction).toBe(INSTRUCTIONS.sitBackLookAhead)
    // looking straight ahead (the ear→nose line's own droop, ~14°) is fine
    expect(assessPosture(feat({ trunkFwd: 3, neckFwd: 5, headPitch: 9, headOnTrunk: 12, neckOnTrunk: 2 })).verified).toBe(true)
  })

  it('without a hip in view and without a gravity reference the head is not verified either', () => {
    const f = feat({ upSource: 'camera', trunkFwd: null, trunkLat: null, torsoLen: null, neckOnTrunk: null, headOnTrunk: null })
    const a = assessPosture(f)
    expect(a.byId.headOverShoulders.status).toBe('unknown')
    expect(a.unverified).toEqual(['trunkUpright', 'headOverShoulders'])
    expect(a.verified).toBe(false)
    expect(a.viewInstruction).toBe(INSTRUCTIONS.showHips)
  })

  it('in a frontal view with the hips but no thigh gravity, the back angle is what cannot be verified', () => {
    const a = assessPosture(feat({ ...weak }))
    expect(a.allGood).toBe(true)
    expect(a.verified).toBe(false)
    expect(a.unverified).toEqual(['trunkUpright'])
    expect(a.viewInstruction).toBe(INSTRUCTIONS.backFromFront)
    // the head is verified on the trunk
    expect(a.byId.headOverShoulders).toMatchObject({ status: 'good', basis: 'relative' })
  })
})

describe('assessPosture — gravity confidence', () => {
  it('thigh gravity allows for the thigh slope (×1.3: 15.6° trunk, 26° neck)', () => {
    // (the head goes along with the trunk, as with thighs that slope: the head on the trunk stays as when upright)
    expect(assessPosture(feat({ trunkFwd: 15, headPitch: 29 })).byId.trunkUpright.status).toBe('good')
    expect(assessPosture(feat({ trunkFwd: 17, headPitch: 31 })).byId.trunkUpright.status).toBe('adjust')
    expect(assessPosture(feat({ neckFwd: 25 })).byId.headOverShoulders.status).toBe('good')
    expect(assessPosture(feat({ neckFwd: 27 })).byId.headOverShoulders.status).toBe('adjust')
    expect(assessPosture(feat()).unverified).toEqual([])
  })

  it('without thigh gravity in a frontal view the trunk is not judged and the head is judged relative to the trunk', () => {
    // camera tilt adds the same bias to trunk and neck: 30° each here
    const a = assessPosture(feat({ upSource: 'hips', trunkFwd: 30, neckFwd: 32, headPitch: 44 }))
    expect(a.gravity).toBe('weak')
    expect(a.headRelativeToTrunk).toBe(true)
    expect(a.byId.trunkUpright.status).toBe('unknown')
    // measured but not judgeable here: a setup relying on it is not verified locally
    expect(a.unverified).toEqual(['trunkUpright'])
    expect(a.byId.headOverShoulders).toMatchObject({ status: 'good', value: 2 })
    expect(a.byId.gaze).toMatchObject({ status: 'good', value: 14 })
    // but a head that is far ahead of the trunk is still caught
    expect(assessPosture(feat({ upSource: 'hips', trunkFwd: 30, neckFwd: 60 })).byId.headOverShoulders.status).toBe('adjust')
  })

  it('a near-profile view judges the trunk even without thigh gravity (tolerance ×1.3)', () => {
    const side = { upSource: 'camera' as const, view: { yawDeg: 85, elevationDeg: 0, kind: 'side' as const, opticalYawDeg: 85 } }
    expect(assessPosture(feat({ ...side, trunkFwd: 15, headPitch: 29 })).byId.trunkUpright.status).toBe('good')
    expect(assessPosture(feat({ ...side, trunkFwd: 17, headPitch: 31 })).byId.trunkUpright.status).toBe('adjust')
  })

  it('camera-only gravity without a visible trunk: only a neck past any plausible camera tilt (×1.6) is called out', () => {
    const f = { upSource: 'camera' as const, trunkFwd: null, trunkLat: null, torsoLen: null }
    // within the widened tolerance it cannot be verified (the camera's tilt is in the reading)
    const ok = assessPosture(feat({ ...f, neckFwd: 30 }))
    expect(ok.byId.headOverShoulders.status).toBe('unknown')
    expect(ok.unverified).toContain('headOverShoulders')
    expect(assessPosture(feat({ ...f, neckFwd: 34 })).byId.headOverShoulders).toMatchObject({ status: 'adjust', basis: 'estimate' })
  })

  it('camera-only gravity cannot judge shoulder level (camera roll is unknown)', () => {
    const a = assessPosture(feat({ upSource: 'camera', shoulderTilt: 12 }))
    expect(a.byId.shouldersLevel.status).toBe('unknown')
  })

  it('a horizontal the hips do not confirm (levelUnconfirmed) cannot judge shoulder level either', () => {
    for (const upSource of ['body', 'hips'] as const) {
      expect(assessPosture(feat({ upSource, shoulderTilt: 12 })).byId.shouldersLevel.status).toBe('adjust')
      const a = assessPosture(feat({ upSource, shoulderTilt: 12 }), undefined, { levelUnconfirmed: true })
      expect(a.byId.shouldersLevel.status).toBe('unknown')
      // every other check is unaffected (the body-relative lateral ones included)
      expect(assessPosture(feat({ upSource, trunkLat: 9 }), undefined, { levelUnconfirmed: true }).byId.sideLean.status).toBe('adjust')
      expect(assessPosture(feat({ upSource, headRollRel: 10 }), undefined, { levelUnconfirmed: true }).byId.headLevel.status).toBe('adjust')
    }
  })

  it('the upSource argument overrides the features’ own source', () => {
    // (the head follows the trunk here, so the head-on-trunk signs stay neutral)
    expect(assessPosture(feat({ trunkFwd: 20, neckFwd: 22, headPitch: 34 })).byId.trunkUpright.status).toBe('adjust')
    expect(assessPosture(feat({ trunkFwd: 20, neckFwd: 22, headPitch: 34 }), 'hips').byId.trunkUpright.status).toBe('unknown')
  })

  it('slack widens every tolerance (hold/capture hysteresis)', () => {
    const f = feat({ neckFwd: 22, trunkLat: 6.5 })
    expect(assessPosture(f).allGood).toBe(false)
    expect(assessPosture(f, undefined, { slack: 1.2 }).allGood).toBe(true)
  })
})
