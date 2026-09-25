import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import {
  TONE_CLASSES,
  fitLabels,
  labelWidth,
  type HexNote,
  type HexSection,
} from '@/components/hexNotes'
import type { HexBacked } from '@/virtio/devices/memory/model'

/** Classic hexdump width. 16 keeps a 256-byte part to a readable square. */
const BYTES_PER_ROW = 16

/** How long a freshly-changed byte stays lit. */
const FLASH_MS = 1200

/**
 * Above this, render a sliding window instead of every cell — SPI NOR stubs
 * are 1 MiB; a full dump freezes the tab.
 */
const WINDOW_BYTES = 256

/** Skip O(n) change scans past this; highlight nothing rather than stall. */
const DIFF_SCAN_LIMIT = 4096

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/** Which column an edit is happening in — the two are interchangeable. */
type EditColumn = 'hex' | 'ascii'

type EditTarget = { offset: number; column: EditColumn }

const isPrintable = (value: number) => value >= 0x20 && value <= 0x7e

/** ASCII gutter glyph; unprintable bytes read as a dot, hexdump-style. */
const asciiChar = (value: number) => (isPrintable(value) ? String.fromCharCode(value) : '·')

/** Jump the sliding window to an absolute address (sector map → hex). */
export type HexJump = { address: number; token: number }

/** Inclusive-exclusive byte range currently shown in the dump. */
export type HexViewRange = { start: number; end: number }

/** Modifier that turns a byte click into "follow". */
const isFollowClick = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey

/**
 * How long ⌘/Ctrl has to be held before the dump lights its links. A quick
 * ⌘C, or a chord aimed at something else, should not flash every pointer.
 */
const NAV_HOLD_MS = 200

/**
 * The notes column's width range, in characters. It is sized by the dock and
 * never by what the window happens to contain, so neither the ASCII column
 * nor the horizontal scroll range moves as the window scrolls.
 */
const NOTES_MIN_CH = 24
const NOTES_MAX_CH = 48

/** Right margin after byte `i` of a row: hexdump's gap after the eighth. */
const trailingAt = (i: number) => (i === 7 ? 'mr-2' : 'mr-[3px]')

/** x of byte `i` within the hex column: 2ch cells, 3px apart, 8px after the eighth. */
const byteX = (i: number) => `calc(${i} * (2ch + 3px) + ${i >= 8 ? 5 : 0}px)`

/**
 * Adjacent notes that say the same thing are one fact: an empty
 * `sys_dlist_t` writes the same address into head *and* tail, and naming it
 * twice in a row reads as two different pointers.
 */
function dedupeLabels(notes: HexNote[]): HexNote[] {
  const out: HexNote[] = []
  for (const note of notes) {
    if (!note.label) continue
    const prev = out[out.length - 1]
    if (
      prev &&
      note.group !== undefined &&
      prev.group === note.group &&
      prev.label?.role === note.label?.role
    ) {
      continue
    }
    out.push(note)
  }
  return out
}

function labelText(note: HexNote): string {
  const label = note.label
  if (!label) return ''
  return [label.role, label.guess ? 'probably' : '', label.badge, `${label.head}${label.tail ?? ''}`]
    .filter(Boolean)
    .join(' ')
}

/**
 * ⌘/Ctrl held over the dump. Only while the pointer is over it or focus is in
 * it, only after {@link NAV_HOLD_MS}, and never for a chord.
 */
function useNavMode(enabled: boolean, root: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false)
  const inside = useRef(false)

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(timer)
      timer = undefined
      setOn(false)
    }
    const down = (e: KeyboardEvent) => {
      if (e.key !== 'Meta' && e.key !== 'Control') {
        // ⌘C and friends: a shortcut, not a request to navigate.
        if (isFollowClick(e)) clear()
        return
      }
      const focused = root.current?.contains(document.activeElement) ?? false
      if (!inside.current && !focused) return
      if (timer === undefined) timer = setTimeout(() => setOn(true), NAV_HOLD_MS)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control' || !isFollowClick(e)) clear()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [enabled, root])

  const setInside = (value: boolean) => {
    inside.current = value
    if (!value) setOn(false)
  }
  return { on, setInside }
}

