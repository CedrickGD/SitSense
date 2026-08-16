import type { Stage } from '@shared/posture'
import { HYST } from './constants'

export type ThresholdKind = 'linear' | 'ratio'

/** Effective trigger threshold at sensitivity σ (docs/specs/detection.md §6). */
export function effThreshold(base: number, sigma: number, kind: ThresholdKind): number {
  return kind === 'linear' ? base / sigma : 1 + (base - 1) / sigma
}

/** Recovery threshold: hysteresis applied to the effective threshold. */
export function recThreshold(base: number, sigma: number, kind: ThresholdKind): number {
  const t = effThreshold(base, sigma, kind)
  return kind === 'linear' ? HYST * t : 1 + HYST * (t - 1)
}

export function stageOf(
  value: number,
  bases: readonly [number, number, number],
  sigma: number,
  kind: ThresholdKind,
  mode: 'trigger' | 'recovery'
): Stage {
  const thr = mode === 'trigger' ? effThreshold : recThreshold
  let stage: Stage = 0
  for (let k = 0; k < 3; k++) {
    if (value >= thr(bases[k], sigma, kind)) stage = (k + 1) as Stage
  }
  return stage
}
