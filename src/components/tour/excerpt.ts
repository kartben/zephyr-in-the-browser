/**
 * Which lines a step's excerpt shows, and which of them are marked.
 *
 * Split out of the view because it is the part with decisions in it: the window
 * has to cover both the line the machine stopped on and everything the step
 * points at, without letting a careless `highlight: 1-400` fill the card.
 */

/** 1-based inclusive run of source lines. */
export interface LineRange {
  start: number
  end: number
}

/** Lines of context either side of what is being shown. */
export const CONTEXT = 5

/** Ceiling on the excerpt, so one bad highlight cannot swallow the card. */
export const MAX_LINES = 40

/** A gap shorter than this is shown rather than folded: the marker saves nothing. */
const MIN_FOLD = 3

export interface Excerpt {
  /** First line shown, 1-based. */
  start: number
  /** Last line shown, inclusive. */
  end: number
  /**
   * The lines shown, in file order. One run from `start` to `end` unless the
   * stop and what the step points at are too far apart to share a window;
   * then each keeps its own run and the lines between them are folded away.
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
 * the card, so each keeps its own run with its context and the gap between is
 * folded. The stop is served first: a runaway highlight around it is cut to a
 * window that still holds the stop, and anything further away gets what is left.
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

  // Too far apart for one window: group what is close, fold what is between.
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
