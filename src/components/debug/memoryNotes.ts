/**
 * What the Mem pane says about the words in its window.
 *
 * Two passes. The kernel objects in view are read member by member first
 * (memoryStructure.ts), because a word whose role the layout knows is better
 * named by that role. Every other aligned word that lands on something the
 * image names (memoryPointers.ts) becomes a pointer note; one that sits inside
 * a known object still says which member it is in.
 */

import type { AddressMap } from '@/debug/addressMap'
import type { KernelLayouts, ObjectCoreSnapshot } from '@/debug/kernel/objectCores'
import type { ZephyrThread } from '@/debug/kernel/threads'
import { decodeWindowPointers, type PointerRun } from '@/components/debug/memoryPointers'
import {
  RANK,
  pointerLabel,
  targetTone,
  type PointerInfo,
} from '@/components/debug/memoryLabels'
import {
  buildStructure,
  type MemoryNote,
  type MemorySection,
} from '@/components/debug/memoryStructure'

export type { MemoryNote, MemorySection, NoteInfo } from '@/components/debug/memoryStructure'
export {
  badgeFor,
  describeTarget,
  explainPointer,
  pointerLabel,
  splitName,
  storedAs,
  targetName,
  targetTone,
  type PointerInfo,
} from '@/components/debug/memoryLabels'

export interface NoteContext {
  /** Absolute address of the window's first byte. */
  base: number
  bytes: Uint8Array
  ptrBytes: 4 | 8
  map: AddressMap | null
  threads: readonly ZephyrThread[]
  /** Live kernel objects, from object core. */
  objects?: ObjectCoreSnapshot | null
  /** Their struct layouts, from DWARF. */
  layouts?: KernelLayouts | null
  /** Move the window to an address. */
  follow: (addr: number) => void
}

function pointerNote(run: PointerRun, ctx: NoteContext, role: string | undefined): MemoryNote {
  const target = run.target
  const info: PointerInfo = {
    kind: 'pointer',
    addr: run.addr,
    bytes: Array.from(ctx.bytes.subarray(run.offset, run.offset + run.length)),
    value: run.value,
    target,
    self: run.self,
    ...(role ? { role } : {}),
    ...(target.typeCode === 'THRD' && target.kind === 'object'
      ? { thread: ctx.threads.find((t) => t.addr === target.base && t.name) }
      : {}),
    ...(target.kind === 'stack'
      ? { stackOf: ctx.threads.find((t) => t.stackStart === target.base && t.name) }
      : {}),
  }
  const tone = run.self ? 'quiet' : targetTone(target)
  return {
    id: `p:${run.addr.toString(16)}`,
    offset: run.offset,
    length: run.length,
    tone,
    // Matched by value alone: dotted, where the layout's own words are solid.
    mark: run.self ? 'dashed' : 'dotted',
    // A word holding its own address leads nowhere; flag it, do not name it.
    ...(run.self
      ? {}
      : { label: { ...pointerLabel(info), guess: true }, onFollow: () => ctx.follow(run.value) }),
    pointsAt: run.value,
    group: `v:${run.value.toString(16)}`,
    quietAscii: true,
    rank: RANK[tone],
    info,
  }
}

/**
 * Notes and object sections for one window. Offsets are into `ctx.bytes`,
 * which is what HexView's chip holds for the debugger's peek.
 */
export function buildMemoryNotes(ctx: NoteContext): {
  notes: MemoryNote[]
  sections: MemorySection[]
} {
  const structure = buildStructure({
    ...ctx,
    objects: ctx.objects ?? null,
    layouts: ctx.layouts ?? null,
  })
  const taken = new Set<number>()
  for (const note of structure.notes) {
    for (let i = 0; i < note.length; i++) taken.add(note.offset + i)
  }
  const runs = decodeWindowPointers({
    base: ctx.base,
    bytes: ctx.bytes,
    ptrBytes: ctx.ptrBytes,
    map: ctx.map,
  }).filter((run) => !taken.has(run.offset) && !taken.has(run.offset + run.length - 1))
  const notes = [
    ...structure.notes,
    ...runs.map((run) => pointerNote(run, ctx, structure.roleAt(run.addr))),
  ].sort((a, b) => a.offset - b.offset)
  return { notes, sections: structure.sections }
}
