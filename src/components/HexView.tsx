import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
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
 *   to find without writing an application to do it.
 *
 * Parts larger than {@link WINDOW_BYTES} page around the live pointer (with
 * prev/next controls) instead of mounting a million cells.
 */
export function HexView({ chip }: { chip: HexBacked }) {
  const { data, pointer, recent } = useMemorySnapshot(chip)
  const [editing, setEditing] = useState<number | null>(null)
  const [pageBase, setPageBase] = useState(0)
  const [follow, setFollow] = useState(true)

  const windowed = data.length > WINDOW_BYTES
  const autoBase = windowed ? Math.floor(pointer / WINDOW_BYTES) * WINDOW_BYTES : 0
  const base = windowed ? (follow ? autoBase : pageBase) : 0
  const viewLen = windowed ? Math.min(WINDOW_BYTES, Math.max(0, data.length - base)) : data.length
  const view = useMemo(() => data.subarray(base, base + viewLen), [data, base, viewLen])

  const erased = chip.decl.erased ?? 0xff
  const rows = Math.ceil(view.length / BYTES_PER_ROW) || 1
  // Enough digits for the largest offset, so the gutter does not jitter.
  const offsetDigits = Math.max(4, Math.max(0, data.length - 1).toString(16).length)

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
            0x{base.toString(16).padStart(offsetDigits, '0')}–0x
            {(base + Math.max(viewLen, 1) - 1).toString(16).padStart(offsetDigits, '0')}
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
      <div className="max-h-[min(22rem,50vh)] overflow-auto rounded-md border border-border bg-background">
        <div className="min-w-max p-2 font-mono text-[10px] leading-[1.6]">
          {Array.from({ length: rows }, (_, row) => {
            const rowBase = base + row * BYTES_PER_ROW
            const bytes = Array.from(
              view.subarray(row * BYTES_PER_ROW, row * BYTES_PER_ROW + BYTES_PER_ROW),
            )
            return (
              <div key={rowBase} className="flex items-center gap-2 whitespace-nowrap">
                <span className="select-none text-muted-foreground">
                  {rowBase.toString(16).padStart(offsetDigits, '0')}
                </span>

                <span className="flex">
                  {bytes.map((value, i) => {
                    const offset = rowBase + i
                    return (
                      <ByteCell
                        key={offset}
                        offset={offset}
                        value={value}
                        dim={value === erased}
                        flash={recent.has(offset)}
                        isPointer={offset === pointer}
                        editing={editing === offset}
                        onEdit={() => setEditing(offset)}
                        onCommit={(next) => {
                          chip.poke(offset, next)
                          setEditing(null)
                        }}
                        onCancel={() => setEditing(null)}
                        // A gap after the eighth byte, the way hexdump splits it.
                        spacer={i === 7}
                      />
                    )
                  })}
                </span>

                <span className="select-none">
                  {bytes.map((value, i) => {
                    const offset = rowBase + i
                    const printable = value >= 0x20 && value <= 0x7e
                    return (
                      <span
                        key={offset}
                        className={cn(
                          'transition-colors',
                          recent.has(offset) && 'bg-primary/30 text-foreground',
                          !recent.has(offset) &&
                            (printable ? 'text-muted-foreground' : 'text-muted-foreground/40'),
                        )}
                      >
                        {printable ? String.fromCharCode(value) : '·'}
                      </span>
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
  offset,
  value,
  dim,
  flash,
  isPointer,
  editing,
  spacer,
  onEdit,
  onCommit,
  onCancel,
}: {
  offset: number
  value: number
  dim: boolean
  flash: boolean
  isPointer: boolean
  editing: boolean
  spacer: boolean
  onEdit: () => void
  onCommit: (value: number) => void
  onCancel: () => void
}) {
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={hex2(value)}
        aria-label={`Byte 0x${offset.toString(16)}`}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          e.currentTarget.value = e.currentTarget.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 2)
        }}
        onBlur={(e) => {
          const parsed = Number.parseInt(e.currentTarget.value, 16)
          if (Number.isNaN(parsed)) onCancel()
          else onCommit(parsed)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') onCancel()
        }}
        className={cn(
          'w-[2ch] bg-primary/20 text-center font-mono text-[10px] text-foreground outline-none',
          spacer ? 'mr-2' : 'mr-[3px]',
        )}
      />
    )
  }

  return (
    <button
      onClick={onEdit}
      title={`0x${offset.toString(16).padStart(4, '0')} — click to edit`}
      className={cn(
        'w-[2ch] text-center transition-colors hover:bg-primary/20 hover:text-foreground',
        flash && 'bg-primary/30 text-foreground',
        !flash && dim && 'text-muted-foreground/35',
        !flash && !dim && 'text-foreground',
        isPointer && 'outline outline-1 outline-primary',
        spacer ? 'mr-2' : 'mr-[3px]',
      )}
    >
      {hex2(value)}
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
      if (version === painted) return
      painted = version

      const data = chip.memory
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

      setSnapshot({ data, pointer: chip.pointer() })
      if (changed.size > 0) {
        setRecent(changed)
        clearTimeout(flashTimer)
        flashTimer = setTimeout(() => setRecent(new Set<number>()), FLASH_MS)
      }
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
