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
 * Tokens are coloured with highlight.js (C for sample sources). Devicetree
 * excerpts are escaped plain text. The HTML is escaped by the highlighter
 * before it lands in the DOM.
 */

import { useEffect, useMemo, useState } from 'react'
import { excerptWindow, type LineRange } from '@/components/tour/excerpt'
import { highlightC, highlightCode, splitHighlightedLines } from '@/lib/highlight'
import { cn } from '@/lib/utils'

interface Props {
  /** Full URL of the shipped source file. Ignored when {@link text} is set. */
  src?: string
  /** Source already in hand (the running guest's .dts). */
  text?: string
  /** 1-based line the machine is stopped on. Omit when there is no stop here. */
  line?: number | null
  /** 1-based inclusive runs the step is about; may not contain {@link line}. */
  ranges?: LineRange[]
  /** Label above the excerpt, e.g. `blinky.dts`. */
  filename?: string
  /** `c` (default) colours as C; anything else is escaped plain text. */
  language?: string
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

export function SourceSnippet({
  src,
  text,
  line = null,
  ranges = [],
  filename,
  language = 'c',
}: Props) {
  const [fetched, setFetched] = useState<string[] | null>(null)

  useEffect(() => {
    if (text != null || !src) {
      setFetched(null)
      return
    }
    let live = true
    void fetchSource(src).then((result) => {
      if (live) setFetched(result)
    })
    return () => {
      live = false
    }
  }, [src, text])

  const lines = text != null ? text.split('\n') : fetched

  // Highlight the whole file once so multi-line comments / strings keep their
  // colours across the excerpt window, then index into the per-line HTML.
  const highlighted = useMemo(() => {
    if (!lines) return null
    const joined = lines.join('\n')
    const html = language === 'c' ? highlightC(joined) : highlightCode(joined, language)
    return splitHighlightedLines(html)
  }, [lines, language])

  // No snippet is a supported state — the popup's prose stands on its own.
  if (!lines || !highlighted) return null
  // A dts excerpt with no stop needs at least one highlight, or it would dump
  // the top of the tree.
  if (line == null && ranges.length === 0) return null

  const { start, end, marked } = excerptWindow(lines.length, line, ranges)

  return (
    <div className="overflow-x-auto rounded border border-border bg-muted/40">
      {filename && (
        <p className="border-b border-border/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          {filename}
        </p>
      )}
      <pre className="hljs w-max min-w-full py-1 font-mono text-[11px] leading-relaxed">
        {Array.from({ length: end - start + 1 }, (_, i) => {
          const n = start + i
          const isAnchor = line != null && n === line
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
