import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatTarget } from '@/debug/addressMap'
import {
  pointerRunsByOffset,
  type PointerRun,
} from '@/components/debug/memoryPointers'
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

/** Modifier that turns a byte click into "follow this pointer". */
const isFollowClick = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey

/** Named targets per row before the rest collapse into a `+n` with a tooltip. */
const GUTTER_CHIPS = 2

/** A run worth following — a self-reference goes nowhere. */
function followable(run: PointerRun | undefined): run is PointerRun {
  return Boolean(run && !run.self)
}

/**
 * Same-target runs next to each other are one fact, not several: an empty
 * `sys_dlist_t` writes its own address into head *and* tail, so a k_msgq row
 * would otherwise name the same thread twice in a row.
 */
function gutterRuns(runs: PointerRun[]): PointerRun[] {
  const out: PointerRun[] = []
  for (const run of runs) {
    const prev = out[out.length - 1]
    if (prev && prev.value === run.value) continue
    out.push(run)
  }
  return out
}

function runTitle(run: PointerRun): string {
  const kind = {
    object: 'kernel object',
    objectCore: 'object core',
    stack: 'thread stack',
    data: 'data symbol',
    code: 'function',
  }[run.target.kind]
  const lines = [
    `0x${run.value.toString(16)} → ${formatTarget(run.target)}`,
    run.self ? `${kind} · points at itself (empty list)` : kind,
  ]
  if (run.target.typeName) lines.push(run.target.typeName)
  if (run.target.size) lines.push(`${run.target.size} B`)
  for (const field of run.target.fields ?? []) lines.push(`${field.label}: ${field.value}`)
  if (!run.self) lines.push('Click to follow · ⌘-click the bytes')
  return lines.join('\n')
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
 * Pass {@link pointers} to name the words that point at something: their bytes
 * get one continuous underline, a right-hand gutter names the target, and
 * holding ⌘/Ctrl lights every one of them up so it is obvious a click will
 * navigate rather than edit.
 */
export function HexView({
  chip,
  jump = null,
  onViewChange,
  addressBase = 0,
  dimErased = true,
  pointers,
  onFollowPointer,
}: {
  chip: HexBacked
  jump?: HexJump | null
  onViewChange?: (range: HexViewRange) => void
  /** Absolute address corresponding to offset 0 in {@link chip.memory}. */
  addressBase?: number
  /** Dim cells equal to {@link HexBacked.decl.erased} (default 0xff). */
  dimErased?: boolean
  /** Resolved pointers in this window, by offset into {@link chip.memory}. */
  pointers?: readonly PointerRun[]
  onFollowPointer?: (run: PointerRun) => void
}) {
  const { data, pointer, recent } = useMemorySnapshot(chip)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [pageBase, setPageBase] = useState(0)
  const [follow, setFollow] = useState(true)
  const [navMode, setNavMode] = useState(false)

  const runs = useMemo(() => pointerRunsByOffset(pointers ?? []), [pointers])
  const linkable = Boolean(onFollowPointer) && runs.size > 0

  // Holding the modifier is what switches the dump from "edit" to "navigate",
  // so the whole address has to light up while it is down — not on click.
  useEffect(() => {
    if (!linkable) return
    const sync = (e: KeyboardEvent) => setNavMode(isFollowClick(e))
    const clear = () => setNavMode(false)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', clear)
      setNavMode(false)
    }
  }, [linkable])

  const windowed = data.length > WINDOW_BYTES
  const autoBase = windowed ? Math.floor(pointer / WINDOW_BYTES) * WINDOW_BYTES : 0
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

  /**
   * Move the caret to the next byte after a commit, so typing a string in the
   * ASCII column (or a run of hex pairs) does not need a click per byte.
   */
  const advance = (target: EditTarget) => {
    const next = target.offset + 1
    setEditing(next < base + viewLen ? { offset: next, column: target.column } : null)
  }

  const cell = (offset: number, value: number, trailing: string) => {
    const run = runs.get(offset)
    return (
    <ByteCell
      key={offset}
      address={addressBase + offset}
      value={value}
      dim={dimErased && value === erased}
      flash={recent.has(offset)}
      isPointer={offset === pointer}
      editing={editing?.column === 'hex' && editing.offset === offset}
      follow={navMode && followable(run)}
      // A cell's own tooltip would otherwise shadow the run's on the very bytes
      // the pointer is made of — which is where you go looking for it.
      title={run ? runTitle(run) : undefined}
      onEdit={(e) => {
        if (isFollowClick(e) && followable(run)) {
          onFollowPointer?.(run)
          return
        }
        setEditing({ offset, column: 'hex' })
      }}
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
   * A pointer's bytes go under one wrapper so the underline is continuous —
   * four separate underlined cells read as four things, not one address.
   */
  const hexCells = (rowBase: number, bytes: number[]) => {
    const out = []
    for (let i = 0; i < bytes.length; ) {
      const offset = rowBase + i
      // A gap after the eighth byte, the way hexdump splits it.
      const trailingAt = (k: number) => (k === 7 ? 'mr-2' : 'mr-[3px]')
      const run = runs.get(offset)
      if (run && run.offset === offset && i + run.length <= bytes.length) {
        const last = i + run.length - 1
        out.push(
          <span
            key={`ptr-${offset}`}
            title={runTitle(run)}
            className={cn(
              'inline-flex rounded-t-[3px] border-b transition-colors',
              trailingAt(last),
              run.self
                ? 'border-muted-foreground/40'
                : 'border-primary/50 hover:bg-primary/15',
              // Loud on purpose: the modifier changes what a click does, so the
              // words it would act on have to be unmistakable while it is down.
              navMode && !run.self && 'border-primary bg-primary/30 hover:bg-primary/50',
            )}
          >
            {Array.from({ length: run.length }, (_, k) =>
              cell(offset + k, bytes[i + k]!, k === run.length - 1 ? '' : 'mr-[3px]'),
            )}
          </span>,
        )
        i += run.length
        continue
      }
      out.push(cell(offset, bytes[i]!, trailingAt(i)))
      i += 1
    }
    return out
  }

  /**
   * One chip per distinct target on the row — the name the underline lacks room
   * for. Self-references stay out of it: they are worth flagging in the dump but
   * lead nowhere, and letting one take a slot buries a link that does.
   *
   * Sits ahead of the ASCII column rather than after it. The debug pane is
   * narrower than a 16-byte dump even before this, so one of the two trailing
   * columns is off-screen either way — and in a window whose words resolve to
   * kernel objects the ASCII is a row of dots, while the names are the reason
   * to look. Windows with no pointers keep the classic hex | ascii layout.
   */
  const gutter = (rowBase: number, length: number) => {
    if (!pointers?.length) return null
    const here = gutterRuns(
      pointers.filter(
        (run) => !run.self && run.offset >= rowBase && run.offset < rowBase + length,
      ),
    )
    if (here.length === 0) return null
    return (
      <span className="flex items-center gap-2 pl-3">
        {here.slice(0, GUTTER_CHIPS).map((run) => (
          <PointerChip
            key={run.offset}
            run={run}
            onFollow={onFollowPointer ? () => onFollowPointer(run) : undefined}
          />
        ))}
        {here.length > GUTTER_CHIPS && (
          <span
            className="text-muted-foreground/70"
            title={here.slice(GUTTER_CHIPS).map(runTitle).join('\n\n')}
          >
            +{here.length - GUTTER_CHIPS}
          </span>
        )}
      </span>
    )
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
        <div className="min-w-max p-2 font-mono text-[10px] leading-[1.6]">
          {Array.from({ length: rows }, (_, row) => {
            const rowBase = base + row * BYTES_PER_ROW
            const bytes = Array.from(
              view.subarray(row * BYTES_PER_ROW, row * BYTES_PER_ROW + BYTES_PER_ROW),
            )
            return (
              <div key={rowBase} className="flex items-center gap-2 whitespace-nowrap">
                <span className="select-none text-muted-foreground">
                  {(addressBase + rowBase).toString(16).padStart(offsetDigits, '0')}
                </span>

                <span className="flex">{hexCells(rowBase, bytes)}</span>

                {gutter(rowBase, bytes.length)}

                <span className="flex">
                  {bytes.map((value, i) => {
                    const offset = rowBase + i
                    return (
                      <AsciiCell
                        key={offset}
                        address={addressBase + offset}
                        value={value}
                        flash={recent.has(offset)}
                        editing={editing?.column === 'ascii' && editing.offset === offset}
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

function ByteCell({
  address,
  value,
  dim,
  flash,
  isPointer,
  editing,
  follow,
  trailing,
  title,
  onEdit,
  onCommit,
  onCancel,
}: {
  address: number
  value: number
  dim: boolean
  flash: boolean
  isPointer: boolean
  editing: boolean
  /** Modifier is down over a followable pointer — the click will navigate. */
  follow: boolean
  /** Right-margin class; a pointer run carries its own so it stays continuous. */
  trailing: string
  /** Replaces the default hover text when the byte is part of a pointer. */
  title?: string
  onEdit: (e: { metaKey: boolean; ctrlKey: boolean }) => void
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

  return (
    <button
      type="button"
      onClick={onEdit}
      title={title ?? `0x${address.toString(16).padStart(4, '0')} — click to edit`}
      className={cn(
        'w-[2ch] cursor-pointer text-center transition-colors hover:bg-primary/20 hover:text-foreground',
        flash && 'bg-primary/30 text-foreground',
        !flash && dim && 'text-muted-foreground/35',
        !flash && !dim && 'text-foreground',
        isPointer && 'outline outline-1 outline-primary',
        follow && 'cursor-alias',
        trailing,
      )}
    >
      {hex2(value)}
    </button>
  )
}

/**
 * The gutter link. The 4-char object-core type code carries the "what kind of
 * thing is this" that a colour alone would need a legend to explain.
 */
function PointerChip({ run, onFollow }: { run: PointerRun; onFollow?: () => void }) {
  const label = formatTarget(run.target)
  if (!onFollow) {
    return (
      <span className="text-muted-foreground/70" title={runTitle(run)}>
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onFollow}
      title={runTitle(run)}
      className="flex max-w-[22ch] items-center gap-1 text-primary underline-offset-2 hover:underline"
    >
      {run.target.typeCode && (
        <span className="rounded-sm bg-primary/15 px-1 text-[9px] tracking-wide">
          {run.target.typeCode.replace(/_+$/, '')}
        </span>
      )}
      <span className="truncate">{label}</span>
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
  editing,
  onEdit,
  onCommit,
  onCancel,
}: {
  address: number
  value: number
  flash: boolean
  editing: boolean
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
      onClick={onEdit}
      title={`0x${address.toString(16).padStart(4, '0')} — click to type a character`}
      className={cn(
        'w-[1ch] cursor-pointer text-center transition-colors hover:bg-primary/20 hover:text-foreground',
        flash && 'bg-primary/30 text-foreground',
        !flash && (isPrintable(value) ? 'text-muted-foreground' : 'text-muted-foreground/40'),
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
