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
    drive(m, { sevT: 0, sevR: 1 }, 8_000, 11_000) // 3s in band: held, not accumulated
    // 4 more seconds of violation completes the 12s dwell — not earlier
    expect(drive(m, { sevT: 1 }, 11_000, 14_900)).toEqual([])
    expect(drive(m, { sevT: 1 }, 14_900, 15_200)).toHaveLength(1)
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
