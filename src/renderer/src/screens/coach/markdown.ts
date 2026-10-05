// Markdown-lite for coach replies (docs/specs/ui-v3.md §4.3). Pure: text → a small AST.
// The renderer (Markdown.tsx) turns the AST into React elements — never HTML strings,
// never dangerouslySetInnerHTML. Links are flattened to plain text (no navigation from
// model output); tables, images and HTML stay literal text.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }

export type Block =
  /** lines inside one paragraph (single newlines → <br>) */
  | { t: 'p'; lines: Inline[][] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: { n: number; c: Inline[] }[] }
  /** `# …` headings: a bold paragraph, never a big heading */
  | { t: 'h'; c: Inline[] }
  | { t: 'quote'; lines: Inline[][] }
  | { t: 'pre'; v: string }

/** Assistant messages longer than this are cut (§4.3). */
export const MAX_ASSISTANT_CHARS = 6000
export const SHORTENED_SUFFIX = '… (shortened)'

/** Cap an assistant message at MAX_ASSISTANT_CHARS, appending "… (shortened)". */
export function capAssistantText(text: string): string {
  if (text.length <= MAX_ASSISTANT_CHARS) return text
  return `${text.slice(0, MAX_ASSISTANT_CHARS).trimEnd()}${SHORTENED_SUFFIX}`
}

// ───────────────────────────── inline ─────────────────────────────

const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch)
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch)

function pushText(out: Inline[], v: string): void {
  if (!v) return
  const last = out[out.length - 1]
  if (last && last.t === 'text') last.v += v
  else out.push({ t: 'text', v })
}

/** Index of a closing delimiter `d` at or after `from`, or -1. */
function findClose(s: string, d: string, from: number, single: boolean): number {
  let i = from
  while (i < s.length) {
    const j = s.indexOf(d, i)
    if (j < 0) return -1
    const before = s[j - 1]
    const after = s[j + d.length]
    const ok =
      j > from && // non-empty
      !isSpace(before) &&
      // a single `*`/`_` must not be half of a `**`/`__`
      (!single || (s[j + 1] !== d && before !== d)) &&
      // `_` closes only at a word boundary (snake_case stays literal)
      (d[0] !== '_' || !isWordChar(after))
    if (ok) return j
    i = j + 1
  }
  return -1
}

const LINK_RE = /^\[([^\]\n]+)\]\(([^()\s]+)\)/

