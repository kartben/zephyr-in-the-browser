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

export interface Excerpt {
  /** First line shown, 1-based. */
  start: number
  /** Last line shown, inclusive. */
  end: number
  /** True for a line the step is pointing at. */
  marked: (line: number) => boolean
}

/**
 * Build the window for a stop on `line` with `ranges` highlighted.
 *
 * The stop line is always included even when the highlight is somewhere else
 * entirely — a step can stop at the top of `main()` and be talking about a
 * declaration twenty lines earlier, and the reader needs to see both to believe
 * the connection. Pass `line` as null when there is no stop in this file
 * (a `dts:` excerpt has highlights only).
 */
export function excerptWindow(
  lineCount: number,
  line: number | null,
  ranges: LineRange[] = [],
): Excerpt {
  const marks = ranges.filter((r) => r.end >= r.start && r.start >= 1)
  const anchors = line != null && line >= 1 ? [line] : []
  const lowest = Math.min(...anchors, ...marks.map((r) => r.start))
  const highest = Math.max(...anchors, ...marks.map((r) => r.end))

  if (!Number.isFinite(lowest)) {
    return { start: 1, end: Math.min(lineCount, MAX_LINES), marked: () => false }
  }

  const start = Math.max(1, lowest - CONTEXT)
  const end = Math.min(lineCount, Math.min(highest + CONTEXT, start + MAX_LINES - 1))

  return {
    start,
    end,
    marked: (n) => marks.some((r) => n >= r.start && n <= r.end),
  }
}
