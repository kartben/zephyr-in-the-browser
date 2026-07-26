/**
 * The few lines of C an annotation is pointing at.
 *
 * The build ships each annotated sample's sources beside its ELF — the
 * *stripped* copies, with the `@annotate` blocks removed, so what the reader
 * sees is the code rather than the prose they are already reading above it.
 * Line numbers in the catalog are in those same stripped coordinates.
 *
 * The SAMPLE_SHOW*() calls stay, dimmed: they are real executable code, and
 * seeing how an annotation is wired is part of the lesson.
 *
 * Tokens are coloured with highlight.js (C only); the HTML is escaped by the
 * highlighter before it lands in the DOM.
 */

import { useEffect, useMemo, useState } from 'react'
import { highlightC, splitHighlightedLines } from '@/lib/highlight'
import { cn } from '@/lib/utils'

/** Lines of context either side of the anchor. */
const CONTEXT = 5

interface Props {
  /** Full URL of the shipped source file. */
  src: string
  /** 1-based line the annotation points at. */
  line: number
  /** 1-based lines holding the macro calls that fire it. */
  fireLines?: number[]
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

export function SourceSnippet({ src, line, fireLines = [] }: Props) {
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

  const start = Math.max(1, line - CONTEXT)
  const end = Math.min(lines.length, line + CONTEXT)
  const fire = new Set(fireLines)

  return (
    <div className="overflow-x-auto rounded border border-border bg-muted/40">
      <pre className="hljs w-max min-w-full py-1 font-mono text-[11px] leading-relaxed">
        {Array.from({ length: end - start + 1 }, (_, i) => {
          const n = start + i
          const isAnchor = n === line
          return (
            <div
              key={n}
              className={cn(
                'flex whitespace-pre px-1',
                isAnchor && 'bg-primary/15',
                !isAnchor && fire.has(n) && 'opacity-45',
              )}
            >
              <span
                className={cn(
                  'sticky left-0 w-8 shrink-0 select-none bg-muted/40 pr-2 text-right tabular-nums',
                  isAnchor ? 'text-primary' : 'text-muted-foreground/60',
                )}
              >
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
