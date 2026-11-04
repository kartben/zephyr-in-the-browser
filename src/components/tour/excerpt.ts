/**
 * What a step's window on its source file does, apart from drawing it: which
 * lines it opens on, which are marked, and which stay pinned to its edges once
 * they scroll out.
 *
 * Split out of the view because it is the part with decisions in it: the window
 * has to open on both the line the machine stopped on and everything the step
 * points at, without letting a careless `highlight: 1-400` fill the card.
 */

/** 1-based inclusive run of source lines. */
export interface LineRange {
  start: number
  end: number
}

/**
 * Lines of context either side of what a window opens on. Three is enough to see
 * the statement a line sits in, and the card is short on height: every line
 * here pushes the prose and the Continue button further down.
 */
export const CONTEXT = 3

/**
 * Ceiling on what a window opens on, so one bad highlight cannot swallow the
 * card: about what fits under a step's prose on a laptop screen without the
 * card scrolling.
 */
export const MAX_LINES = 24

/** A gap shorter than this is shown rather than left out: the marker saves nothing. */
const MIN_FOLD = 3

export interface Excerpt {
  /** First line shown, 1-based. */
  start: number
  /** Last line shown, inclusive. */
  end: number
  /**
   * The lines shown, in file order. One run from `start` to `end` unless the
   * stop and what the step points at are too far apart to share a window;
   * then each keeps its own run, and pinning brings them back together.
   */
  runs: LineRange[]
  /** True for a line the step is pointing at. */
  marked: (line: number) => boolean
}

function excerpt(runs: LineRange[], marked: (line: number) => boolean): Excerpt {
  return { start: runs[0]?.start ?? 1, end: runs[runs.length - 1]?.end ?? 0, runs, marked }
}

/**
 * Build the window for a stop on `line` with `ranges` highlighted.
 *
 * The stop line is always included even when the highlight is somewhere else
 * entirely — a step can stop at the top of `main()` and be talking about a
 * declaration twenty lines earlier, and the reader needs to see both to believe
 * the connection. Pass `line` as null when there is no stop in this file
 * (a `dts:` excerpt has highlights only).
 *
 * When both fit in {@link MAX_LINES}, they share one window, lines between and
 * all. When they do not, a single window from the top would push the stop off
 * the card, so each keeps its own run with its context. The stop is served
 * first: a runaway highlight around it is cut to a window that still holds the
 * stop, and anything further away gets what is left.
 */
export function excerptWindow(
  lineCount: number,
  line: number | null,
  ranges: LineRange[] = [],
): Excerpt {
  const marks = ranges.filter((r) => r.end >= r.start && r.start >= 1)
  const marked = (n: number) => marks.some((r) => n >= r.start && n <= r.end)
  const stop = line != null && line >= 1 ? line : null

  if (stop === null && marks.length === 0) {
    return excerpt([{ start: 1, end: Math.min(lineCount, MAX_LINES) }], marked)
  }

  // Everything worth seeing, each with its context, clamped to the file.
  const spans = [...(stop === null ? [] : [{ start: stop, end: stop }]), ...marks]
    .map((r) => ({
      start: Math.max(1, r.start - CONTEXT),
      end: Math.min(lineCount, r.end + CONTEXT),
    }))
    .filter((r) => r.start <= r.end)
    .sort((a, b) => a.start - b.start)
  if (spans.length === 0) return excerpt([], marked)

  const first = spans[0]!.start
  const last = Math.max(...spans.map((r) => r.end))
  if (last - first + 1 <= MAX_LINES) return excerpt([{ start: first, end: last }], marked)

  // Too far apart for one window: group what is close.
  const groups: LineRange[] = []
  for (const span of spans) {
    const prev = groups[groups.length - 1]
    if (prev && span.start - prev.end - 1 < MIN_FOLD) prev.end = Math.max(prev.end, span.end)
    else groups.push({ ...span })
  }

  // Share out the line budget: the stop's group first, then the nearest.
  const distance = (g: LineRange) =>
    stop === null ? g.start : Math.max(g.start - stop, stop - g.end, 0)
  const runs: LineRange[] = []
  let budget = MAX_LINES
  for (const group of [...groups].sort((a, b) => distance(a) - distance(b))) {
    const size = Math.min(budget, group.end - group.start + 1)
    if (size <= 0) break
    // Cut from the bottom, except around the stop, which stays in view.
    const start =
      stop !== null && distance(group) === 0
        ? Math.max(group.start, Math.min(stop + CONTEXT, group.end) - size + 1)
        : group.start
    runs.push({ start, end: start + size - 1 })
    budget -= size
  }
  return excerpt(runs.sort((a, b) => a.start - b.start), marked)
}

