import { describe, expect, it } from 'vitest'
import { ISSUES, type PostureAlert } from '../../shared/posture'
import { COPY, CopyPicker, ESCALATION_LEADS, composeToast } from '../notification-copy'

function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const alert = (patch: Partial<PostureAlert> = {}): PostureAlert => ({
  issue: 'sink',
  stage: 2,
  kind: 'initial',
  durationMs: 90_000,
  ...patch
})

describe('toast copy pools', () => {
  it('has several distinct phrasings for every issue and stage', () => {
    for (const issue of ISSUES) {
      for (const stage of [1, 2, 3] as const) {
        const pool = COPY[issue][stage]
        expect(pool.length).toBeGreaterThanOrEqual(4)
        expect(new Set(pool.map((c) => c.title)).size).toBe(pool.length)
        expect(new Set(pool.map((c) => c.body)).size).toBe(pool.length)
      }
    }
  })

  it('only uses tokens the interpolation knows', () => {
    const picker = new CopyPicker(seeded(1))
    for (const issue of ISSUES) {
      for (const stage of [1, 2, 3] as const) {
        for (let k = 0; k < COPY[issue][stage].length; k++) {
          for (const direction of [undefined, 'left', 'right'] as const) {
            const { title, body } = composeToast(alert({ issue, stage, direction }), picker)
            expect(title + body).not.toMatch(/[{}]/)
          }
        }
      }
    }
  })
})

describe('CopyPicker', () => {
  it('uses every phrasing once before repeating, and never repeats back to back', () => {
    const picker = new CopyPicker(seeded(42))
    const size = 5
    const draws = Array.from({ length: 200 }, () => picker.next('k', size))
    for (let c = 0; c < draws.length; c += size) {
      expect(new Set(draws.slice(c, c + size)).size).toBe(size)
    }
    for (let i = 1; i < draws.length; i++) expect(draws[i]).not.toBe(draws[i - 1])
  })

  it('keeps separate rotations per key', () => {
    const picker = new CopyPicker(seeded(7))
    const a = Array.from({ length: 4 }, () => picker.next('a', 4))
    const b = Array.from({ length: 4 }, () => picker.next('b', 4))
    expect(new Set(a).size).toBe(4)
    expect(new Set(b).size).toBe(4)
  })

  it('handles single-entry pools', () => {
    expect(new CopyPicker().next('x', 1)).toBe(0)
  })
})

describe('composeToast', () => {
  it('varies the text for repeated nudges about the same thing', () => {
    const picker = new CopyPicker(seeded(3))
    const titles = Array.from({ length: 5 }, () => composeToast(alert(), picker).title)
    expect(new Set(titles).size).toBe(5)
  })

  it('names the lean direction, or says "one side" when unknown', () => {
    const picker = new CopyPicker(() => 0)
    const all = (direction?: 'left' | 'right'): string =>
      Array.from({ length: 5 }, () => {
        const t = composeToast(alert({ issue: 'lean', stage: 1, direction }), picker)
        return `${t.title} ${t.body}`
      }).join(' ')
    expect(all('left')).toContain('to the left')
    expect(all()).toContain('to one side')
  })

  it('fills in the episode length in whole minutes, at least 1', () => {
    const picker = new CopyPicker(seeded(9))
    const texts = Array.from({ length: 5 }, () => {
      const t = composeToast(alert({ stage: 3, durationMs: 20_000 }), picker)
      return t.title + t.body
    })
    expect(texts.some((t) => t.includes('1 min'))).toBe(true)
    expect(texts.join(' ')).not.toContain('0 min')
  })

  it('leads escalations into the fix without shouting', () => {
    const picker = new CopyPicker(seeded(5))
    const { body } = composeToast(alert({ kind: 'escalation' }), picker)
    const lead = ESCALATION_LEADS.find((l) => body.startsWith(l))
    expect(lead).toBeDefined()
    const rest = body.slice(lead!.length)
    expect(rest[0]).toBe(rest[0].toLowerCase())
  })
})
