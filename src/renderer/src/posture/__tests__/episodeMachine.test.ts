import { describe, expect, it } from 'vitest'
import type { PostureAlert, Stage } from '@shared/posture'
import { EpisodeMachine } from '../episodeMachine'

const CFG = { dwellS: 12, cooldownS: 120, escalation: true }

interface DriveState {
  sevT: Stage
  sevR?: Stage
  data?: boolean
}

/** Step the machine at 10fps from `fromMs` (inclusive) to `toMs` (exclusive). */
function drive(m: EpisodeMachine, state: DriveState, fromMs: number, toMs: number): PostureAlert[] {
  const alerts: PostureAlert[] = []
  for (let t = fromMs; t < toMs; t += 100) {
    alerts.push(
      ...m.step({ sevTrigger: state.sevT, sevRecovery: state.sevR ?? state.sevT, dataAvailable: state.data ?? true }, t)
    )
  }
  return alerts
}

describe('EpisodeMachine — dwell', () => {
  it('fires the initial alert only after sustained dwell time', () => {
    const m = new EpisodeMachine('sink', CFG)
    expect(drive(m, { sevT: 1 }, 0, 11_900)).toEqual([])
    const alerts = drive(m, { sevT: 1 }, 11_900, 12_600)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ issue: 'sink', stage: 1, kind: 'initial' })
    expect(alerts[0].durationMs).toBeGreaterThanOrEqual(11_900)
  })

  it('fires with the CURRENT stage if posture worsened during the dwell', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 8_000)
    const alerts = drive(m, { sevT: 3 }, 8_000, 12_600)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].stage).toBe(3)
  })

  it('does not fire if posture recovers before the dwell elapses', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 8_000)
    expect(drive(m, { sevT: 0, sevR: 0 }, 8_000, 30_000)).toEqual([])
  })
})

describe('EpisodeMachine — hysteresis band', () => {
  it('holds (not resets) the dwell while in the band, then continues', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 8_000) // 8s accumulated
    drive(m, { sevT: 0, sevR: 1 }, 8_000, 11_000) // 3s in band: held
    // 4 more seconds of violation completes the 12s dwell
    const alerts = drive(m, { sevT: 1 }, 11_000, 15_200)
    expect(alerts).toHaveLength(1)
  })

  it('returns to idle after more than 5s continuously in the band', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 8_000)
    drive(m, { sevT: 0, sevR: 1 }, 8_000, 14_000) // 6s in band → idle
    // a fresh violation needs a fresh 12s dwell → nothing after only 8s
    expect(drive(m, { sevT: 1 }, 14_000, 22_000)).toEqual([])
  })
})

describe('EpisodeMachine — escalation', () => {
  it('escalates when severity worsens ≥4s sustained and ≥30s after the last alert', () => {
    const m = new EpisodeMachine('sink', CFG)
    const initial = drive(m, { sevT: 1 }, 0, 12_100)
    expect(initial).toHaveLength(1)
    // worsens immediately, but the 30s min gap gates the escalation
    const early = drive(m, { sevT: 2 }, 12_100, 40_000)
    expect(early).toEqual([])
    const esc = drive(m, { sevT: 2 }, 40_000, 46_500)
    expect(esc).toHaveLength(1)
    expect(esc[0]).toMatchObject({ stage: 2, kind: 'escalation' })
  })

  it('never escalates when escalation is disabled', () => {
    const m = new EpisodeMachine('sink', { ...CFG, escalation: false })
    drive(m, { sevT: 1 }, 0, 12_100)
    expect(drive(m, { sevT: 3 }, 12_100, 120_000)).toEqual([])
  })

  it('de-escalation is silent and the alerted stage only ratchets up', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 2 }, 0, 12_100) // initial at stage 2
    // dropping to 1 (still violating) fires nothing…
    expect(drive(m, { sevT: 1 }, 12_100, 80_000)).toEqual([])
    // …and climbing back to 2 is not "worse than alerted" → still nothing
    expect(drive(m, { sevT: 2 }, 80_000, 120_000)).toEqual([])
  })
})

describe('EpisodeMachine — recovery and cooldown', () => {
  it('a recovered episode enters cooldown; the next violation alerts only after the cooldown', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 12_100) // initial alert, episode runs
    drive(m, { sevT: 0, sevR: 0 }, 12_100, 17_200) // 5s sustained recovery → cooldown starts ≈17.1s
    // new violation right away: dwell (12s) is met at ≈29.2s but cooldown runs to ≈137s
    const during = drive(m, { sevT: 1 }, 17_200, 137_000)
    expect(during).toEqual([])
    const after = drive(m, { sevT: 1 }, 137_000, 138_500)
    expect(after).toHaveLength(1)
    expect(after[0].kind).toBe('initial')
  })

  it('a relapse during the recovery window rejoins the episode without a new alert', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 12_100)
    drive(m, { sevT: 0, sevR: 0 }, 12_100, 15_000) // recovering, not yet 5s
    expect(drive(m, { sevT: 1 }, 15_000, 40_000)).toEqual([]) // same episode continues silently
  })
})