/** One row of the listing, in CSS pixels: its `leading-[18px]`. */
export const ROW_PX = 18
/** Height of the mark between lines that do not follow each other. */
export const SKIP_PX = 12
/** Lines kept either side of a pinned line: enough to read it as code. */
export const PIN_CONTEXT = 1
/** A longer highlight pins its first lines; a pin should not fill the window. */
export const PIN_HIGHLIGHT = 6
/** Fewest rows a window opens with, so that a bare stop has room to look around. */
export const MIN_ROWS = 12
/** Rows of code around the stop when the step also points somewhere far away. */
export const FAR_ROWS = 14
/** Pinned blocks per edge. Beyond two, the pins are most of what is on screen. */
const MAX_PINNED = 2
/** Lines of code that always stay free to scroll, whatever is pinned. */
const MIN_LIVE_ROWS = 3

const rowsOf = (block: LineRange) => block.end - block.start + 1

/**
 * What pins when it scrolls out of the window: the stop and each highlight,
 * with the lines around them. Blocks that touch become one, so a gap between
 * two blocks is always a real one.
 */
export function pinBlocks(lineCount: number, line: number | null, ranges: LineRange[] = []): LineRange[] {
  const spans = ranges
    .filter((r) => r.end >= r.start && r.start >= 1)
    .map((r) => ({ start: r.start, end: Math.min(r.end, r.start + PIN_HIGHLIGHT - 1) }))
  if (line != null && line >= 1) spans.push({ start: line, end: line })
  const blocks: LineRange[] = []
  const sorted = spans
    .map((r) => ({
      start: Math.max(1, r.start - PIN_CONTEXT),
      end: Math.min(lineCount, r.end + PIN_CONTEXT),
    }))
    .filter((r) => r.start <= r.end)
    .sort((a, b) => a.start - b.start)
  for (const span of sorted) {
    const prev = blocks[blocks.length - 1]
    if (prev && span.start <= prev.end + 1) prev.end = Math.max(prev.end, span.end)
    else blocks.push(span)
  }
  return blocks
}

/** What is pinned at one scroll position, and how much of the window it covers. */
export interface PinLayout {
  /** Stuck to the top edge, in file order. */
  above: LineRange[]
  /** Stuck to the bottom edge, in file order. */
  below: LineRange[]
  /** Whether the code running under that edge has moved on from the last pinned line. */
  skipAbove: boolean
  skipBelow: boolean
  topPx: number
  bottomPx: number
}

/** The stack's height, with the mark between two blocks and without the one at its inner edge. */
function stackPx(stack: LineRange[]): number {
  if (stack.length === 0) return 0
  return stack.reduce((px, block) => px + rowsOf(block) * ROW_PX, 0) + (stack.length - 1) * SKIP_PX
}

/**
 * Which blocks are pinned with the listing scrolled to `scrollTop`.
 *
 * Sticky, as `position: sticky` would be: a block stays put once its first line
 * reaches the edge, or the last pinned block above it, so it never pops in. A
 * window too short for all of it drops the blocks furthest from view, the stop
 * last, and always leaves some code free to scroll.
 */
export function pinLayout(
  blocks: LineRange[],
  scrollTop: number,
  viewPx: number,
  stop: number | null = null,
): PinLayout {
  const above: LineRange[] = []
  const below: LineRange[] = []
  for (const block of blocks) {
    if ((block.start - 1) * ROW_PX > scrollTop + stackPx(above)) break
    above.push(block)
  }
  for (const block of [...blocks].reverse()) {
    if (above.includes(block) || block.end * ROW_PX < scrollTop + viewPx - stackPx(below)) break
    below.unshift(block)
  }

  const covered = () =>
    stackPx(above) + stackPx(below) + (above.length > 0 ? SKIP_PX : 0) + (below.length > 0 ? SKIP_PX : 0)
  const room = viewPx - MIN_LIVE_ROWS * ROW_PX
  const holdsStop = (block: LineRange) => stop !== null && block.start <= stop && stop <= block.end
  while (
    above.length + below.length > 0 &&
    (above.length > MAX_PINNED || below.length > MAX_PINNED || covered() > room)
  ) {
    const fromAbove =
      above.length > MAX_PINNED ||
      (below.length <= MAX_PINNED && above.length > 0 && stackPx(above) >= stackPx(below))
    const stack = fromAbove ? above : below
    // Furthest from view first, which is the far end of the stack.
    const order = stack.map((_, i) => (fromAbove ? i : stack.length - 1 - i))
    stack.splice(order.find((i) => !holdsStop(stack[i]!)) ?? order[0]!, 1)
  }

  const firstLive = Math.floor((scrollTop + stackPx(above)) / ROW_PX) + 1
  const lastLive = Math.ceil((scrollTop + viewPx - stackPx(below)) / ROW_PX)
  const lastAbove = above[above.length - 1]
  const firstBelow = below[0]
  const skipAbove = lastAbove !== undefined && firstLive > lastAbove.end + 1
  const skipBelow = firstBelow !== undefined && lastLive < firstBelow.start - 1
  return {
    above,
    below,
    skipAbove,
    skipBelow,
    topPx: stackPx(above) + (skipAbove ? SKIP_PX : 0),
    bottomPx: stackPx(below) + (skipBelow ? SKIP_PX : 0),
  }
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value))

