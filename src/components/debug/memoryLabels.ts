/**
 * How the Mem pane names things: badges, labels and the inspector's sentences.
 *
 * The wording keeps evidence and assertion apart. A word whose value merely
 * matches a name is "probably a pointer", because memory has no types; a word
 * a DWARF layout says is `k_sem.count` is stated as that.
 */

import type { HexNoteLabel, NoteTone } from '@/components/hexNotes'
import type { ResolvedAddress } from '@/debug/addressMap'
import { structForCode } from '@/debug/kernel/objectCores'
import { formatStackSize, type ZephyrThread } from '@/debug/kernel/threads'

export const hex = (value: number) => `0x${value.toString(16)}`

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
  /** Inside a known kernel object: the member it sits in, `.stack_info`. */
  role?: string
}

/** The C type for an object-core code, falling back to the code itself. */
export function structName(code: string | undefined): string {
  if (!code) return 'object'
  return structForCode(code) ?? code.replace(/_+$/, '')
}

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
export const RANK: Record<NoteTone, number> = {
  object: 0,
  code: 1,
  data: 1,
  plain: 2,
  quiet: 3,
}

/**
 * The badge in front of a label. Kernel objects go by their C type, `k_sem`,
 * `k_thread`: what the source, the docs and a grep all call them. The
 * object-core code (`SEM4`) is an ID nobody types; the inspector still shows it.
 */
export function badgeFor(target: ResolvedAddress): string {
  if (target.typeCode) return structName(target.typeCode)
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
 * leading identifier, or failing that at a trailing number (`Philosopher 5`,
 * `data_0`); the offset into the target goes on the end of it.
 */
export function splitName(name: string, offset = 0): { head: string; tail: string } {
  // Every type descriptor starts the same way; the type is the part to keep.
  const type = /^(obj_type)(_\w+)$/.exec(name)
  if (type && offset === 0) return { head: type[1]!, tail: type[2]! }
  const at = name.slice(1).search(/\+0x|\[|\./)
  const number = /[ _-]?\d+$/.exec(name.slice(1))
  const cut = at >= 0 ? at + 1 : number ? number.index + 1 : name.length
  const suffix = offset === 0 ? '' : `+${hex(offset)}`
  return { head: name.slice(0, cut), tail: name.slice(cut) + suffix }
}

/** A target's name the way a person would say it: a thread by its own name. */
export function targetName(info: Pick<PointerInfo, 'target' | 'thread' | 'stackOf'>): {
  head: string
  tail: string
} {
  const { target } = info
  const who = info.thread ?? info.stackOf
  return splitName(who ? who.name : target.name, target.offset)
}

export function pointerLabel(info: PointerInfo): HexNoteLabel {
  return {
    ...(info.role ? { role: info.role } : {}),
    badge: badgeFor(info.target),
    ...targetName(info),
  }
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
  const struct = structName(target.typeCode)
  if (target.kind === 'objectCore') {
    return `${struct} ${target.name.replace(/\.obj_core$/, '')}`
  }
  if (info.thread) {
    const extra = [target.name, target.size ? formatStackSize(target.size) : null].filter(Boolean)
    return `${struct} ${info.thread.name} (${extra.join(', ')})`
  }
  return `${struct} ${target.name}${size}`
}

/** `the address of k_sem X`, or `0x1f10 bytes into shell_uart's stack (8 KiB)`. */
export function landsOn(info: Pick<PointerInfo, 'target' | 'thread' | 'stackOf'>): string {
  const what = describeTarget(info)
  return info.target.offset === 0
    ? `the address of ${what}`
    : `${hex(info.target.offset)} bytes into ${what}`
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
    return `${value} lands on the .obj_core member inside ${what}, not on its start. Object core chains every ${structName(target.typeCode)} through that member, so this is probably a link in that chain.`
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
  return `Stored as ${bytesHex(bytes)}, lowest byte first (little-endian)`
}

export function bytesHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

/** Little-endian value of up to 8 bytes (exact below 2^53). */
export function readLe(bytes: Uint8Array | readonly number[], at: number, length: number): number {
  let value = 0
  for (let i = length - 1; i >= 0; i--) value = value * 256 + (bytes[at + i] ?? 0)
  return value
}
