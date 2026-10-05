import { describe, expect, it } from 'vitest'
import { capAssistantText, inlineText, MAX_ASSISTANT_CHARS, parseInline, parseMarkdown, plainPreview, plainText, SHORTENED_SUFFIX } from '../markdown'

describe('parseInline', () => {
  it('keeps plain text as one node', () => {
    expect(parseInline('Sit tall.')).toEqual([{ t: 'text', v: 'Sit tall.' }])
  })

  it('parses **bold** and __bold__', () => {
    expect(parseInline('Two things: **raise the screen** now')).toEqual([
      { t: 'text', v: 'Two things: ' },
      { t: 'strong', c: [{ t: 'text', v: 'raise the screen' }] },
      { t: 'text', v: ' now' }
    ])
    expect(parseInline('__bold__')).toEqual([{ t: 'strong', c: [{ t: 'text', v: 'bold' }] }])
  })

  it('parses *italic* and _italic_', () => {
    expect(parseInline('press *Check my posture now*.')).toEqual([
      { t: 'text', v: 'press ' },
      { t: 'em', c: [{ t: 'text', v: 'Check my posture now' }] },
      { t: 'text', v: '.' }
    ])
    expect(parseInline('_soft_')).toEqual([{ t: 'em', c: [{ t: 'text', v: 'soft' }] }])
  })

  it('nests italic inside bold', () => {
    expect(parseInline('**very *much* so**')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'very ' }, { t: 'em', c: [{ t: 'text', v: 'much' }] }, { t: 'text', v: ' so' }] }
    ])
  })

  it('parses `code` verbatim (no emphasis inside)', () => {
    expect(parseInline('use `**x**` here')).toEqual([
      { t: 'text', v: 'use ' },
      { t: 'code', v: '**x**' },
      { t: 'text', v: ' here' }
    ])
  })

  it('leaves snake_case, lone asterisks and unclosed markers literal', () => {
    expect(inlineText(parseInline('a snake_case_name'))).toBe('a snake_case_name')
    expect(parseInline('a snake_case_name')).toHaveLength(1)
    expect(parseInline('5 * 3 = 15')).toEqual([{ t: 'text', v: '5 * 3 = 15' }])
    expect(parseInline('**not closed')).toEqual([{ t: 'text', v: '**not closed' }])
    expect(parseInline('a ` lone tick')).toEqual([{ t: 'text', v: 'a ` lone tick' }])
  })

  it('flattens links to plain text with the url, never a link node', () => {
    expect(parseInline('see [the guide](https://example.com/x) please')).toEqual([{ t: 'text', v: 'see the guide (https://example.com/x) please' }])
    expect(parseInline('[https://a.b](https://a.b)')).toEqual([{ t: 'text', v: 'https://a.b' }])
    // bare URLs stay text
    expect(parseInline('go to https://example.com')).toEqual([{ t: 'text', v: 'go to https://example.com' }])
  })

  it('keeps HTML as literal text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }])
  })
})

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps single newlines as line breaks', () => {
    const b = parseMarkdown('Line one\nline two\n\nNext para')
    expect(b).toHaveLength(2)
    expect(b[0]).toEqual({ t: 'p', lines: [[{ t: 'text', v: 'Line one' }], [{ t: 'text', v: 'line two' }]] })
    expect(b[1].t).toBe('p')
  })

  it('parses bullet lists with -, * and •', () => {
    const b = parseMarkdown('Try this:\n- Tuck your chin\n* Raise the screen\n• Sit back')
    expect(b.map((x) => x.t)).toEqual(['p', 'ul'])
    const ul = b[1]
    expect(ul.t === 'ul' && ul.items.map(inlineText)).toEqual(['Tuck your chin', 'Raise the screen', 'Sit back'])
  })

  it('does not mistake a bold start for a bullet', () => {
    const b = parseMarkdown('**Tip:** sit back')
    expect(b[0].t).toBe('p')
  })

  it('parses numbered lists with 1. and 1)', () => {
    const b = parseMarkdown('1. Stand up\n2) Roll your shoulders\n3. Sit down')
    expect(b).toHaveLength(1)
    const ol = b[0]
    expect(ol.t).toBe('ol')
    expect(ol.t === 'ol' && ol.items.map((i) => i.n)).toEqual([1, 2, 3])
  })

  it('continues a list item on an indented line', () => {
    const b = parseMarkdown('- first\n  still first\n- second')
    const ul = b[0]
    expect(ul.t === 'ul' && ul.items.map(inlineText)).toEqual(['first still first', 'second'])
  })

  it('turns headings into a bold paragraph block', () => {
    expect(parseMarkdown('### Your setup ###')).toEqual([{ t: 'h', c: [{ t: 'text', v: 'Your setup' }] }])
  })

  it('parses quotes', () => {
    const b = parseMarkdown('> one\n> two')
    expect(b).toEqual([{ t: 'quote', lines: [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two' }]] }])
  })

  it('keeps code fences verbatim, including markdown inside', () => {
    const b = parseMarkdown('Before\n```\n- not a list\n**raw**\n```\nAfter')
    expect(b.map((x) => x.t)).toEqual(['p', 'pre', 'p'])
    expect(b[1]).toEqual({ t: 'pre', v: '- not a list\n**raw**' })
  })

  it('treats an unterminated fence as code to the end', () => {
    expect(parseMarkdown('```\nabc')).toEqual([{ t: 'pre', v: 'abc' }])
  })

  it('keeps tables and rules as text', () => {
    const b = parseMarkdown('| a | b |\n|---|---|\n---')
    expect(b.every((x) => x.t === 'p')).toBe(true)
  })

  it('handles CRLF and empty input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('a\r\n\r\nb')).toHaveLength(2)
  })
})

describe('capAssistantText / plainPreview', () => {
  it('caps long replies with "… (shortened)"', () => {
    const long = 'x'.repeat(MAX_ASSISTANT_CHARS + 50)
    const c = capAssistantText(long)
    expect(c.endsWith(SHORTENED_SUFFIX)).toBe(true)
    expect(c.length).toBe(MAX_ASSISTANT_CHARS + SHORTENED_SUFFIX.length)
    expect(capAssistantText('short')).toBe('short')
  })

  it('previews markdown as one plain line', () => {
    expect(plainPreview('**Sit back.**\n\n- Tuck your chin\n- Breathe')).toBe('Sit back. Tuck your chin Breathe')
    expect(plainPreview('a'.repeat(300), 20)).toHaveLength(20)
  })
})

describe('plainText (copy)', () => {
  it('drops the markup but keeps the line structure', () => {
    const md = '# Tips\n**Bold tip** and `code`.\nsecond line\n\n- one\n- *two*\n\n3. three\n4. four\n\n```\nraw **not bold**\n```\n\n> quoted'
    expect(plainText(md)).toBe(
      'Tips\n\nBold tip and code.\nsecond line\n\n• one\n• two\n\n3. three\n4. four\n\nraw **not bold**\n\n> quoted'
    )
  })

  it('flattens links and returns "" for empty text', () => {
    expect(plainText('see [docs](https://x.y)')).toBe('see docs (https://x.y)')
    expect(plainText('')).toBe('')
  })
})
