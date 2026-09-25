/**
 * Annotations a caller can lay over a {@link HexView}: what a run of bytes *is*
 * (a pointer, a list head, a struct member) as opposed to what it holds.
 *
 * HexView knows nothing about Zephyr. The debugger builds these from the image
 * and the kernel's own bookkeeping (`src/components/debug/memoryNotes.ts`), and
 * HexView only draws them: a mark under the bytes, a label in the notes column,
 * and a section line where an object starts. Saying more about the one being
 * hovered is the caller's job (the Mem pane's inspector strip).
 */

/**
 * One colour per *kind* of thing, not per thing: the dump is read by kind first
 * ("that word points at a thread, that one at a function"), and a hue per
 * identity would run out long before a window of struct members does. Colour
 * is never the only channel; every label also carries a badge in words.
 *
 * `plain` is everything worth reading that is not one of those (a count, a
 * saved stack pointer), and `quiet` is bookkeeping worth marking but not worth
 * your eye: an empty list, a NULL link, a word that holds its own address.
 * Three hues is the most a 10px dump can carry next to the change flash.
 */
export type NoteTone = 'object' | 'data' | 'code' | 'plain' | 'quiet'

/**
 * Tailwind classes per tone, spelled out in full so the class scanner sees
 * them. Dark is the app's default, so the `dark:` half is what most people read.
 */
export const TONE_CLASSES: Record<
  NoteTone,
  {
    /** Label and badge text. */
    text: string
    /** The mark under a note's bytes. */
    underline: string
    /** Badge fill. */
    badge: string
    /** A note's bytes while it is hovered, or while ⌘/Ctrl is held. */
    lit: string
    /** Legend swatch. */
    swatch: string
  }
> = {
  object: {
    text: 'text-primary',
    underline: 'border-primary/70',
    badge: 'bg-primary/15',
    lit: 'bg-primary/25',
    swatch: 'bg-primary',
  },
  data: {
    text: 'text-sky-700 dark:text-sky-300',
    underline: 'border-sky-600/70 dark:border-sky-400/70',
    badge: 'bg-sky-500/15',
    lit: 'bg-sky-500/25',
    swatch: 'bg-sky-600 dark:bg-sky-400',
  },
  code: {
    text: 'text-amber-700 dark:text-amber-300',
    underline: 'border-amber-600/70 dark:border-amber-400/70',
    badge: 'bg-amber-500/15',
    lit: 'bg-amber-500/25',
    swatch: 'bg-amber-600 dark:bg-amber-400',
  },
  plain: {
    text: 'text-foreground/75',
    underline: 'border-foreground/30',
    badge: 'bg-muted',
    lit: 'bg-foreground/10',
    swatch: 'bg-foreground/60',
  },
  quiet: {
    text: 'text-muted-foreground',
    underline: 'border-dashed border-muted-foreground/60',
    badge: 'bg-muted',
    lit: 'bg-muted-foreground/20',
    swatch: 'bg-muted-foreground',
  },
}

/**
 * A label in the notes column: `[badge] head tail`. Plain strings, not nodes,
 * so the row can work out what fits before it renders.
 *
 * `head` is the part that may be cut and `tail` the part that must not be:
 * `shell_uart_ctx+0x300` and `fork_objs[1]` differ from their siblings only in
 * their tails, so an end ellipsis would throw away the one thing that matters.
 */
export interface HexNoteLabel {
  /** Short kind word in a pill: `k_sem`, `fn`, `var`. */
  badge?: string
  /** A role, shown before the badge in the default text colour: `.wait_q`. */
  role?: string
  head: string
  tail?: string
  tone?: NoteTone
}

export interface HexNote {
  /** Stable identity, for keys and hover. */
  id: string
  /** Byte offset into the chip's memory. */
  offset: number
  /** Bytes the note spans. */
  length: number
  tone: NoteTone
  /** How the bytes are marked. `none` leaves them as they are. */
  mark: 'solid' | 'dashed' | 'none'
  /** Compact label for the notes column; omit for none. */
  label?: HexNoteLabel
  /** Navigate: a click on the label, or ⌘/Ctrl-click on the bytes. */
  onFollow?: () => void
  /** Absolute address this note points at, outlined when it is on screen. */
  pointsAt?: number
  /** Notes in one group light up together (same destination). */
  group?: string
  /** Its ASCII glyphs are not text, so the ASCII column dims them. */
  quietAscii?: boolean
  /** Which labels win a crowded row: lower first. Default 0. */
  rank?: number
}

/** A line above the row where something (a kernel object) begins. */
export interface HexSection {
  id: string
  /** Byte offset into the chip's memory where it begins. */
  offset: number
  /** Bytes it spans, lit while its line is hovered. */
  length: number
  label: HexNoteLabel
  /** Right of the label, dimmed: `48 B`. */
  detail?: string
}

/** Characters a label takes on screen, badge pill included. */
export function labelWidth(label: HexNoteLabel): number {
  const role = label.role ? label.role.length + 1 : 0
  const badge = label.badge ? label.badge.length + 2 : 0
  return role + badge + label.head.length + (label.tail?.length ?? 0)
}

/**
 * Which of a row's labels fit a column `budget` characters wide.
 *
 * Chosen by rank (lower first: a waiting thread before a type descriptor),
 * shown in byte order so they read left to right like the words do. The most
 * important one always shows, its head truncating to fit; the rest only whole.
 * Whatever does not fit is returned so the row can say `+2`.
 */
export function fitLabels<T extends { label?: HexNoteLabel; rank?: number }>(
  notes: readonly T[],
  budget: number,
  gap = 2,
): { shown: T[]; hidden: T[] } {
  const labelled = notes.filter((note) => note.label)
  if (labelled.length === 0) return { shown: [], hidden: [] }
  const byRank = labelled
    .map((note, index) => ({ note, index }))
    .sort((a, b) => (a.note.rank ?? 0) - (b.note.rank ?? 0) || a.index - b.index)
  const more = (n: number) => (n > 0 ? String(n).length + 1 + gap : 0)
  const keep = new Set<number>([byRank[0]!.index])
  let used = labelWidth(byRank[0]!.note.label!)
  for (let i = 1; i < byRank.length; i++) {
    const { note, index } = byRank[i]!
    const width = labelWidth(note.label!)
    const left = labelled.length - keep.size - 1
    if (used + gap + width + more(left) > budget) continue
    keep.add(index)
    used += gap + width
  }
  return {
    shown: labelled.filter((_, index) => keep.has(index)),
    hidden: labelled.filter((_, index) => !keep.has(index)),
  }
}
