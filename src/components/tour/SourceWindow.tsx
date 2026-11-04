/**
 * A window on a whole source file, opened on the lines a tour step is about.
 *
 * Every line is one scroll away, and the lines the step marks stay readable
 * while the reader is elsewhere in the file: once they scroll out, they pin to
 * the edge they left by, with the lines around them, and pressing one goes back
 * to it. `⋯` stands between lines that do not follow each other.
 *
 * The pins and the rail float over the scroller rather than sitting inside it,
 * so the window takes the wheel over them, and Page Down measures a page by the
 * code they leave free. What to pin and where to land is worked out in
 * tour/excerpt.ts; this draws it and takes the input.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ROW_PX,
  SKIP_PX,
  excerptWindow,
  openingRows,
  openingScroll,
  pageScroll,
  pinBlocks,
  pinLayout,
  type LineRange,
  type PinLayout,
} from '@/components/tour/excerpt'
import { cn } from '@/lib/utils'

type Html = { __html: string }

interface Props {
  /** One stable `{ __html }` per line of the file. */
  html: Html[]
  lineCount: number
  /** 1-based line the machine is at. Omit when there is no stop here. */
  line: number | null
  ranges: LineRange[]
  /** The stop, as {@link SourceSnippet} describes it. `none` marks nothing. */
  stop: 'here' | 'earlier' | 'none'
  /** What the window shows, for assistive tech, such as `main.c`. */
  name: string
  /**
   * The full-file popup: take the height of a flex parent, with no handle, and
   * show the file straight through. Pins make room in a small window; here they
   * would only hide lines of the file the reader asked to see.
   */
  fill?: boolean
  hover: {
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerLeave: () => void
  }
}

/** The handle along the window's bottom edge. */
const GRIP_PX = 7
const MIN_VIEW_ROWS = 8
const MAX_VIEW_ROWS = 34
const MIN_THUMB_PX = 20
/** How near a mark on the rail a press has to be to mean the mark: they are a few pixels tall. */
const MARK_REACH_PX = 4

/**
 * The height the reader dragged the window to. Each step mounts its own window,
 * and asking for more room is not about one step, so it outlives them.
 */
let chosenViewPx: number | null = null

const NOTHING_PINNED: PinLayout = {
  above: [],
  below: [],
  skipAbove: false,
  skipBelow: false,
  topPx: 0,
  bottomPx: 0,
}

/** Fades the code out over the last few characters before its right edge. */
const FADE_RIGHT: CSSProperties = {
  maskImage: 'linear-gradient(to right, #000 calc(100% - 1.5rem), transparent)',
}

/** Keyboard focus, drawn inside the element: the window clips anything outside. */
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

/**
 * Whether a line runs on past the listing's right edge, for a fade there. Code
 * scrolls sideways rather than wrapping, but the scrollbar is an overlay that
 * only shows while scrolling, so without the fade a long comment is cut
 * mid-word with nothing to say it goes on.
 */
function useOverflowRight() {
  const [more, setMore] = useState(false)
  const measure = useCallback((el: HTMLElement) => {
    setMore(el.scrollWidth - el.scrollLeft - el.clientWidth > 1)
  }, [])
  return { more, measure }
}

interface RowProps {
  n: number
  html: Html | undefined
  anchor: boolean
  marked: boolean
  stop: Props['stop']
  /** Inside a pin, whose button cannot hold a `div`. */
  pinned?: boolean
}

const CodeRow = memo(function CodeRow({ n, html, anchor, marked, stop, pinned = false }: RowProps) {
  const Row = pinned ? 'span' : 'div'
  return (
    <Row
      data-line={n}
      className={cn(
        'code-row flex whitespace-pre px-1',
        // Two marks, deliberately different: the stop is a moment, the
        // highlight is a subject.
        marked && 'code-row-mark',
        anchor && 'code-row-stop',
      )}
    >
      <span
        className={cn(
          'code-gutter sticky left-0 z-[1] w-10 shrink-0 select-none pr-2 text-right tabular-nums',
          anchor
            ? 'text-primary-text'
            : marked
              ? 'text-amber-800 dark:text-amber-400'
              : 'text-muted-foreground',
        )}
        title={
          anchor
            ? stop === 'here'
              ? 'the machine is stopped here'
              : 'the machine stopped here on this step'
            : undefined
        }
      >
        {anchor ? '▸ ' : '  '}
        {n}
      </span>
      <code
        className={pinned ? 'block [transform:translateX(calc(var(--code-sx,0)*-1px))]' : undefined}
        dangerouslySetInnerHTML={html ?? EMPTY_HTML}
      />
    </Row>
  )
})

