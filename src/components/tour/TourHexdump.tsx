/**
 * The `memory:` card — a window of guest RAM, with the bytes the step is about
 * picked out of it.
 *
 * A tour step that says "the spec is three fields in flash" is words; the same
 * step with the twelve bytes on screen and the pin byte lit is the thing
 * itself. That is the whole reason the DSL can talk about memory at all.
 */

import { MemoryStick, SquareArrowOutUpRight } from 'lucide-react'
import * as debug from '@/debug/control'
import * as debugUi from '@/lib/debugUi'
import type { TourMemory } from '@/tours/store'
import { cn } from '@/lib/utils'

const BYTES_PER_ROW = 16

/** Bytes fetched into the Debug panel's Mem pane when handing the view over. */
const HANDOFF_BYTES = 256

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

function printable(byte: number): string {
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '·'
}

export function TourHexdump({ memory }: { memory: TourMemory }) {
  const { addr, bytes, len, mark, note, error } = memory
  const rows = Math.ceil((bytes?.length ?? len) / BYTES_PER_ROW)
  const marked = (offset: number) => mark !== null && offset >= mark.start && offset < mark.end

  const openInMem = () => {
    if (addr === null) return
    void debug.readMemory(addr, HANDOFF_BYTES)
    debugUi.focusDebug('memory')
  }

  return (
    <div className="rounded border border-border bg-muted/30">
      <div className="flex items-center gap-1.5 border-b border-border/70 px-2 py-1">
        <MemoryStick className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-mono text-[10px] tabular-nums text-foreground/70">
          {addr === null ? '—' : `0x${addr.toString(16)}`}
          <span className="text-muted-foreground"> +{len}</span>
        </span>
        {error && <span className="text-[10px] text-destructive">{error}</span>}
        {addr !== null && (
          <button
            type="button"
            onClick={openInMem}
            title="Open this address in Debug → Mem"
            className="ml-auto flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <SquareArrowOutUpRight className="size-2.5" aria-hidden />
            Mem
          </button>
        )}
      </div>

      <div className="overflow-x-auto px-2 py-1.5">
        <table className="font-mono text-[10.5px] leading-relaxed tabular-nums">
          <tbody>
            {Array.from({ length: rows }, (_, row) => {
              const base = row * BYTES_PER_ROW
              const count = Math.min(BYTES_PER_ROW, (bytes?.length ?? len) - base)
              return (
                <tr key={row}>
                  <td className="pr-3 text-right text-muted-foreground/70">
                    {addr === null ? '········' : (addr + base).toString(16).padStart(8, '0')}
                  </td>
                  {Array.from({ length: count }, (_, i) => {
                    const offset = base + i
                    const byte = bytes?.[offset]
                    return (
                      <td
                        key={i}
                        className={cn(
                          'px-[1.5px] text-foreground/80',
                          i === 8 && 'pl-2',
                          marked(offset) && 'rounded bg-primary/25 text-foreground',
                        )}
                      >
                        {byte === undefined ? '··' : hex2(byte)}
                      </td>
                    )
                  })}
                  <td className="pl-3 text-muted-foreground">
                    {Array.from({ length: count }, (_, i) => {
                      const offset = base + i
                      const byte = bytes?.[offset]
                      return (
                        <span
                          key={i}
                          className={cn(marked(offset) && 'rounded-sm bg-primary/25 text-foreground')}
                        >
                          {byte === undefined ? '·' : printable(byte)}
                        </span>
                      )
                    })}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {(note || mark) && (
        <p className="flex items-center gap-1.5 border-t border-border/70 px-2 py-1 text-[10.5px] text-muted-foreground">
          <span className="size-2 shrink-0 rounded-sm bg-primary/25" aria-hidden />
          {note ?? `bytes ${mark!.start}–${mark!.end - 1}`}
          {mark && note && (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
              +{mark.start}…+{mark.end - 1}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
