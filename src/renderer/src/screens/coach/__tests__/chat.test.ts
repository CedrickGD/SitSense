import { describe, expect, it } from 'vitest'
import {
  checkAsText,
  fromStored,
  greetingText,
  HISTORY_CAP,
  layoutRows,
  newMessageId,
  PROMPT_POOL,
  relativeDay,
  SEND_MESSAGE_CHARS,
  suggestedPrompts,
  toAiMessages,
  toStored
} from '../chat'
import type { CoachMessage } from '../types'

const T0 = new Date(2026, 9, 5, 14, 0).getTime()
let n = 0
const m = (role: CoachMessage['role'], kind: CoachMessage['kind'], text: string, at = T0 + n * 1000, extra: Partial<CoachMessage> = {}): CoachMessage => ({
  id: `m${++n}`,
  role,
  kind,
  text,
  at,
  ...extra
})

const REVIEW = {
  ok: true as const,
  connectionLabel: 'Google Gemini',
  model: 'gemini-3.5-flash-lite',
  verdict: 'adjust' as const,
  score: 82,
  summary: 'Your head drifts ahead of your shoulders.',
  instructions: ['Tuck your chin', 'Raise the screen']
}

describe('toAiMessages', () => {
  it('keeps user/assistant text, drops notes and errors, merges same-role turns', () => {
    const list = [
      m('assistant', 'text', 'stale greeting'),
      m('user', 'text', 'Hi'),
      m('system', 'note', 'Measurements updated'),
      m('user', 'text', 'How is my neck?'),
      m('assistant', 'error', 'boom', undefined, { retryOf: 'x' }),
      m('assistant', 'text', 'Good.')
    ]
    expect(toAiMessages(list)).toEqual([
      { role: 'user', content: 'Hi\n\nHow is my neck?' },
      { role: 'assistant', content: 'Good.' }
    ])
  })

  it('turns a posture check into text so follow-ups have the context', () => {
    const list = [m('user', 'check', 'Checked my posture', undefined, { share: 'sketch' }), m('assistant', 'check', REVIEW.summary, undefined, { review: REVIEW, share: 'sketch' })]
    const out = toAiMessages(list)
    expect(out[0]).toEqual({ role: 'user', content: 'Please check my posture now.' })
    expect(out[1].role).toBe('assistant')
    expect(out[1].content).toContain('82/100')
    expect(out[1].content).toContain('adjust')
    expect(out[1].content).toContain('1. Tuck your chin')
    expect(checkAsText(list[1])).toContain('pose sketch')
  })

  it('stops at upTo (retry resends the conversation up to that message)', () => {
    const a = m('user', 'text', 'first')
    const b = m('assistant', 'text', 'answer')
    const c = m('user', 'text', 'second')
    expect(toAiMessages([a, b, c], { upTo: a.id })).toEqual([{ role: 'user', content: 'first' }])
  })

  it('keeps the last turns, always starting with a user turn, each capped', () => {
    const list: CoachMessage[] = []
    for (let i = 0; i < 30; i++) list.push(m(i % 2 ? 'assistant' : 'user', 'text', `t${i}`))
    const out = toAiMessages(list, { turns: 5 })
    expect(out[0].role).toBe('user')
    expect(out.length).toBeLessThanOrEqual(5)
    const long = toAiMessages([m('user', 'text', 'x'.repeat(5000))])
    expect(long[0].content.length).toBe(SEND_MESSAGE_CHARS)
  })
})

describe('suggestedPrompts', () => {
  it('rotates through the pool by seed', () => {
    expect(suggestedPrompts(0, 4)).toEqual(PROMPT_POOL.slice(0, 4))
    expect(suggestedPrompts(PROMPT_POOL.length + 1, 2)).toEqual(PROMPT_POOL.slice(1, 3))
    expect(suggestedPrompts(-1, 1)).toEqual([PROMPT_POOL[PROMPT_POOL.length - 1]])
  })

  it('skips prompts already asked (punctuation-insensitive)', () => {
    const out = suggestedPrompts(0, 3, ['how’s my posture right now'])
    expect(out).not.toContain(PROMPT_POOL[0])
    expect(out).toHaveLength(3)
  })
})

