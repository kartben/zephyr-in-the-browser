/**
 * A message queue drawn as the ring buffer it is: every slot of its buffer,
 * the waiting messages numbered in the order they will come out, and where
 * `read_ptr` (R) and `write_ptr` (W) point.
 *
 * The lesson of a `k_msgq` is the ring. A put writes at W, a get reads at R,
 * both wrap, and `k_msgq_put_front()` steps R back a slot, round to the last
 * one. "3 of 10 used" says how many; the strip shows which three, and why the
 * urgent message sits at the far end of the buffer yet first in line.
 *
 * Drawn from what was read while the machine was stopped (readRing in the tour
 * store), so it is the queue at this step, like a `memory:` hexdump.
 */

import {
  MAX_RING_SLOTS,
  ringSlots,
  slotBytes,
  type MsgqRingSnapshot,
  type RingSlot,
} from '@/debug/kernel/msgqRing'
import { cn } from '@/lib/utils'

/** Slots per row before the strip wraps. */
const MAX_COLUMNS = 16

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

function printable(byte: number): boolean {
  return byte >= 0x20 && byte < 0x7f
}

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13
  return `${n}${teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`
}

/** A message in words: `'A'` for a one-byte printable, else its leading bytes in hex. */
function describe(bytes: Uint8Array | null, msgSize: number): string {
  if (!bytes || bytes.length === 0) return 'not read'
  const first = bytes[0]!
  if (msgSize === 1) return printable(first) ? `'${String.fromCharCode(first)}'` : `0x${hex2(first)}`
  const shown = [...bytes.subarray(0, 8)].map(hex2).join(' ')
  return msgSize > 8 ? `${shown} and ${msgSize - 8} more bytes` : shown
}

/** What a screen reader hears for one slot: "slot 9, 'A', next to read". */
function slotLabel(slot: RingSlot, bytes: Uint8Array | null, msgSize: number): string {
  const parts = [`slot ${slot.index}`, slot.occupied ? describe(bytes, msgSize) : 'empty']
  if (slot.occupied) parts.push(slot.order === 1 ? 'next to read' : `read ${ordinal(slot.order)}`)
  else if (slot.isRead) parts.push('read pointer')
  if (slot.isWrite) parts.push(slot.occupied ? 'write pointer' : 'next to write')
  return parts.join(', ')
}

/** How much a cell can hold, from how many share a row. */
interface Density {
  /** Leading bytes a multi-byte message shows; the tooltip has the rest. */
  preview: number
  /** Room for `'A'` rather than `A` next to the read-order number. */
  quotes: boolean
}

function density(columns: number): Density {
  return { preview: columns <= 8 ? 4 : 2, quotes: columns <= 12 }
}

/** The visible face of an occupied slot: the character and its byte, or leading hex. */
function SlotFace({ bytes, msgSize, fit }: { bytes: Uint8Array | null; msgSize: number; fit: Density }) {
  if (!bytes || bytes.length === 0) {
    return <span className="text-muted-foreground/70">··</span>
  }
  if (msgSize === 1) {
    const byte = bytes[0]!
    const char = String.fromCharCode(byte)
    return (
      <>
        <span className="text-[11.5px] leading-none text-foreground">
          {!printable(byte) ? '·' : fit.quotes ? `'${char}'` : char}
        </span>
        <span className="text-[9px] leading-none text-muted-foreground">{hex2(byte)}</span>
      </>
    )
  }
  const shown = [...bytes.subarray(0, fit.preview)]
  return (
    <span className="grid grid-cols-2 gap-x-1 text-[9.5px] leading-tight text-foreground">
      {shown.map((byte, i) => (
        <span key={i}>{hex2(byte)}</span>
      ))}
      {msgSize > shown.length && <span className="col-span-2 text-center text-muted-foreground">…</span>}
    </span>
  )
}

export function MsgqRing({ ring, name }: { ring: MsgqRingSnapshot; name?: string }) {
  const slots = ring.maxMsgs <= MAX_RING_SLOTS ? ringSlots(ring) : null
  if (!slots) return null

  const columns = Math.min(ring.maxMsgs, MAX_COLUMNS)
  const fit = density(columns)
  // Four bytes of preview take two lines, and a wider cell.
  const tall = ring.msgSize > 1 && fit.preview > 2
  const unit = ring.msgSize === 1 ? 'byte' : 'bytes'

  return (
    <div className="space-y-1">
      <ul
        role="list"
        aria-label={`${name ?? 'Message queue'} ring buffer`}
        className="grid gap-x-0.5 gap-y-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, ${tall ? '3.5rem' : '2.5rem'}))` }}
      >
        {slots.map((slot) => {
          const bytes = slot.occupied ? slotBytes(ring, slot.index) : null
          const label = slotLabel(slot, bytes, ring.msgSize)
          return (
            <li
              key={slot.index}
              title={`${label}\n0x${slot.addr.toString(16)}`}
              className="flex min-w-0 flex-col items-center gap-0.5"
            >
              <span className="sr-only">{label}</span>
              <span
                aria-hidden
                className="flex h-3.5 items-end gap-px font-mono text-[9px] font-semibold leading-none"
              >
                {slot.isRead && (
                  <span
                    title="read_ptr: the next message out"
                    className="rounded-sm bg-primary px-[3px] py-px text-primary-foreground"
                  >
                    R
                  </span>
                )}
                {slot.isWrite && (
                  <span
                    title="write_ptr: where the next message goes"
                    className="rounded-sm border border-success px-[2px] text-success"
                  >
                    W
                  </span>
                )}
              </span>
              <span
                aria-hidden
                className={cn(
                  'relative flex w-full flex-col items-center justify-center gap-0.5',
                  'rounded-sm border font-mono tabular-nums',
                  tall ? 'h-11' : 'h-9',
                  slot.occupied
                    ? 'border-primary/50 bg-primary/20'
                    : 'border-dashed border-border bg-background/40',
                )}
              >
                {slot.occupied && (
                  <>
                    <span className="absolute right-0.5 top-px text-[8px] leading-none text-primary">
                      {slot.order}
                    </span>
                    <SlotFace bytes={bytes} msgSize={ring.msgSize} fit={fit} />
                  </>
                )}
              </span>
              <span
                aria-hidden
                className="font-mono text-[9px] leading-none tabular-nums text-muted-foreground/70"
              >
                {slot.index}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="text-[10.5px] text-muted-foreground">
        {ring.used} of {ring.maxMsgs} used, {ring.msgSize} {unit} per message
      </p>
    </div>
  )
}
