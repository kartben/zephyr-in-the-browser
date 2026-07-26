/**
 * Renders the Markdown subset annotation bodies are written in.
 *
 * Every node here is a React element built from a parsed tree — no HTML string
 * is ever produced from author markup, so there is nothing to sanitise and
 * markup inside a body is text by construction. Fenced C blocks are the one
 * exception: highlight.js emits escaped HTML spans for tokens. See
 * src/annotations/markdown.ts for the grammar.
 */

import { parseMarkdown, type InlineSpan, type MarkdownBlock } from '@/annotations/markdown'
import { highlightCode, isCLanguage } from '@/lib/highlight'

function Spans({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'code':
            return (
              <code
                key={i}
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground"
              >
                {span.text}
              </code>
            )
          case 'strong':
            return (
              <strong key={i} className="font-semibold text-foreground">
                {span.text}
              </strong>
            )
          case 'em':
            return (
              <em key={i} className="italic">
                {span.text}
              </em>
            )
          case 'link':
            return (
              <a
                key={i}
                href={span.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary underline underline-offset-2 hover:no-underline"
              >
                {span.text}
              </a>
            )
          default:
            return <span key={i}>{span.text}</span>
        }
      })}
    </>
  )
}

function CodeBlockView({ language, text }: { language: string; text: string }) {
  const html = highlightCode(text, language)
  return (
    <pre
      className="overflow-x-auto rounded border border-border bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-foreground"
      data-language={language || undefined}
    >
      <code
        className={isCLanguage(language) ? 'language-c hljs' : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  )
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case 'list':
      return (
        <ul className="list-disc space-y-1 pl-4">
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      )
    case 'codeblock':
      return <CodeBlockView language={block.language} text={block.text} />
    default:
      return (
        <p>
          <Spans spans={block.spans} />
        </p>
      )
  }
}

/**
 * One line of Markdown with no block structure — for a heading, where an author
 * naturally writes `main()` in backticks and would otherwise see them rendered.
 */
export function InlineMarkdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text)
  const first = blocks[0]
  if (!first || first.kind !== 'paragraph') return <>{text}</>
  return <Spans spans={first.spans} />
}

export function Markdown({ body, className }: { body: string; className?: string }) {
  const blocks = parseMarkdown(body)
  if (blocks.length === 0) return null
  return (
    <div className={className}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  )
}