/** Parse one line of inline markdown-lite. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    // `code`
    if (ch === '`') {
      const j = s.indexOf('`', i + 1)
      if (j > i + 1) {
        out.push({ t: 'code', v: s.slice(i + 1, j) })
        i = j + 1
        continue
      }
    }
    // **bold** / __bold__
    if ((ch === '*' || ch === '_') && s[i + 1] === ch && !isSpace(s[i + 2]) && (ch === '*' || !isWordChar(s[i - 1]))) {
      const d = ch + ch
      const j = findClose(s, d, i + 2, false)
      if (j > 0) {
        out.push({ t: 'strong', c: parseInline(s.slice(i + 2, j)) })
        i = j + 2
        continue
      }
    }
    // *italic* / _italic_
    if ((ch === '*' || ch === '_') && s[i + 1] !== ch && !isSpace(s[i + 1]) && (ch === '*' || !isWordChar(s[i - 1]))) {
      const j = findClose(s, ch, i + 1, true)
      if (j > 0) {
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, j)) })
        i = j + 1
        continue
      }
    }
    // [text](url) → "text (url)", plain text
    if (ch === '[') {
      const m = LINK_RE.exec(s.slice(i))
      if (m) {
        pushText(out, m[1] === m[2] ? m[1] : `${m[1]} (${m[2]})`)
        i += m[0].length
        continue
      }
    }
    pushText(out, ch)
    i++
  }
  return out
}

// ───────────────────────────── blocks ─────────────────────────────

const FENCE_RE = /^\s*```/
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const BULLET_RE = /^\s{0,6}[-*•]\s+(.*)$/
const NUMBER_RE = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/

/** Parse a message into blocks. Never throws; anything unknown stays text. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let cur: Block | null = null
  const close = (): void => {
    if (cur) blocks.push(cur)
    cur = null
  }

  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]

    if (FENCE_RE.test(line)) {
      close()
      const body: string[] = []
      k++
      while (k < lines.length && !FENCE_RE.test(lines[k])) body.push(lines[k++])
      blocks.push({ t: 'pre', v: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      close()
      continue
    }
    const h = HEADING_RE.exec(line)
    if (h) {
      close()
      blocks.push({ t: 'h', c: parseInline(h[1]) })
      continue
    }
    const b = BULLET_RE.exec(line)
    // a line of only "***" / "---" is a rule in markdown: keep it as text, not an empty bullet
    if (b && b[1].trim() !== '' && !/^[-*\s]+$/.test(line)) {
      const c = cur as Block | null
      if (c?.t === 'ul') c.items.push(parseInline(b[1]))
      else {
        close()
        cur = { t: 'ul', items: [parseInline(b[1])] }
      }
      continue
    }
    const n = NUMBER_RE.exec(line)
    if (n) {
      const c = cur as Block | null
      const item = { n: Number(n[1]), c: parseInline(n[2]) }
      if (c?.t === 'ol') c.items.push(item)
      else {
        close()
        cur = { t: 'ol', items: [item] }
      }
      continue
    }
    const q = QUOTE_RE.exec(line)
    if (q) {
      const c = cur as Block | null
      if (c?.t === 'quote') c.lines.push(parseInline(q[1]))
      else {
        close()
        cur = { t: 'quote', lines: [parseInline(q[1])] }
      }
      continue
    }
    // plain line: an indented line continues the last list item; otherwise a paragraph line
    const c = cur as Block | null
    if (c && (c.t === 'ul' || c.t === 'ol') && /^\s+\S/.test(line)) {
      const extra = parseInline(` ${line.trim()}`)
      if (c.t === 'ul') c.items[c.items.length - 1].push(...extra)
      else c.items[c.items.length - 1].c.push(...extra)
      continue
    }
    if (c?.t === 'p') c.lines.push(parseInline(line.trim()))
    else {
      close()
      cur = { t: 'p', lines: [parseInline(line.trim())] }
    }
  }
  close()
  return blocks
}

/** Plain text of inline nodes (copy, previews, tests). */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : inlineText(n.c))).join('')
}

/**
 * A message as plain text for the clipboard: the markup goes, the shape stays —
 * blocks separated by a blank line, "• " bullets, "n. " numbered items, code fences as
 * their raw text.
 */
export function plainText(text: string): string {
  const out: string[] = []
  for (const b of parseMarkdown(text)) {
    if (b.t === 'p') out.push(b.lines.map(inlineText).join('\n'))
    else if (b.t === 'quote') out.push(b.lines.map((l) => `> ${inlineText(l)}`).join('\n'))
    else if (b.t === 'h') out.push(inlineText(b.c))
    else if (b.t === 'ul') out.push(b.items.map((i) => `• ${inlineText(i)}`).join('\n'))
    else if (b.t === 'ol') out.push(b.items.map((i) => `${i.n}. ${inlineText(i.c)}`).join('\n'))
    else out.push(b.v)
  }
  return out.join('\n\n')
}

/** A one-line plain-text preview of a markdown-lite message (Live's coach card). */
export function plainPreview(text: string, max = 160): string {
  const parts: string[] = []
  for (const b of parseMarkdown(text)) {
    if (b.t === 'p' || b.t === 'quote') parts.push(...b.lines.map(inlineText))
    else if (b.t === 'h') parts.push(inlineText(b.c))
    else if (b.t === 'ul') parts.push(...b.items.map(inlineText))
    else if (b.t === 'ol') parts.push(...b.items.map((i) => inlineText(i.c)))
    else parts.push(b.v)
  }
  const s = parts.join(' ').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}
