/**
 * The source file a tour step is about, opened on the lines it is about.
 *
 * Two different things are marked, because they answer two different questions.
 * The **stop line** is where the machine is right now — one line, with a marker
 * in the gutter. The **highlight** is what the step is *pointing at*, which is
 * often several lines and often not the same place: a declaration whose use is
 * further down, the whole of an `if`, the body of a loop. A step that stops on
 * `gpio_pin_configure_dt()` may be talking about the three lines above it.
 *
 * The code shares the card with the prose, so the window on it stays short, and
 * opens on what the step is about (tour/SourceWindow.tsx). The rest of the file
 * is a scroll away, and the file's name opens all of it in a popup. A step the
 * guest does not stop on starts as one row.
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
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useValueHover } from '@/components/debug/ValueHover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { LineRange } from '@/components/tour/excerpt'
import { SourceWindow } from '@/components/tour/SourceWindow'
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

/** Keyboard focus on the row, drawn inside it: the rounded box clips anything outside. */
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
  // Whether a running step's code is open. Each step starts with it shut.
  const [shown, setShown] = useState(false)

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
  // colours across lines, then index into the per-line HTML.
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

  // A file ending in a newline has no line after it.
  const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  if (lineCount === 0) return null

  const running = stop === 'none'
  const file = filename ?? (src ? baseName(src) : null)
  const name = label ?? [file, line].filter(Boolean).join(':')

  const windowProps = { html: highlighted, lineCount, line, ranges, stop, name: file ?? name, hover }
  // The file's name, and what it opens: more room than the card can give.
  const fileName = file && (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          title="Open the whole file"
          className={cn(
            'rounded-sm text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:text-primary-text hover:decoration-current',
            FOCUS_RING,
          )}
        >
          {file}
        </button>
      </DialogTrigger>
      <DialogContent
        className="h-[85vh] max-w-5xl overflow-hidden"
        // The value hover sits outside the dialog: using it does not close it.
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target
          if (target instanceof Node && document.getElementById('value-hover')?.contains(target)) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader className="flex flex-row items-baseline gap-2 space-y-0 border-b border-border py-2.5 pl-4 pr-10">
          <DialogTitle className="font-mono text-[13px]">{file}</DialogTitle>
          <DialogDescription className="sr-only">The whole file</DialogDescription>
        </DialogHeader>
        <SourceWindow {...windowProps} fill />
      </DialogContent>
    </Dialog>
  )

  return (
    <div className="overflow-hidden rounded border border-border bg-code-surface">
      {running ? (
        <div className={cn('flex items-center', shown && 'border-b border-border/60')}>
          {/* The guest did not wait here, and the step is about something else:
              the code is there for the asking, in one quiet row. */}
          <button
            type="button"
            aria-expanded={shown}
            onClick={() => setShown(!shown)}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground',
              FOCUS_RING,
            )}
          >
            {shown ? (
              <ChevronDown className="size-3 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="size-3 shrink-0" aria-hidden />
            )}
            {shown ? 'Hide' : 'Show'} {name}
          </button>
          {fileName && <p className="shrink-0 px-2 font-mono text-[11px]">{fileName}</p>}
        </div>
      ) : (
        fileName && (
          <p className="relative z-20 border-b border-border/60 bg-code-surface px-2 py-0.5 font-mono text-[11px]">
            {fileName}
          </p>
        )
      )}
      {(!running || shown) && <SourceWindow {...windowProps} />}
      {hover.popup}
    </div>
  )
}