const EMPTY_HTML: Html = { __html: '' }

/** Lines that do not follow each other, as the fold rows of a diff say it. */
function Skip() {
  return (
    <span
      aria-hidden
      className="flex shrink-0 select-none items-center px-1 text-muted-foreground"
      style={{ height: SKIP_PX }}
    >
      <span className="w-10 shrink-0 pr-2 text-right text-[11px] leading-[12px]">⋯</span>
      <span className="flex-1 border-t border-dashed border-foreground/25" />
    </span>
  )
}

export function SourceWindow({ html, lineCount, line, ranges, stop, name, fill = false, hover }: Props) {
  // Ranges are often a fresh array with the same lines in it, and the card
  // renders on every guest update: what follows from them must not.
  const rangesKey = JSON.stringify(ranges)
  const running = stop === 'none'
  const stopLine = running ? null : line
  const { marked, blocks, marks } = useMemo(() => {
    const parsed = JSON.parse(rangesKey) as LineRange[]
    return {
      marked: excerptWindow(lineCount, line, parsed).marked,
      blocks: fill ? [] : pinBlocks(lineCount, stopLine, parsed),
      marks: [
        ...parsed.filter((r) => r.end >= r.start && r.start >= 1),
        ...(stopLine === null ? [] : [{ start: stopLine, end: stopLine }]),
      ],
    }
  }, [rangesKey, lineCount, line, stopLine, fill])

  const maxViewPx = Math.min(lineCount, MAX_VIEW_ROWS) * ROW_PX
  const minViewPx = Math.min(lineCount, MIN_VIEW_ROWS) * ROW_PX
  const fit = useCallback(
    (px: number) => Math.min(maxViewPx, Math.max(minViewPx, px)),
    [maxViewPx, minViewPx],
  )
  const [viewPx, setViewPx] = useState(() =>
    fit(chosenViewPx ?? openingRows(lineCount, line, JSON.parse(rangesKey) as LineRange[]) * ROW_PX),
  )

  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const [pins, setPins] = useState<PinLayout>(NOTHING_PINNED)
  const { more, measure } = useOverflowRight()

  /** Everything that follows the scroll position, without redrawing the listing for it. */
  const sync = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const next = pinLayout(blocks, el.scrollTop, el.clientHeight, stopLine)
    setPins((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    measure(el)
    root.current?.style.setProperty('--code-sx', String(el.scrollLeft))
    const track = rail.current
    if (thumb.current && track) {
      const span = track.clientHeight
      const height = Math.max(MIN_THUMB_PX, (el.clientHeight / (el.scrollHeight || 1)) * span)
      const maxTop = el.scrollHeight - el.clientHeight
      thumb.current.style.height = `${height}px`
      thumb.current.style.top = `${(maxTop > 0 ? el.scrollTop / maxTop : 0) * (span - height)}px`
    }
  }, [blocks, stopLine, measure])

  // Open on what the step is about. Before paint, so the top of the file never
  // flashes by. Only when the step's lines change: the card renders constantly.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = openingScroll(lineCount, line, JSON.parse(rangesKey) as LineRange[], el.clientHeight, blocks)
    sync()
  }, [lineCount, line, rangesKey, blocks, sync])

  useLayoutEffect(sync, [viewPx, sync])

  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [sync])

  // A wheel over the pins or the rail is a wheel over the window. Not a React
  // handler: those are passive, and this one has to keep the page still.
  useEffect(() => {
    const host = root.current
    const el = scroller.current
    if (!host || !el) return
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Node && el.contains(event.target)) return
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? ROW_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? el.clientHeight
            : 1
      const dy = event.deltaY * unit
      const dx = event.deltaX * unit
      const canY = dy < 0 ? el.scrollTop > 0 : dy > 0 && el.scrollTop < el.scrollHeight - el.clientHeight - 1
      const canX = dx < 0 ? el.scrollLeft > 0 : dx > 0 && el.scrollLeft < el.scrollWidth - el.clientWidth - 1
      // At the end of the file, it is the card's or the page's to take.
      if (!canY && !canX) return
      event.preventDefault()
      el.scrollTop += dy
      el.scrollLeft += dx
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [])

  const jump = useCallback((n: number) => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = (n - 1) * ROW_PX - el.clientHeight / 2 + ROW_PX / 2
    // The row pressed may be gone once it has scrolled home: keep the keyboard
    // in the code, where the arrows still mean something.
    el.focus({ preventScroll: true })
    const row = el.querySelector<HTMLElement>(`[data-line="${n}"]`)
    if (!row) return
    row.classList.remove('code-row-flash')
    void row.offsetWidth
    row.classList.add('code-row-flash')
    row.addEventListener('animationend', () => row.classList.remove('code-row-flash'), { once: true })
  }, [])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'PageDown' && event.key !== 'PageUp') return
    event.preventDefault()
    const el = event.currentTarget
    el.scrollTop = pageScroll(
      blocks,
      el.scrollTop,
      el.clientHeight,
      el.scrollHeight - el.clientHeight,
      event.key === 'PageDown' ? 1 : -1,
      stopLine,
    )
  }

  /** The thumb drags, a press on a mark goes to the mark, a press elsewhere goes there. */
  const onRailDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = event.currentTarget
    const el = scroller.current
    const bar = thumb.current
    if (!el || !bar) return
    event.preventDefault()
    track.setPointerCapture(event.pointerId)
    const top = track.getBoundingClientRect().top
    const y = event.clientY - top
    const height = bar.offsetHeight
    const onThumb = y >= bar.offsetTop && y <= bar.offsetTop + height
    const grab = onThumb ? y - bar.offsetTop : height / 2
    const follow = (at: number) => {
      const span = track.clientHeight - height
      const fraction = span > 0 ? Math.min(1, Math.max(0, (at - top - grab) / span)) : 0
      el.scrollTop = fraction * (el.scrollHeight - el.clientHeight)
    }
    if (!onThumb) {
      const near = marks.find(
        (mark) => Math.abs(((mark.start - 1) / lineCount) * track.clientHeight - y) <= MARK_REACH_PX,
      )
      if (near) jump(near.start)
      else follow(event.clientY)
    }
    const onMove = (move: PointerEvent) => follow(move.clientY)
    const done = () => {
      track.removeEventListener('pointermove', onMove)
      track.removeEventListener('pointerup', done)
      track.removeEventListener('pointercancel', done)
    }
    track.addEventListener('pointermove', onMove)
    track.addEventListener('pointerup', done)
    track.addEventListener('pointercancel', done)
  }

  const resize = useCallback(
    (px: number) => {
      // Whole rows, so that the bottom edge does not cut a line for nothing.
      const next = fit(Math.round(px / ROW_PX) * ROW_PX)
      chosenViewPx = next
      setViewPx(next)
    },
    [fit],
  )

  const onGripDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget
    event.preventDefault()
    grip.setPointerCapture(event.pointerId)
    const from = event.clientY
    const start = viewPx
    const onMove = (move: PointerEvent) => resize(start + move.clientY - from)
    const done = () => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', done)
      grip.removeEventListener('pointercancel', done)
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', done)
    grip.addEventListener('pointercancel', done)
  }

  // Memoised, so scrolling redraws the pins and not every line of the file.
  const rows = useMemo(
    () =>
      html
        .slice(0, lineCount)
        .map((lineHtml, i) => (
          <CodeRow
            key={i + 1}
            n={i + 1}
            html={lineHtml}
            anchor={!running && line === i + 1}
            marked={marked(i + 1)}
            stop={stop}
          />
        )),
    [html, lineCount, line, running, marked, stop],
  )

  const pinRow = (n: number) => (
    <button
      key={n}
      type="button"
      title={`Go to line ${n}`}
      aria-label={`Go to line ${n}`}
      onClick={() => jump(n)}
      className={cn('block w-full shrink-0 overflow-hidden text-left hover:brightness-125', FOCUS_RING)}
      style={{ height: ROW_PX }}
    >
      <CodeRow
        n={n}
        html={html[n - 1]}
        anchor={!running && line === n}
        marked={marked(n)}
        stop={stop}
        pinned
      />
    </button>
  )
  const stackOf = (stack: LineRange[]) =>
    stack.flatMap((block, i) => [
      ...(i > 0 ? [<Skip key={`skip-${block.start}`} />] : []),
      ...Array.from({ length: block.end - block.start + 1 }, (_, k) => pinRow(block.start + k)),
    ])

  const edges = 'absolute inset-x-0 z-10 flex flex-col overflow-hidden bg-code-surface'

  return (
    <div
      ref={root}
      className={cn('font-mono text-[12px] leading-[18px]', fill && 'flex min-h-0 flex-1 flex-col')}
      onPointerMove={hover.onPointerMove}
      onPointerLeave={hover.onPointerLeave}
    >
      <div className={cn('relative', fill && 'min-h-0 flex-1')} style={fill ? undefined : { height: viewPx }}>
        {/* Faded as one piece: a mask on the pins alone would let the code show through them. */}
        <div className="absolute inset-y-0 left-0 right-3 bg-code-surface" style={more ? FADE_RIGHT : undefined}>
          <div
            ref={scroller}
            role="region"
            aria-label={`${name}, whole file`}
            tabIndex={0}
            onScroll={sync}
            onKeyDown={onKeyDown}
            className={cn('h-full overflow-auto', FOCUS_RING)}
          >
            <pre className="hljs w-max min-w-full">{rows}</pre>
          </div>
          {(pins.above.length > 0 || pins.skipAbove) && (
            <div className={cn(edges, 'top-0 shadow-md')} data-pins="top">
              {stackOf(pins.above)}
              {pins.skipAbove && <Skip />}
            </div>
          )}
          {(pins.below.length > 0 || pins.skipBelow) && (
            <div className={cn(edges, 'bottom-0 shadow-md')} data-pins="bottom">
              {pins.skipBelow && <Skip />}
              {stackOf(pins.below)}
            </div>
          )}
        </div>
        <div
          ref={rail}
          aria-hidden
          onPointerDown={onRailDown}
          className="group absolute inset-y-0 right-0 z-10 w-3 touch-none border-l border-border bg-muted/50"
        >
          <i
            ref={thumb}
            className="absolute inset-x-0 not-italic bg-foreground/20 group-hover:bg-foreground/35"
          />
          {marks.map((mark) => (
            <i
              key={mark.start}
              className={cn(
                'pointer-events-none absolute inset-x-px min-h-[3px] rounded-[1px]',
                mark.start === stopLine ? 'bg-primary-text' : 'bg-amber-600 dark:bg-amber-400',
              )}
              style={{
                top: `${((mark.start - 1) / lineCount) * 100}%`,
                height: `${((mark.end - mark.start + 1) / lineCount) * 100}%`,
              }}
            />
          ))}
        </div>
      </div>
      {!fill && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the code window"
          aria-valuemin={minViewPx}
          aria-valuemax={maxViewPx}
          aria-valuenow={viewPx}
          tabIndex={0}
          title="Drag to resize"
          onPointerDown={onGripDown}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            resize(viewPx + (event.key === 'ArrowDown' ? ROW_PX : -ROW_PX))
          }}
          className={cn(
            'group/grip relative cursor-ns-resize touch-none border-t border-border/60',
            FOCUS_RING,
          )}
          style={{ height: GRIP_PX }}
        >
          <span className="absolute left-1/2 top-0.5 h-0.5 w-7 -translate-x-1/2 rounded-[1px] bg-foreground/30 group-hover/grip:bg-primary-text group-focus-visible/grip:bg-primary-text" />
        </div>
      )}
    </div>
  )
}
