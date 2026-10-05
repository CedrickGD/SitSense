// Renderer-side helpers for the connected-AI features (docs/specs/ai-providers.md).
// Pure — unit-tested in __tests__/helpers.test.ts.

import type { AiConnection, AiReviewMeasurements } from '@shared/ai'
import type { CalibrationBaseline } from '@shared/posture'
import type { Settings } from '@shared/settings'
import type { PostureAssessment } from '@renderer/posture/assess'
import type { PostureFeatures } from '@renderer/posture/types'

/** The connection a review will try first (order = priority), or null. */
export function primaryAiConnection(settings: Settings | null): AiConnection | null {
  if (!settings) return null
  return settings.ai.connections.find((c) => c.enabled) ?? null
}

/**
 * AI features are usable: the master switch is on and at least one connection is
 * enabled. (Whether its key works is only known after a request.) Use this for the
 * Ask AI button and the `on-device · AI: <label>` chip.
 */
export function aiAvailable(settings: Settings | null): boolean {
  return !!settings?.ai.enabled && primaryAiConnection(settings) !== null
}

/** Setup asks the connected model to confirm the posture before saving the baseline. */
export function aiReviewsSetup(settings: Settings | null): boolean {
  return aiAvailable(settings) && !!settings?.ai.useInSetup
}

const round1 = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10

/** Measurements for an on-demand check, from (time-smoothed) live features and their assessment. */
export function measurementsFromFeatures(f: PostureFeatures, a: PostureAssessment): AiReviewMeasurements {
  return {
    view: f.view.kind,
    neckFwdDeg: round1(f.neckFwd),
    trunkFwdDeg: round1(f.trunkFwd),
    headPitchDeg: round1(f.headPitch),
    shoulderTiltDeg: round1(f.shoulderTilt),
    headRollDeg: round1(f.headRollRel),
    trunkLatDeg: round1(f.trunkLat),
    localVerdict: a.allGood ? 'good' : 'adjust',
    localInstruction: a.allGood ? null : (a.primary?.instruction ?? null)
  }
}

/** Measurements for the setup review, from the captured baseline (judged good locally). */
export function measurementsFromBaseline(b: CalibrationBaseline): AiReviewMeasurements {
  return {
    view: b.view.kind,
    neckFwdDeg: round1(b.neckFwd),
    trunkFwdDeg: round1(b.trunkFwd),
    headPitchDeg: round1(b.headPitch),
    shoulderTiltDeg: round1(b.shoulderTilt),
    headRollDeg: round1(b.headRollRel),
    trunkLatDeg: round1(b.trunkLat),
    localVerdict: 'good',
    localInstruction: null
  }
}

/** One short line for a review that could not run, e.g. in setup. */
export function aiUnavailableNote(message: string): string {
  const m = message.trim().replace(/[.\s]+$/, '')
  return `AI check unavailable: ${m || 'no answer'} — used on-device judgment.`
}