describe('EpisodeMachine — data loss and freezing', () => {
  it('frozen time (data unavailable) does not count toward the dwell', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 8_000)
    drive(m, { sevT: 1, data: false }, 8_000, 13_000) // 5s frozen — under the 10s reset
    expect(drive(m, { sevT: 1 }, 13_000, 16_900)).toEqual([]) // 8+3.9 < 12s
    expect(drive(m, { sevT: 1 }, 16_900, 17_300)).toHaveLength(1)
  })

  it('resets silently to idle when data stays unavailable for more than 10s', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 8_000)
    drive(m, { sevT: 1, data: false }, 8_000, 19_000) // 11s of data loss
    // fresh dwell required now
    expect(drive(m, { sevT: 1 }, 19_000, 27_000)).toEqual([])
    expect(drive(m, { sevT: 1 }, 27_000, 31_200)).toHaveLength(1)
  })
})

describe('EpisodeMachine — long gaps between steps (pause, sleep, camera restart)', () => {
  it('an alerted episode does not carry over a 60-min gap: a still-slouched user gets a fresh initial alert', () => {
    const m = new EpisodeMachine('sink', CFG)
    expect(drive(m, { sevT: 1 }, 0, 12_100)).toHaveLength(1)
    const resume = 12_100 + 60 * 60_000
    // first frame after the gap: no instant alert, a fresh dwell is needed
    expect(drive(m, { sevT: 1 }, resume, resume + 11_000)).toEqual([])
    expect(m.episodeActiveForMs(resume + 11_000)).toBeLessThan(12_000)
    const again = drive(m, { sevT: 1 }, resume + 11_000, resume + 13_000)
    expect(again).toEqual([expect.objectContaining({ kind: 'initial', stage: 1 })])
    expect(again[0].durationMs).toBeLessThan(13_000)
  })

  it('a pending dwell is not completed by the first frame after a gap, and its duration excludes the gap', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 3 }, 0, 11_600)
    const resume = 11_600 + 60 * 60_000
    expect(drive(m, { sevT: 3 }, resume, resume + 1_000)).toEqual([])
    const fired = drive(m, { sevT: 3 }, resume + 1_000, resume + 12_500)
    expect(fired).toHaveLength(1)
    expect(fired[0].durationMs).toBeLessThanOrEqual(12_500)
  })

  it('a long gap also ends the quiet period (like a long absence)', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 12_100)
    drive(m, { sevT: 0, sevR: 0 }, 12_100, 17_200) // cooldown armed until ≈137 s
    expect(m.phase).toBe('cooldown')
    const resume = 17_200 + 40_000
    drive(m, { sevT: 0, sevR: 0 }, resume, resume + 100)
    expect(m.phase).toBe('idle')
    expect(drive(m, { sevT: 1 }, resume + 100, resume + 12_600)).toHaveLength(1)
  })

  it('gaps up to the full-reset limit keep the existing (capped Δt) behaviour', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 8_000)
    // 20 s without steps: still the same pending episode, the gap adds only DT_CAP
    expect(drive(m, { sevT: 1 }, 28_000, 31_500)).toEqual([])
    expect(drive(m, { sevT: 1 }, 31_500, 32_500)).toHaveLength(1)
  })
})

