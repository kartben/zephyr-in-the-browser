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
 * Tokens are coloured with highlight.js: C for sample sources, devicetree for
 * the guest's .dts. The HTML is escaped by the highlighter before it lands in
 * the DOM.
 */

import { useEffect, useMemo, useState } from 'react'
import { useValueHover } from '@/components/debug/ValueHover'
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
  /** `c` (default) or `dts`; any other language is escaped plain text. */
  language?: string
  /**
   * The guest is stopped in this code: resting the pointer on a name shows its
   * value, as VS Code's debug hover does. C only.
   */
  inspectable?: boolean
}

/*
 * Cached by URL, misses included — the same shape as the .dts and catalog
 * caches. A sample's source does not change under a running guest.
 */
const cache = new Map<string, string[] | null>()

const EMPTY_HTML = { __html: '' }

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
  inspectable = false,
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

  // Memoised, so the highlight below runs once per file, not once per render.
  const lines = useMemo(() => (text != null ? text.split('\n') : fetched), [text, fetched])
  const hover = useValueHover(inspectable && language === 'c', lines)

  // Highlight the whole file once so multi-line comments / strings keep their
  // colours across the excerpt window, then index into the per-line HTML.
  const highlighted = useMemo(() => {
    if (!lines) return null
    const joined = lines.join('\n')
    const html = language === 'c' ? highlightC(joined) : highlightCode(joined, language)
    // One stable `{ __html }` per line: React re-applies dangerouslySetInnerHTML
    // whenever the object is new, which would rebuild every line's text nodes
    // on each render and drop the range a debug hover has marked in one.
    return splitHighlightedLines(html).map((line) => ({ __html: line }))
  }, [lines, language])

  // No snippet is a supported state — the popup's prose stands on its own.
  if (!lines || !highlighted) return null
  // A dts excerpt with no stop needs at least one highlight, or it would dump
  // the top of the tree.
  if (line == null && ranges.length === 0) return null

  const { runs, marked } = excerptWindow(lines.length, line, ranges)
  // Line numbers to draw, with a null for the fold between two runs: the stop
  // and the highlight were too far apart to share one window.
  const shown = runs.flatMap((run, k) => [
    ...(k > 0 ? [null] : []),
    ...Array.from({ length: run.end - run.start + 1 }, (_, i) => run.start + i),
  ])
  if (shown.length === 0) return null

  return (
    <div className="overflow-x-auto rounded border border-border bg-muted/40">
      {filename && (
        <p className="border-b border-border/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {filename}
        </p>
      )}
      <pre
        className="hljs w-max min-w-full py-1 font-mono text-[12px] leading-[18px]"
        onPointerMove={hover.onPointerMove}
        onPointerLeave={hover.onPointerLeave}
      >
        {shown.map((n, i) => {
          if (n === null) {
            const from = shown[i - 1]! + 1
            const to = shown[i + 1]! - 1
            return (
              <div
                key={`fold-${from}`}
                className="flex select-none px-1 text-muted-foreground"
                title={`Lines ${from} to ${to} are not shown`}
              >
                <span className="sticky left-0 w-10 shrink-0 bg-muted/40 pr-2 text-right">⋯</span>
                <span className="italic">{to - from + 1} lines</span>
              </div>
            )
          }
          const isAnchor = line != null && n === line
          const isMarked = marked(n)
          return (
            <div
              key={n}
              data-line={n}
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
                    ? 'text-primary-text'
                    : isMarked
                      ? 'text-amber-800 dark:text-amber-400'
                      : 'text-muted-foreground',
                )}
                title={isAnchor ? 'the machine is stopped here' : undefined}
              >
                {isAnchor ? '▸ ' : '  '}
                {n}
              </span>
              <code dangerouslySetInnerHTML={highlighted[n - 1] ?? EMPTY_HTML} />
            </div>
          )
        })}
      </pre>
      {hover.popup}
    </div>
  )
}
