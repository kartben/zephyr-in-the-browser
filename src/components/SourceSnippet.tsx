/**
 * The few lines of C a tour step is stopped on.
 *
 * The build ships each toured sample's sources beside its ELF, copied verbatim
 * — the line the step resolved to came out of that build's own DWARF, so the
 * two agree by construction rather than by a convention someone has to keep.
 *
 * Tokens are coloured with highlight.js (C only); the HTML is escaped by the
 * highlighter before it lands in the DOM.
 */

import { useEffect, useMemo, useState } from 'react'
import { highlightC, splitHighlightedLines } from '@/lib/highlight'
import { cn } from '@/lib/utils'

/** Lines of context either side of the highlighted range. */
const CONTEXT = 5

/**
 * Cap on the excerpt. A `show:` range is authored, so it can be as wrong as any
 * other authored thing — `/pattern/../pattern/` whose end never matches near
 * the start would otherwise paste a whole file into a popup.
 */
const MAX_LINES = 40

interface Props {
  /** Full URL of the shipped source file. */
  src: string
  /** 1-based first and last line to highlight, inclusive. */
  start: number
  end: number
  /** Why these lines, when the step said. */
  note?: string | null
}

/*
 * Cached by URL, misses included — the same shape as the .dts and catalog
 * caches. A sample's source does not change under a running guest.
 */
const cache = new Map<string, string[] | null>()

async function fetchSource(url: string): Promise<string[] | null> {
  const cached = cache.get(url)
  if (cached !== undefined) return cached
  let lines: string[] | null = null
  try {
    const res = await fetch(url)
    // Vite and GitHub Pages both answer an unknown path with index.html and a
    // 200, so without this the snippet renders an HTML shell as C.
    if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) {
      const text = await res.text()
      if (!text.trimStart().startsWith('<')) lines = text.split('\n')
    }
  } catch {
    // Absence reads the same as a network failure: show no snippet.
  }
  cache.set(url, lines)
  return lines
}

export function SourceSnippet({ src, start: first, end: last, note }: Props) {
  const [lines, setLines] = useState<string[] | null>(null)

  useEffect(() => {
    let live = true
    void fetchSource(src).then((result) => {
      if (live) setLines(result)
    })
    return () => {
      live = false
    }
  }, [src])

  // Highlight the whole file once so multi-line comments / strings keep their
  // colours across the excerpt window, then index into the per-line HTML.
  const highlighted = useMemo(
    () => (lines ? splitHighlightedLines(highlightC(lines.join('\n'))) : null),
    [lines],
  )

  // No snippet is a supported state — the popup's prose stands on its own.
  if (!lines || !highlighted) return null

  // The window follows the range rather than a fixed span around one line, so
  // a two-line `show:` still gets its context and a twenty-line one still fits.
  const marked = { first: Math.max(1, first), last: Math.min(lines.length, Math.max(first, last)) }
  const span = marked.last - marked.first + 1
  const context = Math.max(0, Math.min(CONTEXT, Math.floor((MAX_LINES - span) / 2)))
  const from = Math.max(1, marked.first - context)
  const to = Math.min(lines.length, Math.max(marked.last + context, from + MAX_LINES - 1))

  return (
    <div className="overflow-hidden rounded border border-border bg-muted/40">
      <div className="overflow-x-auto">
        <pre className="hljs w-max min-w-full py-1 font-mono text-[11px] leading-relaxed">
          {Array.from({ length: to - from + 1 }, (_, i) => {
            const n = from + i
            const isMarked = n >= marked.first && n <= marked.last
            return (
              <div key={n} className={cn('flex whitespace-pre px-1', isMarked && 'bg-primary/15')}>
                <span
                  className={cn(
                    'sticky left-0 w-8 shrink-0 select-none bg-muted/40 pr-2 text-right tabular-nums',
                    isMarked ? 'text-primary' : 'text-muted-foreground/60',
                  )}
                >
                  {n}
                </span>
                <code dangerouslySetInnerHTML={{ __html: highlighted[n - 1] ?? '' }} />
              </div>
            )
          })}
        </pre>
      </div>
      {note && (
        <p className="border-t border-border/60 px-2 py-1 text-[10.5px] text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  )
}
