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
 * The excerpt shares the card with the prose, so it stays short and the reader
 * opens the rest: the lines between two far-apart runs fold into a row that
 * unfolds in place, and a step the guest does not stop on starts as one row.
 *
 * The build ships each toured sample's sources beside its ELF, copied verbatim
 * — the line the step resolved to came out of that build's own DWARF, so the
 * two agree by construction rather than by a convention someone has to keep.
 *
 * Tokens are coloured with highlight.js: C for sample sources, devicetree for
 * the guest's .dts. The HTML is escaped by the highlighter before it lands in
 * the DOM.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useValueHover } from '@/components/debug/ValueHover'
import { excerptRows, excerptWindow, type LineRange } from '@/components/tour/excerpt'
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
  /**
   * How the guest stands with {@link line}. `here` (the default): it is
   * stopped on it, under the card, and the gutter says so. `earlier`: a step
   * read again, which stopped there before the guest moved on, so the marker
   * stays and its tooltip says when. `none`: a `stop: no` step, whose guest
   * ran on without waiting. There is no stop to mark, and the step is about
   * something else (often the Trace view it points at), so the excerpt starts
   * folded to one row naming the line, and opens when the reader asks.
   */
  stop?: 'here' | 'earlier' | 'none'
  /** What that folded row calls the code, such as `main.c:207`. */
  label?: string
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

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Fades the excerpt out over the last few characters before its right edge. */
const FADE_RIGHT: CSSProperties = {
  maskImage: 'linear-gradient(to right, #000 calc(100% - 1.5rem), transparent)',
}

/**
 * Whether a line runs on past the excerpt's right edge, for a fade there. Code
 * scrolls sideways rather than wrapping, but the scrollbar is an overlay that
 * only shows while scrolling, so without the fade a long comment is cut
 * mid-word with nothing to say it goes on. The listing inside the scroller is
 * watched too: opening a fold can bring in a longer line.
 */
function useOverflowRight() {
  const [more, setMore] = useState(false)
  const measure = useCallback((el: HTMLElement) => {
    setMore(el.scrollWidth - el.scrollLeft - el.clientWidth > 1)
  }, [])
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(() => measure(el))
      observer.observe(el)
      if (el.firstElementChild) observer.observe(el.firstElementChild)
      return () => observer.disconnect()
    },
    [measure],
  )
  const onScroll = (event: { currentTarget: HTMLElement }) => measure(event.currentTarget)
  return { ref, more, onScroll }
}

/** Keyboard focus on a row, drawn inside it: the scroller clips anything outside. */
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

export function SourceSnippet({
  src,
  text,
  line = null,
  ranges = [],
  filename,
  language = 'c',
  inspectable = false,
  stop = 'here',
  label,
}: Props) {
  // A file fetched before draws on the first render: each step mounts its own
  // excerpt, and a frame without one would make the card jump.
  const [fetched, setFetched] = useState<string[] | null>(() =>
    text == null && src ? (cache.get(src) ?? null) : null,
  )
  // The folds the reader opened, by first line, and whether a running step's
  // excerpt is open. Each step starts with both shut.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  const [shown, setShown] = useState(false)
  const overflow = useOverflowRight()

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
  // The lines to draw, with a fold row where the stop and the highlight were
  // too far apart to share one window.
  const rows = excerptRows(runs, open)
  if (rows.length === 0) return null

  const running = stop === 'none'
  const name = label ?? [filename ?? (src ? baseName(src) : null), line].filter(Boolean).join(':')
  const toggleFold = (from: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(from)) next.add(from)
      return next
    })

  return (
    <div className="overflow-hidden rounded border border-border bg-muted/40">
      {running ? (
        // The guest did not wait here, and the step is about something else:
        // the code is there for the asking, in one quiet row.
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => setShown(!shown)}
          className={cn(
            'flex w-full items-center gap-1 px-2 py-1 text-left font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground',
            FOCUS_RING,
            shown && 'border-b border-border/60',
          )}
        >
          {shown ? (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          )}
          {shown ? 'Hide' : 'Show'} {name}
        </button>
      ) : (
        filename && (
          <p className="border-b border-border/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {filename}
          </p>
        )
      )}
      {(!running || shown) && (
        <div
          ref={overflow.ref}
          onScroll={overflow.onScroll}
          className="overflow-x-auto"
          style={overflow.more ? FADE_RIGHT : undefined}
        >
          <pre
            className="hljs w-max min-w-full py-1 font-mono text-[12px] leading-[18px]"
            onPointerMove={hover.onPointerMove}
            onPointerLeave={hover.onPointerLeave}
          >
            {rows.map((row) => {
              if (row.kind === 'fold') {
                const { from, to } = row
                // The lines between two runs, unfolded in place. The row stays
                // above them, so the same press folds them away again.
                return (
                  <button
                    key={`fold-${from}`}
                    type="button"
                    aria-expanded={row.open}
                    onClick={() => toggleFold(from)}
                    className={cn(
                      'group flex w-full select-none px-1 text-left text-primary-text hover:bg-primary/10',
                      FOCUS_RING,
                    )}
                  >
                    <span
                      aria-hidden
                      className="sticky left-0 w-10 shrink-0 bg-muted/40 pr-2 text-right text-muted-foreground"
                    >
                      ⋯
                    </span>
                    <span className="font-sans text-[11px] group-hover:underline">
                      {row.open ? 'Hide' : 'Show'} lines {from} to {to}
                    </span>
                  </button>
                )
              }
              const n = row.line
              // Only a stop the guest made is marked: on a running step the
              // line is just where the step fired.
              const isAnchor = !running && line != null && n === line
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
                    title={
                      isAnchor
                        ? stop === 'here'
                          ? 'the machine is stopped here'
                          : 'the machine stopped here on this step'
                        : undefined
                    }
                  >
                    {isAnchor ? '▸ ' : '  '}
                    {n}
                  </span>
                  <code dangerouslySetInnerHTML={highlighted[n - 1] ?? EMPTY_HTML} />
                </div>
              )
            })}
          </pre>
        </div>
      )}
      {hover.popup}
    </div>
  )
}