/**
 * Where Page Down or Page Up lands. A page is what can actually be read: the
 * furthest position that still shows the last line in view and the first one
 * not yet seen. Landing can stick or unstick a block, which moves the edges the
 * lines are measured against, so this tries positions rather than working one
 * out, and no line is ever skipped.
 */
export function pageScroll(
  blocks: LineRange[],
  scrollTop: number,
  viewPx: number,
  maxTop: number,
  direction: 1 | -1,
  stop: number | null = null,
): number {
  const free = (top: number) => {
    const { topPx, bottomPx } = pinLayout(blocks, top, viewPx, stop)
    return { from: top + topPx, to: top + viewPx - bottomPx }
  }
  const here = free(scrollTop)
  const edge = direction > 0 ? Math.floor(here.to / ROW_PX) : Math.ceil(here.from / ROW_PX) + 1
  const next = edge + direction
  // Past either end of the file there is nothing left to bring in.
  if (next < 1) return 0
  if ((next - 1) * ROW_PX >= maxTop + viewPx) return maxTop

  const far = clamp(direction > 0 ? (next - 1) * ROW_PX : next * ROW_PX - viewPx, maxTop)
  for (const wanted of [[edge, next], [next]]) {
    for (let top = far; direction > 0 ? top > scrollTop : top < scrollTop; top -= direction) {
      const { from, to } = free(top)
      if (wanted.every((n) => (n - 1) * ROW_PX >= from && n * ROW_PX <= to)) return top
    }
  }
  return clamp(scrollTop + direction * ROW_PX, maxTop)
}

/**
 * How tall a step's window opens: what {@link excerptWindow} would show, within
 * bounds, or, when the stop and what the step points at are far apart, the rows
 * around the stop plus the room their pins take.
 */
export function openingRows(lineCount: number, line: number | null, ranges: LineRange[] = []): number {
  const { start, end, runs } = excerptWindow(lineCount, line, ranges)
  const rows = runs.length > 1 ? FAR_ROWS + 2 * PIN_CONTEXT : Math.max(MIN_ROWS, end - start + 1)
  return Math.min(lineCount, rows)
}

/**
 * Where a step's window opens: on the lines {@link excerptWindow} picks, and
 * failing that, with the stop in the middle of the code left free by the pins.
 * Always on a whole line under the pins, rather than half of one.
 */
export function openingScroll(
  lineCount: number,
  line: number | null,
  ranges: LineRange[],
  viewPx: number,
  blocks: LineRange[] = pinBlocks(lineCount, line, ranges),
): number {
  const { start, end, runs } = excerptWindow(lineCount, line, ranges)
  const maxTop = Math.max(0, lineCount * ROW_PX - viewPx)
  let top: number
  if (runs.length > 1) {
    const anchor = line ?? start
    top = (anchor - 1) * ROW_PX - viewPx / 2
    for (let i = 0; i < 3; i++) {
      const { topPx, bottomPx } = pinLayout(blocks, clamp(top, maxTop), viewPx, line)
      top = (anchor - 1) * ROW_PX - topPx - (viewPx - topPx - bottomPx - ROW_PX) / 2
    }
  } else {
    top = (start - 1) * ROW_PX - (viewPx - (end - start + 1) * ROW_PX) / 2
  }
  top = clamp(top, maxTop)
  const off = (top + pinLayout(blocks, top, viewPx, line).topPx) % ROW_PX
  return off > 0 ? clamp(top + ROW_PX - off, maxTop) : top
}
