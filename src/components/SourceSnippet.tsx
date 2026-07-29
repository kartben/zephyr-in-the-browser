/**
 * The few lines of C a tour step is about.
 *
 * Two different things are marked, because they answer two different questions.
 * The **stop line** is where the machine is right now — one line, with a marker
 * in the gutter. The **highlight** is what the step is *pointing at*, which is
 * often several lines and often not the same place: a declaration whose use is
 * further down, the whole of an `if`, the body of a loop. A step that stops on
 * `gpio_pin_configure_dt()` may be talking about the three lines above it.
 *
 * The build ships each toured sample's sources beside its ELF, copied verbatim
 * — the line the step resolved to came out of that build's own DWARF, so the
 * two agree by construction rather than by a convention someone has to keep.
 *
 * Tokens are coloured with highlight.js (C only); the HTML is escaped by the
 * highlighter before it lands in the DOM.
 */

import { useEffect, useMemo, useState } from 'react'
import { excerptWindow, type LineRange } from '@/components/tour/excerpt'
import { highlightC, splitHighlightedLines } from '@/lib/highlight'
import { cn } from '@/lib/utils'

interface Props {
  /** Full URL of the shipped source file. */
  src: string
  /** 1-based line the machine is stopped on. */
  line: number
  /** 1-based inclusive runs the step is about; may not contain {@link line}. */
  ranges?: LineRange[]
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

export function SourceSnippet({ src, line, ranges = [] }: Props) {
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

  const { start, end, marked } = excerptWindow(lines.length, line, ranges)

  return (
    <div className="overflow-x-auto rounded border border-border bg-muted/40">
      <pre className="hljs w-max min-w-full py-1 font-mono text-[11px] leading-relaxed">
        {Array.from({ length: end - start + 1 }, (_, i) => {
          const n = start + i
          const isAnchor = n === line
          const isMarked = marked(n)
          return (
            <div
              key={n}
              className={cn(
                'flex whitespace-pre px-1',
                // Two marks, deliberately different: the stop is a moment, the
                // highlight is a subject.
                isMarked && 'bg-amber-400/12 dark:bg-amber-300/10',
                isAnchor && 'bg-primary/15',
              )}
            >
              <span
                className={cn(
                  'sticky left-0 w-10 shrink-0 select-none bg-muted/40 pr-2 text-right tabular-nums',
                  isAnchor
                    ? 'text-primary'
                    : isMarked
                      ? 'text-amber-600/90 dark:text-amber-400/80'
                      : 'text-muted-foreground/60',
                )}
                title={isAnchor ? 'the machine is stopped here' : undefined}
              >
                {isAnchor ? '▸ ' : '  '}
                {n}
              </span>
              <code
                dangerouslySetInnerHTML={{ __html: highlighted[n - 1] ?? '' }}
              />
            </div>
          )
        })}
      </pre>
    </div>
  )
}
