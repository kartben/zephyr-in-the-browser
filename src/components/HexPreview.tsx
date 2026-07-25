/**
 * The hex dump at a glance: a read-only two-row window that follows the
 * guest's read pointer. The dock row wants the *pulse* of the part — where the
 * driver is, what just changed — not all 256 bytes; the full editable HexView
 * is one "Hex editor" click away in a floating window.
 */

import { cn } from '@/lib/utils'
import { useMemorySnapshot } from '@/components/HexView'
import type { MemoryChip } from '@/virtio/devices/memory/model'

const BYTES_PER_ROW = 16

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

export function HexPreview({ chip }: { chip: MemoryChip }) {
  const { data, pointer, recent } = useMemorySnapshot(chip)
  const erased = chip.decl.erased ?? 0xff

  const rows = Math.max(1, Math.ceil(data.length / BYTES_PER_ROW))
  // The pointer's row plus the next one, sliding back at the end of the part.
  const pointerRow = Math.min(Math.floor(pointer / BYTES_PER_ROW), rows - 1)
  const firstRow = Math.max(0, Math.min(pointerRow, rows - 2))
  const shownRows = rows > 1 ? [firstRow, firstRow + 1] : [0]
  const offsetDigits = Math.max(4, (data.length - 1).toString(16).length)

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-background px-2 py-1 font-mono text-[10px] leading-[1.7]">
      {shownRows.map((row) => {
        const base = row * BYTES_PER_ROW
        const bytes = Array.from(data.subarray(base, base + BYTES_PER_ROW))
        return (
          <div key={row} className="flex items-center gap-2 whitespace-nowrap">
            <span className="select-none text-muted-foreground">
              {base.toString(16).padStart(offsetDigits, '0')}
            </span>
            <span className="flex">
              {bytes.map((value, i) => {
                const offset = base + i
                const flash = recent.has(offset)
                return (
                  <span
                    key={offset}
                    className={cn(
                      'w-[2ch] text-center transition-colors',
                      flash && 'bg-primary/30 text-foreground',
                      !flash && (value === erased ? 'text-muted-foreground/35' : 'text-foreground'),
                      offset === pointer && 'outline outline-1 outline-primary',
                      i === 7 ? 'mr-2' : 'mr-[3px]',
                    )}
                  >
                    {hex2(value)}
                  </span>
                )
              })}
            </span>
          </div>
        )
      })}
    </div>
  )
}
