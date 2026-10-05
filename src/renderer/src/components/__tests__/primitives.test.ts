// Pure placement maths + static-markup smoke renders of the shared building blocks.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ICON_NAMES, Icon } from '../icons'
import { Banner, Button, Chip, EmptyState, Gauge, placeFloating, ScoreRing, SegmentedControl, StatTile, Stepper } from '../primitives'

const rect = (
  left: number,
  top: number,
  width: number,
  height: number
): { left: number; top: number; right: number; bottom: number; width: number; height: number } => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
})

describe('placeFloating', () => {
  it('places above and centered by default', () => {
    expect(placeFloating(rect(100, 200, 40, 20), 80, 30, 'top', 'center', 8, 1200, 800)).toEqual({ left: 80, top: 162, placement: 'top' })
  })
  it('flips below when there is no room above', () => {
    const p = placeFloating(rect(100, 10, 40, 20), 80, 30, 'top', 'center', 8, 1200, 800)
    expect(p.placement).toBe('bottom')
    expect(p.top).toBe(38)
  })
  it('flips left when the right side would clip, and clamps into the viewport', () => {
    expect(placeFloating(rect(1150, 100, 40, 20), 200, 30, 'right', 'center', 8, 1200, 800).placement).toBe('left')
    expect(placeFloating(rect(0, 100, 20, 20), 300, 30, 'top', 'center', 8, 1200, 800).left).toBe(6)
  })
})

describe('smoke renders', () => {
  it('renders every icon', () => {
    for (const name of ICON_NAMES) expect(renderToStaticMarkup(createElement(Icon, { name }))).toContain('<svg')
  })

  it('renders the score ring with and without a value', () => {
    expect(renderToStaticMarkup(createElement(ScoreRing, { value: 86 }))).toContain('Posture score 86 out of 100')
    expect(renderToStaticMarkup(createElement(ScoreRing, { value: null }))).toContain('—')
  })

  it('renders gauges: value, unavailable, off', () => {
    const base = {
      label: 'Head position',
      range: [-10, 32] as [number, number],
      ticks: [10, 18, 28] as [number, number, number],
      stage: 1 as const
    }
    expect(renderToStaticMarkup(createElement(Gauge, { ...base, value: 12, valueText: '+12° forward' }))).toContain('+12° forward')
    expect(renderToStaticMarkup(createElement(Gauge, { ...base, value: null, valueText: '' }))).toContain('can’t see from here')
    expect(renderToStaticMarkup(createElement(Gauge, { ...base, value: 3, valueText: '', disabled: true }))).toContain('>off<')
  })

  it('renders buttons, chips, tiles, banner, stepper, segmented and the empty state', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(Button, { variant: 'primary', icon: 'send' }, 'Send'),
        createElement(Button, { loading: true }, 'Testing…'),
        createElement(Chip, { tone: 'outline-amber', icon: 'alert', children: 'Unverified baseline' }),
        createElement(StatTile, { eyebrow: 'ALIGNED', value: '82%', sub: '+6 vs avg', subTone: 'good' }),
        createElement(Banner, { tone: 'amber', children: 'Your view changed a lot since setup — readings may be off.' }),
        createElement(Stepper, { steps: ['Camera', 'Posture', 'Saved'], current: 2 }),
        createElement(SegmentedControl<'a' | 'b'>, {
          value: 'a',
          onChange: () => {},
          options: [
            { value: 'a', label: 'Lines', icon: 'lines' },
            { value: 'b', label: 'Mesh', icon: 'mesh' }
          ]
        }),
        createElement(EmptyState, { icon: 'history', headline: 'Your history starts today', body: 'Come back later.' })
      )
    )
    expect(html).toContain('Send')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Unverified baseline')
    expect(html).toContain('82%')
    expect(html).toContain('aria-current="step"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('Your history starts today')
  })
})