describe('layoutRows', () => {
  it('adds day separators and groups same-side text within 2 minutes', () => {
    const y = T0 - 86_400_000
    const list = [
      m('user', 'text', 'yesterday', y),
      m('user', 'text', 'a', T0),
      m('user', 'text', 'b', T0 + 60_000),
      m('assistant', 'text', 'c', T0 + 70_000),
      m('assistant', 'text', 'd', T0 + 4 * 60_000)
    ]
    const rows = layoutRows(list)
    expect(rows.map((r) => (r.t === 'day' ? 'day' : r.head ? 'H' : '-'))).toEqual(['day', 'H', 'day', 'H', '-', 'H', 'H'])
  })

  it('names today and yesterday', () => {
    expect(relativeDay(T0, T0 + 1000)).toBe('Today')
    expect(relativeDay(T0 - 86_400_000, T0)).toBe('Yesterday')
    expect(relativeDay(T0 - 3 * 86_400_000, T0)).toBeNull()
  })
})

describe('local history', () => {
  it('never stores sketches or inline hints, and stores note-only chats as empty', () => {
    const check = m('assistant', 'check', 's', undefined, { review: REVIEW, share: 'sketch', sketch: { points: [[0.5, 0.5]], aspect: 1.33 } })
    const hint = m('system', 'note', 'Resume monitoring to check your posture.', undefined, { tone: 'info' })
    const stored = toStored([m('user', 'check', 'Checked my posture'), check, hint])
    expect(stored).toHaveLength(2)
    expect(stored[1].sketch).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain('points')
    expect(toStored([m('system', 'note', 'Conversation cleared')])).toEqual([])
  })

  it('caps the history at 200 messages', () => {
    const many = Array.from({ length: 250 }, (_, i) => m('user', 'text', `q${i}`))
    const s = toStored(many)
    expect(s).toHaveLength(HISTORY_CAP)
    expect(s[0].text).toBe('q50')
  })

  it('round-trips and validates field by field', () => {
    const good = [m('user', 'text', 'hi'), m('assistant', 'check', 's', undefined, { review: REVIEW, share: 'snapshot' }), m('assistant', 'error', 'e', undefined, { retryOf: 'm1', fromModel: true })]
    expect(fromStored(JSON.parse(JSON.stringify(toStored(good))))).toEqual(toStored(good))
    expect(fromStored(null)).toEqual([])
    expect(fromStored('x')).toEqual([])
    expect(
      fromStored([
        { id: 'a', role: 'hacker', kind: 'text', text: 'x', at: 1 },
        { id: 'b', role: 'user', kind: 'text', text: 5, at: 1 },
        { id: 'c', role: 'user', kind: 'text', text: 'ok', at: 'now' },
        { id: 'd', role: 'assistant', kind: 'check', text: 'no review', at: 1 },
        { id: 'e', role: 'user', kind: 'text', text: 'kept', at: 1 },
        { id: 'e', role: 'user', kind: 'text', text: 'dup', at: 1 }
      ]).map((x) => x.text)
    ).toEqual(['kept'])
  })

  it('clamps a stored review', () => {
    const [x] = fromStored([{ id: 'r', role: 'assistant', kind: 'check', text: 's', at: 1, review: { ...REVIEW, score: 140, instructions: ['a', 2, 'b', 'c', 'd'] } }])
    expect(x.review?.score).toBe(100)
    expect(x.review?.instructions).toEqual(['a', 'b', 'c'])
  })

  it('makes unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newMessageId(T0)))
    expect(ids.size).toBe(500)
  })
})

describe('greetingText', () => {
  const on = { live: true, today: true, baseline: true }
  const yes = { available: true, lines: ['x'] }
  const no = { available: false, lines: ['x'] }
  it('lists only what is ticked and available', () => {
    expect(greetingText(on, { live: yes, today: yes, baseline: yes }, true)).toBe(
      'Hi! I can see your live posture numbers, today’s stats and your saved posture. Ask me anything — or press *Check my posture now*.'
    )
    expect(greetingText({ ...on, today: false }, { live: yes, today: yes, baseline: no }, true)).toBe(
      'Hi! I can see your live posture numbers. Ask me anything — or press *Check my posture now*.'
    )
  })
  it('does not claim live numbers while away, and falls back when nothing is shared', () => {
    expect(greetingText(on, { live: yes, today: no, baseline: yes }, false)).toBe(
      'Hi! I can see your saved posture. Ask me anything — or press *Check my posture now*.'
    )
    expect(greetingText(on, { live: no, today: no, baseline: no }, true)).toBe(
      'Hi! Ask me anything about your posture, your desk or a stretch — or press *Check my posture now*.'
    )
  })
})
