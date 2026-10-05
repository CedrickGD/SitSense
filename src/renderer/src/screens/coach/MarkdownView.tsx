// Renders the markdown-lite AST (markdown.ts) as React elements (ui-v3.md §4.3).
// Only text nodes and fixed elements — model output can never inject markup or links.

import { Fragment, useMemo, type JSX, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from './markdown'

function renderInline(nodes: readonly Inline[], keyPrefix = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`
    switch (n.t) {
      case 'text':
        return <Fragment key={key}>{n.v}</Fragment>
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-text">
            {renderInline(n.c, `${key}.`)}
          </strong>
        )
      case 'em':
        return (
          <em key={key} className="italic">
            {renderInline(n.c, `${key}.`)}
          </em>
        )
      case 'code':
        return (
          <code key={key} className="rounded-[4px] bg-white/[0.06] px-1 py-px font-mono text-[12px] text-text">
            {n.v}
          </code>
        )
    }
  })
}

function lines(ls: readonly Inline[][]): ReactNode[] {
  return ls.flatMap((l, i) => (i === 0 ? renderInline(l, `${i}:`) : [<br key={`br${i}`} />, ...renderInline(l, `${i}:`)]))
}

function renderBlock(b: Block, i: number): JSX.Element {
  switch (b.t) {
    case 'p':
      return <p key={i}>{lines(b.lines)}</p>
    case 'h':
      return (
        <p key={i} className="font-semibold text-text">
          {renderInline(b.c)}
        </p>
      )
    case 'ul':
      return (
        <ul key={i} className="flex flex-col gap-1.5">
          {b.items.map((it, k) => (
            <li key={k} className="flex gap-2 pl-2">
              <span aria-hidden className="mt-[8.5px] h-1 w-1 shrink-0 rounded-full bg-sage" />
              <span className="min-w-0">{renderInline(it)}</span>
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={i} className="flex flex-col gap-1.5">
          {b.items.map((it, k) => (
            <li key={k} className="flex gap-2 pl-2">
              <span aria-hidden className="min-w-4 shrink-0 font-mono text-[12px] leading-[21px] text-text-dim tabular-nums">
                {it.n}.
              </span>
              <span className="min-w-0">{renderInline(it.c)}</span>
            </li>
          ))}
        </ol>
      )
    case 'quote':
      return (
        <blockquote key={i} className="border-l-2 border-white/10 pl-3 text-text-dim">
          {lines(b.lines)}
        </blockquote>
      )
    case 'pre':
      return (
        <pre key={i} className="overflow-x-auto rounded-lg bg-ink px-3 py-2.5 font-mono text-[12px] leading-[18px] text-text-dim ring-1 ring-white/[0.06]">
          {b.v}
        </pre>
      )
  }
}

/** A coach message body: body-lg, 12 px between blocks. */
export function Markdown({ text, className = '' }: { text: string; className?: string }): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className={`flex min-w-0 flex-col gap-3 break-words ${className}`}>{blocks.map(renderBlock)}</div>
}
