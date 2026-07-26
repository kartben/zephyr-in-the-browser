/**
 * The Markdown subset annotation bodies are written in.
 *
 * Annotations are prose about code, so they want inline `code`, emphasis,
 * links to the Zephyr docs, lists and the occasional fenced block — and
 * nothing else. That is a small enough grammar to parse here rather than take
 * a dependency, which is also how DtsViewer handles its value tinting.
 *
 * The output is a tree the card renders as React elements. Nothing here ever
 * produces an HTML string, so there is no `dangerouslySetInnerHTML` on the
 * other end and no sanitiser to get wrong: markup in a body is text, because
 * text is the only thing this can emit. Link hrefs are the one exception —
 * they do reach the DOM — so the scheme is checked.
 *
 * Pure and DOM-free, so vitest covers it under `environment: 'node'`.
 */

export interface TextSpan {
  kind: 'text'
  text: string
}

export interface CodeSpan {
  kind: 'code'
  text: string
}

export interface StrongSpan {
  kind: 'strong'
  text: string
}

export interface EmphasisSpan {
  kind: 'em'
  text: string
}

export interface LinkSpan {
  kind: 'link'
  text: string
  href: string
}

export type InlineSpan = TextSpan | CodeSpan | StrongSpan | EmphasisSpan | LinkSpan

export interface ParagraphBlock {
  kind: 'paragraph'
  spans: InlineSpan[]
}

export interface ListBlock {
  kind: 'list'
  items: InlineSpan[][]
}

export interface CodeBlock {
  kind: 'codeblock'
  /** Info string from the fence, e.g. `c`. Empty when the fence had none. */
  language: string
  text: string
}

export type MarkdownBlock = ParagraphBlock | ListBlock | CodeBlock

/**
 * Schemes a link may use.
 *
 * Bodies come from the repo, not from users, so this is defence in depth
 * rather than the thing standing between us and a hostile input — but an href
 * is the only value here that the browser will act on, so it gets checked.
 */
const SAFE_SCHEME = /^(?:https?:\/\/|mailto:|#|\/)/i

/*
 * One pass, longest-marker-first so `**` is not mistaken for two `*`. Inline
 * code wins over everything: backticks are how an annotation quotes an API,
 * and `*` inside `k_msleep(*)` must stay literal.
 */
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/

function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  let rest = text

  const pushText = (value: string) => {
    if (!value) return
    const last = spans[spans.length - 1]
    if (last?.kind === 'text') last.text += value
    else spans.push({ kind: 'text', text: value })
  }

  while (rest) {
    const match = INLINE_RE.exec(rest)
    if (!match || match.index === undefined) break

    pushText(rest.slice(0, match.index))
    const token = match[0]
    rest = rest.slice(match.index + token.length)

    if (token.startsWith('`')) {
      spans.push({ kind: 'code', text: token.slice(1, -1) })
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = token.slice(split + 2, -1)
      // An unusable scheme degrades to the label plus the raw target, so the
      // reader still sees where it was meant to point.
      if (SAFE_SCHEME.test(href)) spans.push({ kind: 'link', text: label, href })
      else pushText(`${label} (${href})`)
    } else if (token.startsWith('**')) {
      spans.push({ kind: 'strong', text: token.slice(2, -2) })
    } else {
      spans.push({ kind: 'em', text: token.slice(1, -1) })
    }
  }

  pushText(rest)
  return spans
}

/**
 * Parse an annotation body into blocks.
 *
 * Deliberately line-oriented: blank lines separate paragraphs, ``` fences a
 * code block, and a run of `- ` lines is a list. Anything a sample author
 * reaches for beyond that is a sign the annotation is too long for a popup.
 */
export function parseMarkdown(body: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = body.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    if (line.trimStart().startsWith('```')) {
      const language = line.trimStart().slice(3).trim()
      const collected: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        collected.push(lines[i])
        i++
      }
      i++ // closing fence, or end of input
      blocks.push({ kind: 'codeblock', language, text: collected.join('\n') })
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: InlineSpan[][] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*[-*]\s+/, '')))
        i++
      }
      blocks.push({ kind: 'list', items })
      continue
    }

    // A paragraph runs to the next blank line; newlines inside it are soft, so
    // an author can wrap a comment at 80 columns without forcing line breaks.
    const collected: string[] = []
    while (i < lines.length && lines[i].trim() && !lines[i].trimStart().startsWith('```') &&
           !/^\s*[-*]\s+/.test(lines[i])) {
      collected.push(lines[i].trim())
      i++
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(collected.join(' ')) })
  }

  return blocks
}