describe('EpisodeMachine — escalation during the quiet period', () => {
  /** initial stage-1 alert at ≈12 s, recovered for 5 s → cooldown until ≈137 s */
  function quiet(cfg = CFG): EpisodeMachine {
    const m = new EpisodeMachine('sink', cfg)
    expect(drive(m, { sevT: 1 }, 0, 12_100)).toHaveLength(1)
    drive(m, { sevT: 0, sevR: 0 }, 12_100, 17_200)
    expect(m.phase).toBe('cooldown')
    return m
  }

  it('a worse stage alerts as an escalation inside the quiet period (dwell met, ESC_MIN_GAP after the last alert)', () => {
    const m = quiet()
    // slumps straight to stage 3: the dwell completes at ≈29.2 s, the 30 s gap to the
    // initial alert (12.0 s) at 42 s — both long before the cooldown ends (≈137 s)
    expect(drive(m, { sevT: 3 }, 17_200, 41_950)).toEqual([])
    const esc = drive(m, { sevT: 3 }, 41_950, 42_500)
    expect(esc).toEqual([expect.objectContaining({ kind: 'escalation', stage: 3 })])
    expect(m.phase).toBe('alerted')
    // and nothing more for that episode at the same stage
    expect(drive(m, { sevT: 3 }, 42_500, 200_000)).toEqual([])
  })

  it('the same (or a lower) stage stays quiet until the cooldown ends', () => {
    const m = quiet()
    expect(drive(m, { sevT: 1 }, 17_200, 137_000)).toEqual([])
  })

  it('the worse stage must hold for ESC_DWELL (brief spikes do not get through)', () => {
    const m = quiet()
    drive(m, { sevT: 1 }, 17_200, 30_000) // dwell met at stage 1 (quiet)
    const alerts: PostureAlert[] = []
    for (let k = 0; k < 10; k++) {
      const t = 30_000 + k * 6_000
      alerts.push(...drive(m, { sevT: 3 }, t, t + 3_000)) // 3 s at stage 3 …
      alerts.push(...drive(m, { sevT: 1 }, t + 3_000, t + 6_000)) // … then back to 1
    }
    expect(alerts).toEqual([])
    expect(drive(m, { sevT: 3 }, 90_000, 94_200)).toEqual([expect.objectContaining({ kind: 'escalation', stage: 3 })])
  })

  it('is rate-limited to ESC_MIN_GAP after the previous alert', () => {
    const m = new EpisodeMachine('sink', { ...CFG, dwellS: 2 })
    expect(drive(m, { sevT: 1 }, 0, 2_100)).toHaveLength(1)
    drive(m, { sevT: 0, sevR: 0 }, 2_100, 7_200) // cooldown armed at ≈7.1 s
    // stage 2 right away: dwell 2 s and ESC_DWELL 4 s are met by ≈11.3 s, the gap only at ≈32 s
    expect(drive(m, { sevT: 2 }, 7_200, 32_000)).toEqual([])
    expect(drive(m, { sevT: 2 }, 32_000, 32_500)).toEqual([expect.objectContaining({ kind: 'escalation', stage: 2 })])
  })

  it('never breaks the quiet period when escalation is disabled', () => {
    const m = quiet({ ...CFG, escalation: false })
    expect(drive(m, { sevT: 3 }, 17_200, 137_000)).toEqual([])
    expect(drive(m, { sevT: 3 }, 137_000, 138_000)).toEqual([expect.objectContaining({ kind: 'initial', stage: 3 })])
  })

  it('after a quiet-period escalation recovers, only a stage above it gets through', () => {
    const m = quiet()
    expect(drive(m, { sevT: 2 }, 17_200, 42_500)).toHaveLength(1) // escalation to 2 at 42 s
    drive(m, { sevT: 0, sevR: 0 }, 42_500, 47_600) // recovered: quiet period re-armed to ≈167.5 s
    expect(drive(m, { sevT: 2 }, 47_600, 160_000)).toEqual([])
    expect(drive(m, { sevT: 3 }, 160_000, 165_000)).toEqual([expect.objectContaining({ kind: 'escalation', stage: 3 })])
  })
})

describe('EpisodeMachine — data-loss reset of an alerted episode', () => {
  it('starts the quiet period: no new initial alert ~23 s after the last one', () => {
    const m = new EpisodeMachine('sink', CFG)
    expect(drive(m, { sevT: 1 }, 0, 12_100)).toHaveLength(1)
    drive(m, { sevT: 1, data: false }, 12_200, 23_000) // >10 s unavailable → silent reset
    expect(m.phase).toBe('cooldown')
    // still slouched afterwards: quiet until the cooldown (from ≈22.3 s) ends
    expect(drive(m, { sevT: 1 }, 23_000, 142_000)).toEqual([])
    expect(drive(m, { sevT: 1 }, 142_000, 143_000)).toEqual([expect.objectContaining({ kind: 'initial' })])
  })

  it('a pending (never alerted) episode lost to data loss arms no cooldown', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 8_000)
    drive(m, { sevT: 1, data: false }, 8_000, 19_000)
    expect(m.phase).toBe('idle')
  })

  it('a worse stage after the data-loss reset still escalates through the quiet period', () => {
    const m = new EpisodeMachine('sink', CFG)
    drive(m, { sevT: 1 }, 0, 12_100)
    drive(m, { sevT: 1, data: false }, 12_200, 23_000)
    expect(drive(m, { sevT: 3 }, 23_000, 43_000)).toEqual([expect.objectContaining({ kind: 'escalation', stage: 3 })])
  })
})
