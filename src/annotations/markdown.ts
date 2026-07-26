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
  language: string
  text: string
}

export type MarkdownBlock = ParagraphBlock | ListBlock | CodeBlock

// Link hrefs are the only parsed values the browser acts on.
const SAFE_SCHEME = /^(?:https?:\/\/|mailto:|#|\/)/i

// Inline code wins over emphasis so `*` inside APIs stays literal.
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
