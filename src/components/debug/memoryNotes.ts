/**
 * What the Mem pane says about the words in its window.
 *
 * Turns the pointers {@link decodeWindowPointers} found into {@link HexNote}s
 * for HexView to draw, and holds the wording the inspector strip uses for
 * them. The wording keeps evidence and assertion apart: a word whose value
 * merely matches a name is "probably a pointer", because memory has no types
 * and nothing here has proved otherwise.
 */

import type { HexNote, HexNoteLabel, NoteTone } from '@/components/hexNotes'
import type { AddressMap, ResolvedAddress } from '@/debug/addressMap'
import { structForCode } from '@/debug/kernel/objectCores'
import { formatStackSize, type ZephyrThread } from '@/debug/kernel/threads'
import { decodeWindowPointers, type PointerRun } from '@/components/debug/memoryPointers'

/** A word whose value lands on something the image names. */
export interface PointerInfo {
  kind: 'pointer'
  /** Where the word is. */
  addr: number
  /** Its bytes as stored, lowest address first. */
  bytes: number[]
  value: number
  target: ResolvedAddress
  /** The word holds its own address. */
  self: boolean
  /** The target is a thread, as the Threads tab knows it. */
  thread?: ZephyrThread
  /** The target is a thread stack: whose. */
  stackOf?: ZephyrThread
}

export type NoteInfo = PointerInfo

export interface MemoryNote extends HexNote {
  info: NoteInfo
}

export interface NoteContext {
  /** Absolute address of the window's first byte. */
  base: number
  bytes: Uint8Array
  ptrBytes: 4 | 8
  map: AddressMap | null
  threads: readonly ZephyrThread[]
  /** Move the window to an address. */
  follow: (addr: number) => void
}

const hex = (value: number) => `0x${value.toString(16)}`

/**
 * The colour a target gets. Kernel objects are the loud one: they are what the
 * Objects and Threads tabs open. An object-core link is kernel bookkeeping and
 * stays quiet, and a stack pointer is plain: it matters, but rarely first.
 */
export function targetTone(target: ResolvedAddress): NoteTone {
  switch (target.kind) {
    case 'object':
      return 'object'
    case 'objectCore':
      return 'quiet'
    case 'data':
      return 'data'
    case 'code':
      return 'code'
    case 'stack':
      return 'plain'
  }
}

/** Crowded rows keep what matters: a thread before a descriptor. */
const RANK: Record<NoteTone, number> = {
  object: 0,
  code: 1,
  data: 1,
  plain: 1,
  quiet: 3,
}

/**
 * The badge in front of a label. Kernel objects go by their C type, `k_sem`,
 * `k_thread`: what the source, the docs and a grep all call them. The
 * object-core code (`SEM4`) is an ID nobody types; the inspector still shows it.
 */
export function badgeFor(target: ResolvedAddress): string {
  if (target.typeCode) {
    return structForCode(target.typeCode) ?? target.typeCode.replace(/_+$/, '')
  }
  if (target.kind === 'data') return 'var'
  if (target.kind === 'code') return 'fn'
  if (target.kind === 'stack') return 'stack'
  return target.kind
}

/**
 * Split a name into the part that may be cut and the part that must not be.
 *
 * `shell_uart_ctx+0x300` and `fork_objs[1]` differ from their siblings only in
 * their tails, so a plain end ellipsis (`shell_uart_ctx+…`) throws away the one
 * thing that matters. The tail starts at the first `+0x`, `[` or `.` after the
 * leading identifier; the offset into the target goes on the end of it.
 */