/**
 * A live hex dump of a memory chip's contents.
 *
 * The whole of what an EEPROM has to show, so it is worth showing well. Four
 * things do the work of making it scannable rather than a wall of digits:
 *
 * - Erased cells are dimmed, so on a mostly-blank part the bytes that exist
 *   are the only thing your eye lands on.
 * - Bytes the guest just changed light up for a moment, so a driver writing
 *   is something you watch happen rather than infer.
 * - The read pointer is outlined, showing where the guest is reading from.
 * - Clicking a byte edits it, which is how you plant something for the guest
 *   to find without writing an application to do it. Either column takes the
 *   edit: hex when you know the value, ASCII when what you want to plant is
 *   text — typing there walks the cursor along so a string goes in as a string.
 *
 * Parts larger than {@link WINDOW_BYTES} page around the live pointer (with
 * prev/next controls) instead of mounting a million cells. Pass {@link jump}
 * to snap the window to an address (e.g. a sector-map click).
 * {@link onViewChange} reports the visible range so a sector map can highlight
 * matching cells when the window moves.
 *
 * {@link addressBase} shifts the address labels (debugger peeks at an absolute
 * guest address while the backing buffer is still 0-based). Pass
 * {@link dimErased}`={false}` for RAM peeks where 0xff is ordinary data.
 *
 * Pass {@link notes} to say what runs of bytes *are* (see `hexNotes.ts`): their
 * bytes get a mark, a notes column between the hex and the ASCII names them,
 * and {@link sections} put a line above the row where an object begins. Every
 * column sits on one grid whose tracks do not depend on the content, so the
 * ASCII column stays where it is on every row and as the window scrolls. A
 * click on an annotated word selects it rather than editing it (double-click
 * edits), because underlined bytes read as a link; ⌘/Ctrl-click follows it,
 * and holding ⌘/Ctrl over the dump lights up everything that can be followed.
 */