export function splitName(name: string, offset = 0): { head: string; tail: string } {
  const at = name.slice(1).search(/\+0x|\[|\./)
  const cut = at < 0 ? name.length : at + 1
  const suffix = offset === 0 ? '' : `+${hex(offset)}`
  return { head: name.slice(0, cut), tail: name.slice(cut) + suffix }
}

function threadAt(threads: readonly ZephyrThread[], addr: number): ZephyrThread | undefined {
  return threads.find((thread) => thread.addr === addr && thread.name)
}

function stackOwner(threads: readonly ZephyrThread[], addr: number): ZephyrThread | undefined {
  return threads.find((thread) => thread.stackStart === addr && thread.name)
}

/** A target's name the way a person would say it: a thread by its own name. */
export function targetName(info: Pick<PointerInfo, 'target' | 'thread' | 'stackOf'>): {
  head: string
  tail: string
} {
  const { target } = info
  const who = info.thread ?? info.stackOf
  if (who) return { head: who.name, tail: target.offset ? `+${hex(target.offset)}` : '' }
  return splitName(target.name, target.offset)
}

export function pointerLabel(info: PointerInfo): HexNoteLabel {
  return { badge: badgeFor(info.target), ...targetName(info) }
}

/** `k_sem shell_uart_ctx+0x300 (48 B)`, `function main`, `shell_uart's stack (2 KiB)`. */
export function describeTarget(info: Pick<PointerInfo, 'target' | 'thread' | 'stackOf'>): string {
  const { target } = info
  const size = target.size ? ` (${formatStackSize(target.size)})` : ''
  if (target.kind === 'code') return `function ${target.name}`
  if (target.kind === 'stack') {
    return info.stackOf ? `${info.stackOf.name}'s stack${size}` : `thread stack ${target.name}${size}`
  }
  if (target.kind === 'data') return `variable ${target.name}${size}`
  const struct = target.typeCode ? (structForCode(target.typeCode) ?? target.typeCode) : 'object'
  if (target.kind === 'objectCore') {
    return `${struct} ${target.name.replace(/\.obj_core$/, '')}`
  }
  const name = info.thread ? `${info.thread.name} (${target.name})` : target.name
  return `${struct} ${name}${size}`
}

/** One or two sentences saying what the word probably is. */
export function explainPointer(info: PointerInfo): string {
  const { target } = info
  const value = hex(info.value)
  const what = describeTarget(info)
  if (info.self) {
    return `This word holds its own address, ${value}. A Zephyr list head points at itself when the list is empty, so this is probably one.`
  }
  if (target.kind === 'objectCore') {
    const struct = target.typeCode ? (structForCode(target.typeCode) ?? target.typeCode) : 'object'
    return `${value} lands on the .obj_core member inside ${what}, not on its start. Object core chains every ${struct} through that member, so this is probably a link in that chain.`
  }
  if (target.kind === 'code') {
    return target.offset === 0
      ? `${value} is the address of ${what}, so this word is probably a function pointer (a callback).`
      : `${value} is ${hex(target.offset)} bytes into ${what}: probably a return address, saved while it called something.`
  }
  if (target.kind === 'stack') {
    return `${value} lands ${hex(target.offset)} bytes into ${what}: probably a saved stack pointer.`
  }
  return target.offset === 0
    ? `${value} is the address of ${what}, so this word is probably a pointer to it.`
    : `${value} lands ${hex(target.offset)} bytes into ${what}: probably a pointer to something inside it (an interior pointer).`
}

/** `Stored as 20 bd 05 40 00 00 00 00, lowest byte first (little-endian)`. */
export function storedAs(bytes: readonly number[]): string {
  return `Stored as ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}, lowest byte first (little-endian)`
}

function pointerNote(run: PointerRun, ctx: NoteContext): MemoryNote {
  const target = run.target
  const info: PointerInfo = {
    kind: 'pointer',
    addr: run.addr,
    bytes: Array.from(ctx.bytes.subarray(run.offset, run.offset + run.length)),
    value: run.value,
    target,
    self: run.self,
    ...(target.typeCode === 'THRD' && target.kind === 'object'
      ? { thread: threadAt(ctx.threads, target.base) }
      : {}),
    ...(target.kind === 'stack' ? { stackOf: stackOwner(ctx.threads, target.base) } : {}),
  }
  const tone = run.self ? 'quiet' : targetTone(target)
  return {
    id: `p:${run.addr.toString(16)}`,
    offset: run.offset,
    length: run.length,
    tone,
    mark: run.self ? 'dashed' : 'solid',
    // A word holding its own address leads nowhere; flag it, do not name it.
    ...(run.self ? {} : { label: pointerLabel(info), onFollow: () => ctx.follow(run.value) }),
    pointsAt: run.value,
    group: `v:${run.value.toString(16)}`,
    quietAscii: true,
    rank: RANK[tone],
    info,
  }
}

/**
 * Notes for one window. Offsets are into `ctx.bytes`, which is what HexView's
 * chip holds for the debugger's peek.
 */
export function buildMemoryNotes(ctx: NoteContext): MemoryNote[] {
  const runs = decodeWindowPointers({
    base: ctx.base,
    bytes: ctx.bytes,
    ptrBytes: ctx.ptrBytes,
    map: ctx.map,
  })
  return runs.map((run) => pointerNote(run, ctx))
}