export function HexView({
  chip,
  jump = null,
  onViewChange,
  addressBase = 0,
  dimErased = true,
  notes,
  sections,
  noteColumn = false,
  activeNote = null,
  selectedNote = null,
  onNoteHover,
  onNoteSelect,
  editRequest = null,
}: {
  chip: HexBacked
  jump?: HexJump | null
  onViewChange?: (range: HexViewRange) => void
  /** Absolute address corresponding to offset 0 in {@link chip.memory}. */
  addressBase?: number
  /** Dim cells equal to {@link HexBacked.decl.erased} (default 0xff). */
  dimErased?: boolean
  /** What runs of bytes are, by offset into {@link chip.memory}. Non-overlapping. */
  notes?: readonly HexNote[]
  /** Where objects begin, by offset into {@link chip.memory}. */
  sections?: readonly HexSection[]
  /**
   * Reserve the notes column even when this window has nothing to say, so
   * scrolling past a string table does not slide the ASCII column over.
   */
  noteColumn?: boolean
  /** The note or section being inspected (hovered or pinned); lit with its group. */
  activeNote?: string | null
  /** The pinned note, outlined. */
  selectedNote?: string | null
  /** Pointer or focus moved onto a note or section, or off every one (`null`). */
  onNoteHover?: (id: string | null) => void
  /** A click on an annotated word or a section line. */
  onNoteSelect?: (id: string) => void
  /** Open the editor on a byte, from outside (the inspector's Edit). */
  editRequest?: { offset: number; token: number } | null
}) {
  const { data, pointer, recent } = useMemorySnapshot(chip)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [pageBase, setPageBase] = useState(0)
  const [follow, setFollow] = useState(true)
  const gridRef = useRef<HTMLDivElement>(null)

  const noteList = useMemo(() => notes ?? [], [notes])
  const noteAt = useMemo(() => {
    const out = new Map<number, HexNote>()
    for (const note of noteList) {
      for (let i = 0; i < note.length; i++) out.set(note.offset + i, note)
    }
    return out
  }, [noteList])
  const followable = noteList.some((note) => note.onFollow)
  const nav = useNavMode(followable, gridRef)

  const showNotes = noteColumn || noteList.length > 0 || (sections?.length ?? 0) > 0
  // With notes, a click is for looking and underlined words read as links, so
  // editing takes a double-click everywhere, in both columns. A plain dump
  // (an EEPROM) keeps click-to-edit.
  const clickEdits = !showNotes

  useEffect(() => {
    if (editRequest) setEditing({ offset: editRequest.offset, column: 'hex' })
  }, [editRequest])

  // The notes column holds only what fits; measure it rather than guess.
  const trackRef = useRef<HTMLSpanElement>(null)
  const chRef = useRef<HTMLSpanElement>(null)
  const [budget, setBudget] = useState(NOTES_MIN_CH)
  useLayoutEffect(() => {
    const track = trackRef.current
    const ch = chRef.current
    if (!track || !ch || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const chPx = ch.getBoundingClientRect().width / 10
      if (chPx > 0) setBudget(Math.max(8, Math.floor(track.getBoundingClientRect().width / chPx)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    return () => observer.disconnect()
  }, [showNotes])

  const windowed = data.length > WINDOW_BYTES
  // A chip with no read pointer reports -1 (see debugMemoryChip, hostDisk),
  // which would floor to a negative page and print negative addresses. Only
  // visible on a medium big enough to be windowed.
  const autoBase = windowed ? Math.floor(Math.max(0, pointer) / WINDOW_BYTES) * WINDOW_BYTES : 0
  const base = windowed ? (follow ? autoBase : pageBase) : 0
  const viewLen = windowed ? Math.min(WINDOW_BYTES, Math.max(0, data.length - base)) : data.length
  const view = useMemo(() => data.subarray(base, base + viewLen), [data, base, viewLen])

  useEffect(() => {
    if (!jump || !windowed) return
    const addr = ((jump.address % data.length) + data.length) % data.length
    setFollow(false)
    setPageBase(Math.floor(addr / WINDOW_BYTES) * WINDOW_BYTES)
  }, [jump, windowed, data.length])

  useEffect(() => {
    onViewChange?.({ start: base, end: base + viewLen })
  }, [base, viewLen, onViewChange])

  const erased = chip.decl.erased ?? 0xff
  const rows = Math.ceil(view.length / BYTES_PER_ROW) || 1

  // Enough digits for the largest absolute address, so the gutter does not jitter.
  const offsetDigits = Math.max(
    4,
    Math.max(0, addressBase + data.length - 1).toString(16).length,
  )

  const active = activeNote
    ? (noteList.find((note) => note.id === activeNote) ?? null)
    : null
  const activeSection = activeNote
    ? (sections?.find((section) => section.id === activeNote) ?? null)
    : null
  const isLit = (note: HexNote) =>
    note.id === activeNote ||
    (active?.group !== undefined && note.group === active.group) ||
    (nav.on && Boolean(note.onFollow))
  const inActiveSection = (offset: number) =>
    activeSection !== null &&
    offset >= activeSection.offset &&
    offset < activeSection.offset + activeSection.length
  // Where the inspected pointer lands, when that is on screen.
  const landing = active?.pointsAt !== undefined ? active.pointsAt - addressBase : null

  /**
   * Move the caret to the next byte after a commit, so typing a string in the
   * ASCII column (or a run of hex pairs) does not need a click per byte.
   */
  const advance = (target: EditTarget) => {
    const next = target.offset + 1
    setEditing(next < base + viewLen ? { offset: next, column: target.column } : null)
  }

  const cell = (offset: number, value: number, trailing: string) => {
    const note = noteAt.get(offset)
    return (
      <ByteCell
        key={offset}
        address={addressBase + offset}
        value={value}
        dim={dimErased && value === erased}
        flash={recent.has(offset)}
        isPointer={offset === pointer}
        landing={offset === landing}
        editing={editing?.column === 'hex' && editing.offset === offset}
        follow={nav.on && Boolean(note?.onFollow)}
        describe={note ? labelText(note) : undefined}
        onClick={(e) => {
          if (note) {
            if (isFollowClick(e) && note.onFollow) note.onFollow()
            else onNoteSelect?.(note.id)
            return
          }
          if (clickEdits) setEditing({ offset, column: 'hex' })
        }}
        onDoubleClick={() => setEditing({ offset, column: 'hex' })}
        editOn={clickEdits && !note ? 'click' : 'dblclick'}
        onHover={() => onNoteHover?.(note ? note.id : null)}
        onCommit={(next, keepGoing) => {
          chip.poke(offset, next)
          if (keepGoing) advance({ offset, column: 'hex' })
          else setEditing(null)
        }}
        onCancel={() => setEditing(null)}
        trailing={trailing}
      />
    )
  }

  /**
   * A note's bytes go under one wrapper so the mark is continuous: four
   * separately underlined cells read as four things, not one address. A note
   * that crosses a row boundary gets one wrapper per row.
   */
  const hexCells = (rowBase: number, bytes: number[]) => {
    const out = []
    for (let i = 0; i < bytes.length; ) {
      const offset = rowBase + i
      const note = noteAt.get(offset)
      if (note) {
        const end = Math.min(note.offset + note.length, rowBase + bytes.length)
        const length = end - offset
        const last = i + length - 1
        const tone = TONE_CLASSES[note.tone]
        const lit = isLit(note)
        out.push(
          <span
            key={`note-${offset}`}
            className={cn(
              // -mb-px keeps the underline from making this row a pixel taller
              // than its neighbours, which would jitter as the window scrolls.
              'inline-flex transition-colors',
              note.mark !== 'none' && '-mb-px border-b',
              note.mark !== 'none' && tone.underline,
              note.mark === 'dashed' && !lit && 'border-dashed',
              note.mark === 'dotted' && !lit && 'border-dotted',
              lit && tone.lit,
              note.id === selectedNote && 'rounded-[2px] ring-1 ring-foreground/50',
              trailingAt(last),
            )}
          >
            {Array.from({ length }, (_, k) =>
              cell(offset + k, bytes[i + k]!, k === length - 1 ? '' : 'mr-[3px]'),
            )}
          </span>,
        )
        i += length
        continue
      }
      out.push(cell(offset, bytes[i]!, trailingAt(i)))
      i += 1
    }
    return out
  }

  /**
   * The row's labels, in byte order, as many as the column fits; the rest
   * collapse into `+n`. A note that began above the window is labelled on the
   * first row, so a list head cut by the window's top edge is still named.
   */
  const notesCell = (rowBase: number, length: number, first: boolean) => {
    const inRow = dedupeLabels(
      noteList.filter(
        (note) =>
          (note.offset >= rowBase && note.offset < rowBase + length) ||
          (first && note.offset < rowBase && note.offset + note.length > rowBase),
      ),
    )
    const { shown, hidden } = fitLabels(inRow, budget)
    return (
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        {shown.map((note, index) => (
          <NoteLabel
            key={note.id}
            note={note}
            lit={isLit(note)}
            shrink={index === 0}
            // Too long for the column: the badge goes before the name does;
            // the colour still says the kind.
            compact={index === 0 && !note.label!.keepBadge && labelWidth(note.label!) > budget}
            onHover={() => onNoteHover?.(note.id)}
          />
        ))}
        {hidden.length > 0 && (
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title={hidden.map(labelText).join('\n')}
            aria-label={`${hidden.length} more: ${hidden.map(labelText).join(', ')}`}
            onPointerEnter={() => onNoteHover?.(hidden[0]!.id)}
            onFocus={() => onNoteHover?.(hidden[0]!.id)}
            onClick={() => onNoteSelect?.(hidden[0]!.id)}
          >
            {hidden.length} more
          </button>
        )}
      </span>
    )
  }

  /** The line above a row where an object begins, indented to its first byte. */
  const sectionLine = (section: HexSection, rowBase: number) => {
    const tone = TONE_CLASSES[section.label.tone ?? 'object']
    const lit = section.id === activeNote || section.id === selectedNote
    return [
      // No address here: the row under it has one, and the start's own address
      // printed above the row's would read out of order. The indent says where.
      <span
        key={`${section.id}-addr`}
        aria-hidden
        className="sticky left-0 z-10 self-stretch bg-background"
        style={{ gridColumn: 1 }}
      />,
      <button
        type="button"
        key={`${section.id}-line`}
        className={cn(
          // The gap above keeps the previous row's underline from reading as
          // this line's overline.
          'mt-1 flex min-w-0 items-center gap-1 overflow-hidden text-left text-[9px] leading-[1.4]',
          tone.text,
          lit && 'underline',
          section.id === selectedNote && 'rounded-sm ring-1 ring-foreground/50',
        )}
        style={{ gridColumn: '2 / -1', paddingLeft: byteX(section.offset - rowBase) }}
        aria-label={`${[section.label.badge, section.label.head + (section.label.tail ?? '')].filter(Boolean).join(' ')} starts at 0x${(addressBase + section.offset).toString(16)}`}
        onPointerEnter={() => onNoteHover?.(section.id)}
        onFocus={() => onNoteHover?.(section.id)}
        onClick={() => onNoteSelect?.(section.id)}
      >
        <span aria-hidden className="shrink-0 opacity-70">
          ┌
        </span>
        {section.label.badge && (
          <span className={cn('shrink-0 rounded-sm px-1', tone.badge)}>{section.label.badge}</span>
        )}
        <span className="flex min-w-0">
          <span className="min-w-0 truncate">{section.label.head}</span>
          {section.label.tail && <span className="shrink-0">{section.label.tail}</span>}
        </span>
        {section.detail && (
          <span className="shrink-0 text-muted-foreground">· {section.detail}</span>
        )}
      </button>,
    ]
  }

  return (
    <div className="space-y-1.5">
      {windowed && (
        <div className="flex flex-wrap items-center gap-2 px-0.5 text-[10px] text-muted-foreground">
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            disabled={base <= 0}
            onClick={() => {
              setFollow(false)
              setPageBase(Math.max(0, base - WINDOW_BYTES))
            }}
          >
            ←
          </button>
          <span className="font-mono tabular-nums">
            0x{(addressBase + base).toString(16).padStart(offsetDigits, '0')}–0x
            {(addressBase + base + Math.max(viewLen, 1) - 1).toString(16).padStart(offsetDigits, '0')}
            <span className="text-muted-foreground/70"> / {data.length.toLocaleString()} B</span>
          </span>
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            disabled={base + WINDOW_BYTES >= data.length}
            onClick={() => {
              setFollow(false)
              setPageBase(Math.min(Math.max(0, data.length - WINDOW_BYTES), base + WINDOW_BYTES))
            }}
          >
            →
          </button>
          {!follow && (
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => setFollow(true)}
            >
              follow pointer
            </button>
          )}
        </div>
      )}
      <div className="max-h-[min(30rem,60vh)] overflow-auto rounded-md border border-border bg-background">
        <div
          ref={gridRef}
          className="relative grid min-w-min items-center gap-x-2 p-2 font-mono text-[10px] leading-[1.6]"
          style={{
            gridTemplateColumns: showNotes
              ? `max-content max-content minmax(${NOTES_MIN_CH}ch, ${NOTES_MAX_CH}ch) max-content`
              : 'max-content max-content max-content',
          }}
          onPointerEnter={() => nav.setInside(true)}
          onPointerLeave={() => {
            nav.setInside(false)
            onNoteHover?.(null)
          }}
        >
          {showNotes && (
            <>
              {/* Zero-height probes: the notes track's width, and one ch. */}
              <span ref={trackRef} aria-hidden className="h-0" style={{ gridColumn: 3 }} />
              <span ref={chRef} aria-hidden className="invisible absolute">
                0000000000
              </span>
            </>
          )}
          {Array.from({ length: rows }, (_, row) => {
            const rowBase = base + row * BYTES_PER_ROW
            const bytes = Array.from(
              view.subarray(row * BYTES_PER_ROW, row * BYTES_PER_ROW + BYTES_PER_ROW),
            )
            const starting = (sections ?? []).filter(
              (section) => section.offset >= rowBase && section.offset < rowBase + bytes.length,
            )
            return (
              <div key={rowBase} className="contents">
                {starting.map((section) => sectionLine(section, rowBase))}

                <span
                  // Sticky, so scrolling right to read the names keeps the addresses.
                  className={cn(
                    'sticky left-0 z-10 select-none bg-background pr-1',
                    starting.length > 0 ? TONE_CLASSES.object.text : 'text-muted-foreground',
                  )}
                  style={{ gridColumn: 1 }}
                >
                  {(addressBase + rowBase).toString(16).padStart(offsetDigits, '0')}
                </span>

                <span className="flex">{hexCells(rowBase, bytes)}</span>

                {showNotes && notesCell(rowBase, bytes.length, row === 0)}

                <span className="flex">
                  {bytes.map((value, i) => {
                    const offset = rowBase + i
                    const note = noteAt.get(offset)
                    const lit = note && isLit(note) ? TONE_CLASSES[note.tone].lit : undefined
                    return (
                      <AsciiCell
                        key={offset}
                        address={addressBase + offset}
                        value={value}
                        flash={recent.has(offset)}
                        lit={lit ?? (inActiveSection(offset) ? 'bg-foreground/10' : undefined)}
                        quiet={Boolean(note?.quietAscii)}
                        editing={editing?.column === 'ascii' && editing.offset === offset}
                        editOn={clickEdits ? 'click' : 'dblclick'}
                        onEdit={() => setEditing({ offset, column: 'ascii' })}
                        onCommit={(next, keepGoing) => {
                          chip.poke(offset, next)
                          if (keepGoing) advance({ offset, column: 'ascii' })
                          else setEditing(null)
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    )
                  })}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** A note's name in the notes column: `.role [badge] head tail`. */
function NoteLabel({
  note,
  lit,
  shrink,
  compact = false,
  onHover,
}: {
  note: HexNote
  lit: boolean
  /** Only the row's first label may truncate; the others were fitted whole. */
  shrink: boolean
  /** Drop the badge to leave the name room. */
  compact?: boolean
  onHover: () => void
}) {
  const label = note.label!
  const tone = TONE_CLASSES[label.tone ?? note.tone]
  const className = cn(
    'flex items-center gap-1',
    // The first label gives way (its name truncates, then it clips) so the
    // `+n` after it always stays in view.
    shrink ? 'min-w-0 overflow-hidden' : 'shrink-0',
    tone.text,
    note.onFollow && 'hover:[&_.name]:underline',
    lit && '[&_.name]:underline',
  )
  const content = (
    <>
      {label.role && <span className="shrink-0 text-foreground/60">{label.role}</span>}
      {label.guess && (
        <span className="shrink-0 text-muted-foreground/70" title="Matched by value only">
          ?
        </span>
      )}
      {label.badge && !compact && (
        <span className={cn('shrink-0 rounded-sm px-1 text-[9px]', tone.badge)}>{label.badge}</span>
      )}
      <span className="flex min-w-0">
        <span className="name min-w-0 truncate underline-offset-2">{label.head}</span>
        {label.tail && <span className="name shrink-0 underline-offset-2">{label.tail}</span>}
      </span>
    </>
  )
  if (!note.onFollow) {
    return (
      <span className={className} onPointerEnter={onHover}>
        {content}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={className}
      aria-label={`Follow ${labelText(note)}`}
      onPointerEnter={onHover}
      onFocus={onHover}
      onClick={note.onFollow}
    >
      {content}
    </button>
  )
}

function ByteCell({
  address,
  value,
  dim,
  flash,
  isPointer,
  landing,
  editing,
  follow,
  trailing,
  describe,
  editOn,
  onClick,
  onDoubleClick,
  onHover,
  onCommit,
  onCancel,
}: {
  address: number
  value: number
  dim: boolean
  flash: boolean
  isPointer: boolean
  /** The inspected pointer lands on this byte. */
  landing: boolean
  editing: boolean
  /** Modifier is down over a followable note, so the click will navigate. */
  follow: boolean
  /** Right-margin class; a note carries its own so its mark stays continuous. */
  trailing: string
  /** What the byte is part of; the inspector says the rest. */
  describe?: string
  onClick: (e: { metaKey: boolean; ctrlKey: boolean }) => void
  onDoubleClick: () => void
  /** Which gesture opens the editor: a click in a plain dump, a double-click once a click means "look". */
  editOn: 'click' | 'dblclick'
  /** Pointer or focus arrived. */
  onHover: () => void
  /** `advance` asks the view to move the caret to the next byte. */
  onCommit: (value: number, advance: boolean) => void
  onCancel: () => void
}) {
  const cancelled = useRef(false)
  // Set once the cell has resolved itself (auto-advance): a blur arriving after
  // that must not commit again, and must not clear the caret we just moved.
  const settled = useRef(false)

  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={hex2(value)}
        aria-label={`Byte 0x${address.toString(16)}`}
        onFocus={(e) => {
          cancelled.current = false
          settled.current = false
          e.currentTarget.select()
        }}
        onChange={(e) => {
          const text = e.currentTarget.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 2)
          e.currentTarget.value = text
          // A full pair is unambiguous — take it and move on, so a run of bytes
          // types straight through.
          if (text.length === 2) {
            settled.current = true
            onCommit(Number.parseInt(text, 16), true)
          }
        }}
        onBlur={(e) => {
          if (settled.current) return
          if (cancelled.current) {
            onCancel()
            return
          }
          const parsed = Number.parseInt(e.currentTarget.value, 16)
          if (Number.isNaN(parsed)) onCancel()
          else onCommit(parsed, false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            cancelled.current = true
            e.currentTarget.blur()
          }
        }}
        className={cn(
          'w-[2ch] bg-primary/20 text-center font-mono text-[10px] text-foreground outline-none',
          trailing,
        )}
      />
    )
  }

  const where = `0x${address.toString(16).padStart(4, '0')}`
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={editOn === 'dblclick' ? onDoubleClick : undefined}
      onPointerEnter={onHover}
      onFocus={onHover}
      // A note's bytes are described by the inspector; a native tooltip on top
      // of it would only cover the rows being read.
      title={
        describe ? undefined : editOn === 'click' ? `${where} — click to edit` : `${where}: double-click to edit`
      }
      aria-label={describe ? `${where}, ${describe}` : undefined}
      className={cn(
        'w-[2ch] cursor-pointer text-center transition-colors hover:bg-primary/20 hover:text-foreground',
        flash && 'bg-primary/30 text-foreground',
        !flash && dim && 'text-muted-foreground/35',
        !flash && !dim && 'text-foreground',
        isPointer && 'outline outline-1 outline-primary',
        landing && 'outline-dashed outline-1 outline-foreground/80',
        follow && 'cursor-alias',
        trailing,
      )}
    >
      {hex2(value)}
    </button>
  )
}

/**
 * One glyph of the ASCII gutter, editable in place.
 *
 * Typing a character writes that byte and steps to the next one, because what
 * you come to the ASCII column to do is type a word — a filename, a command, a
 * marker to search for — not to place a single character. Non-printable bytes
 * still show as dots but accept a character just the same.
 */
function AsciiCell({
  address,
  value,
  flash,
  lit,
  quiet,
  editing,
  editOn,
  onEdit,
  onCommit,
  onCancel,
}: {
  address: number
  value: number
  flash: boolean
  /** Background class while the note this byte belongs to is inspected. */
  lit?: string
  /** Part of a word that is not text (a pointer): dim it so it does not read as a string. */
  quiet: boolean
  editing: boolean
  editOn: 'click' | 'dblclick'
  onEdit: () => void
  onCommit: (value: number, advance: boolean) => void
  onCancel: () => void
}) {
  const settled = useRef(false)

  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={isPrintable(value) ? String.fromCharCode(value) : ''}
        aria-label={`ASCII at 0x${address.toString(16)}`}
        onFocus={(e) => {
          settled.current = false
          e.currentTarget.select()
        }}
        onChange={(e) => {
          // Take the last character typed so overtyping a filled cell works.
          const text = e.currentTarget.value
          const ch = text.charCodeAt(text.length - 1)
          if (!Number.isFinite(ch) || ch > 0xff) {
            e.currentTarget.value = ''
            return
          }
          settled.current = true
          onCommit(ch & 0xff, true)
        }}
        onBlur={() => {
          if (settled.current) return
          onCancel()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur()
          // Backspace on an empty cell writes a NUL — the usual way to cut a
          // string short in place.
          if (e.key === 'Backspace' && e.currentTarget.value === '') {
            settled.current = true
            onCommit(0, true)
          }
        }}
        className="w-[1ch] bg-primary/20 text-center font-mono text-[10px] text-foreground outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={editOn === 'click' ? onEdit : undefined}
      onDoubleClick={editOn === 'dblclick' ? onEdit : undefined}
      title={
        editOn === 'click'
          ? `0x${address.toString(16).padStart(4, '0')} — click to type a character`
          : `0x${address.toString(16).padStart(4, '0')}: double-click to type a character`
      }
      className={cn(
        'w-[1ch] cursor-pointer text-center transition-colors hover:bg-primary/20 hover:text-foreground',
        flash && 'bg-primary/30 text-foreground',
        !flash && lit,
        !flash &&
          (quiet
            ? 'text-muted-foreground/45 dark:text-muted-foreground/30'
            : isPrintable(value)
              ? 'text-muted-foreground'
              : 'text-muted-foreground/40'),
      )}
    >
      {asciiChar(value)}
    </button>
  )
}

/**
 * Track a chip's contents for rendering, coalescing a burst of writes into one
 * repaint the way OledPanel does: the guest fills an EEPROM page in several
 * transfers and each one notifies, so painting per notification would redraw
 * the dump many times for one logical change. Exported so HexPreview shares
 * the exact same pointer/flash semantics instead of approximating them.
 *
 * Large memories (SPI NOR) keep a shared backing reference and only scan a
 * bounded region for the "recently changed" highlight.
 *
 * Pointer updates on every notify — SPI NOR bumps `version` only on content
 * changes, so gating the whole paint on version would freeze the outline
 * during guest reads.
 */
export function useMemorySnapshot(chip: HexBacked) {
  const [snapshot, setSnapshot] = useState(() => ({
    data: chip.memory,
    pointer: chip.pointer(),
  }))
  const [recent, setRecent] = useState<ReadonlySet<number>>(() => new Set<number>())

  useEffect(() => {
    let frame = 0
    let painted = -1
    let flashTimer: ReturnType<typeof setTimeout> | undefined
    let previous =
      chip.memory.length <= DIFF_SCAN_LIMIT ? chip.memory.slice() : null

    const paint = () => {
      frame = 0
      const version = chip.version()
      const data = chip.memory
      const pointer = chip.pointer()

      if (version !== painted) {
        painted = version
        const changed = new Set<number>()
        if (previous && data.length === previous.length && data.length <= DIFF_SCAN_LIMIT) {
          for (let i = 0; i < data.length; i++) {
            if (data[i] !== previous[i]) changed.add(i)
          }
          previous = data.slice()
        } else if (data.length <= DIFF_SCAN_LIMIT) {
          previous = data.slice()
        } else {
          previous = null
        }
        if (changed.size > 0) {
          setRecent(changed)
          clearTimeout(flashTimer)
          flashTimer = setTimeout(() => setRecent(new Set<number>()), FLASH_MS)
        }
      }

      setSnapshot({ data, pointer })
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }

    paint()
    const unsubscribe = chip.subscribe(schedule)
    return () => {
      unsubscribe()
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(flashTimer)
    }
  }, [chip])

  return { ...snapshot, recent }
}
