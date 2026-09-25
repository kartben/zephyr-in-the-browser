/**
 * The kernel objects in a Mem window, laid out member by member.
 *
 * Naming what a word points at is half of reading kernel memory; the other
 * half is knowing what the word *is*. Two rows that both read "k_thread
 * shell_uart" are a wait queue holding that thread and some other field that
 * happens to point at it, and only the struct layout can tell them apart.
 * Object core says where every live object is and what type it has; DWARF
 * says where each member of that type sits. Joining the two names the words
 * (`.wait_q`, `.count`, `.obj_core.next`) and marks where each object begins.
 *
 * Lists get their own reading. A wait queue is a `sys_dlist_t` of two words,
 * and those two words say "empty" by pointing back at the list itself, which
 * no amount of naming their targets would explain. Who is waiting comes from
 * the kernel's thread list (each thread's `pended_on`), which is exact, rather
 * than from walking nodes the window cannot see. A wait queue whose member is
 * not two pointers wide is a red-black tree (CONFIG_WAITQ_SCALABLE), and is
 * never read as a list.
 */

import type { HexNote, HexNoteLabel, HexSection, NoteTone } from '@/components/hexNotes'
import type { AddressMap, ResolvedAddress } from '@/debug/addressMap'
import type {
  KernelLayouts,
  ObjectCoreField,
  ObjectCoreSnapshot,
} from '@/debug/kernel/objectCores'
import { formatStackSize, type ZephyrThread } from '@/debug/kernel/threads'
import { MIN_POINTER } from '@/components/debug/memoryPointers'
import {
  RANK,
  hex,
  pointerLabel,
  readLe,
  splitName,
  structName,
  targetTone,
  type PointerInfo,
} from '@/components/debug/memoryLabels'

/** A live kernel object, as the dump needs it. */
export interface KernelObjectRef {
  addr: number
  size: number
  /** C type: `k_sem`. */
  struct: string
  /** Object-core type ID: `SEM4`. */
  code: string
  /** Object core's name for it (a symbol, maybe with an offset). */
  name: string
  /** Plural type name from object core: `Semaphores`. */
  typeName: string
  fields: readonly ObjectCoreField[]
  /** For a k_thread: the thread, as the Threads tab knows it. */
  thread?: ZephyrThread
}

/**
 * What a member holds, as far as the dump can tell. `waitq` and `dlist` are
 * list heads, `dnode` a node in someone else's list, `next` object core's
 * singly linked chain, `type` its type descriptor.
 */
export type MemberKind =
  | 'waitq'
  | 'dlist'
  | 'dnode'
  | 'next'
  | 'type'
  | 'pointer'
  | 'number'
  | 'signed'
  | 'flags'
  | 'string'
  | 'other'

export interface ObjectMember {
  /** C path below the struct: `wait_q`, `obj_core.node.next`, `base.pended_on`. */
  path: string
  addr: number
  size: number
  kind: MemberKind
}

/** Where an address lands: in which object, in which member of it. */
export interface Where {
  object: KernelObjectRef
  member: ObjectMember | null
  /** Bytes past the member's start (or the object's, with no member). */
  delta: number
}

/** A list head: a wait queue, or another `sys_dlist_t`. */
export interface ListInfo {
  kind: 'list'
  addr: number
  bytes: number[]
  ptrBytes: 4 | 8
  head: number
  tail: number
  /** The object it belongs to; null when only the byte pattern says "list". */
  owner: KernelObjectRef | null
  member: ObjectMember | null
  shape: 'dlist' | 'tree'
  /** A dlist whose head and tail hold its own address. Never set for a tree. */
  empty: boolean
  /** Threads pended on it, from the kernel's thread list. */
  waiters: ZephyrThread[]
  /** The thread the head points at (its queue node is at k_thread+0). */
  first: ZephyrThread | null
  headTarget: ResolvedAddress | null
}

/** A member of a known object that is not a list head. */
export interface MemberInfo {
  kind: 'member'
  owner: KernelObjectRef
  member: ObjectMember
  bytes: number[]
  value: number
  /** What a pointer-ish value lands on, by name. */
  target: ResolvedAddress | null
  /** ...and by member, when it lands inside a known object. */
  where: Where | null
  /** A `dnode`'s second word. */
  prev?: { value: number; where: Where | null }
  /** A `string` member's text. */
  text?: string
  /** A pointer member whose target is a thread. */
  thread?: ZephyrThread
  /** ...or a thread's stack: whose. */
  stackOf?: ZephyrThread
}

/** Where an object begins: its section line. */
export interface ObjectInfo {
  kind: 'object'
  owner: KernelObjectRef
  members: ObjectMember[]
}

export type NoteInfo = PointerInfo | ListInfo | MemberInfo

export interface MemoryNote extends HexNote {
  info: NoteInfo
}

export interface MemorySection extends HexSection {
  info: ObjectInfo
}

export interface StructureContext {
  /** Absolute address of the window's first byte. */
  base: number
  bytes: Uint8Array
  ptrBytes: 4 | 8
  map: AddressMap | null
  threads: readonly ZephyrThread[]
  objects: ObjectCoreSnapshot | null
  layouts: KernelLayouts | null
  follow: (addr: number) => void
}

/**
 * Pointers whose target is a *member*, so the note names it: `pended_on` is a
 * `_wait_q_t *`, which lands on a `.wait_q`. Any other pointer that lands on an
 * object's first byte means the object, even when a member starts there too
 * (a mutex's `owner` is the thread, not its queue node).
 */
const POINTS_AT_MEMBER = new Set(['base.pended_on'])

/** Members that hold an address, whatever the value looks like. */
const POINTER_MEMBERS = new Set([
  'owner',
  'buffer',
  'free_list',
  'buffer_start',
  'buffer_end',
  'read_ptr',
  'write_ptr',
  'user_data',
  'expiry_fn',
  'stop_fn',
  'next_thread',
  'resource_pool',
  'switch_handle',
  'mutex_pended_on',
  'base',
  'next',
  'top',
])

/**
 * The dump's short form of a member path: `.pended_on` for `base.pended_on`,
 * `.obj_core.next` for `obj_core.node.next`. The column is narrow, and the
 * inspector spells the full path out.
 */
export function roleOf(member: ObjectMember): string {
  if (member.path.startsWith('callee_saved.')) return `saved ${member.path.slice(13)}`
  return `.${member.path
    .replace(/^(base|entry)\./, '')
    .replace('obj_core.node.next', 'obj_core.next')}`
}

/** The member's real C path, `.obj_core.node.next`: what compiles, for the inspector. */
export function cPath(member: ObjectMember): string {
  return `.${member.path}`
}

/**
 * Whether this image's wait queues are red-black trees (CONFIG_WAITQ_SCALABLE):
 * a k_sem's (or k_mutex's) `wait_q` is then wider than the two pointers of a
 * `sys_dlist_t`.
 */
export function waitQueuesAreTrees(layouts: KernelLayouts): boolean {
  const p = layouts.ptrBytes
  for (const [struct, after] of [
    ['k_sem', 'count'],
    ['k_mutex', 'owner'],
  ] as const) {
    const layout = layouts.structs[struct]
    if (layout?.wait_q !== undefined && layout[after] !== undefined) {
      return layout[after] - layout.wait_q !== 2 * p
    }
  }
  return false
}

function memberKind(name: string, size: number, p: number): MemberKind {
  // A spinlock is empty on a uniprocessor build and a lock word otherwise;
  // either way it is not a number worth a label.
  if (name === 'lock') return 'other'
  if (name === 'wait_q' || name === 'join_queue') return 'waitq'
  if ((name === 'poll_events' || name === 'held_mutexes') && size === 2 * p) return 'dlist'
  if (name === 'name' && size > p) return 'string'
  if (size === p && POINTER_MEMBERS.has(name)) return 'pointer'
  if (size <= 4 && /events|options|flags|state/.test(name)) return 'flags'
  if (size <= 4) return 'number'
  return 'other'
}

/**
 * The members of one object, in address order and sized by the gap to the
 * next one. Two members that share an offset (a zero-size spinlock before the
 * field after it) leave the bytes to the second. `obj_core` and a thread's
 * `base` are opened up, because the words worth naming live inside them.
 */
export function membersOf(ref: KernelObjectRef, layouts: KernelLayouts): ObjectMember[] {
  const layout = layouts.structs[ref.struct]
  if (!layout) return []
  const p = layouts.ptrBytes
  const entries = Object.entries(layout).sort((a, b) => a[1] - b[1])
  const out: ObjectMember[] = []
  entries.forEach(([name, offset], i) => {
    const end = i + 1 < entries.length ? entries[i + 1]![1] : ref.size
    const size = end - offset
    if (size <= 0 || offset >= ref.size) return
    const addr = ref.addr + offset
    if (name === 'obj_core') {
      const core = layouts.core
      const at = (member: string, fallback: number) => addr + (core[member] ?? fallback)
      out.push({ path: 'obj_core.node.next', addr: at('node', 0), size: p, kind: 'next' })
      out.push({ path: 'obj_core.type', addr: at('type', p), size: p, kind: 'type' })
      if (core.stats !== undefined && core.stats + p <= size) {
        out.push({ path: 'obj_core.stats', addr: at('stats', 2 * p), size: p, kind: 'pointer' })
      }
      return
    }
    if (ref.struct === 'k_thread' && name === 'base') {
      out.push(...threadBase(addr, size, layouts))
      return
    }
    // The registers saved at a context switch, by name (`sp_elx`, `ra`, `psp`),
    // and what the thread was created to run (`pEntry`, `parameter1`).
    const nested =
      ref.struct === 'k_thread' && name === 'callee_saved'
        ? layouts.structs._callee_saved
        : ref.struct === 'k_thread' && name === 'entry'
          ? layouts.structs._thread_entry
          : null
    if (nested && Object.keys(nested).length > 1) {
      const fields = Object.entries(nested).sort((a, b) => a[1] - b[1])
      fields.forEach(([field, at], k) => {
        const next = k + 1 < fields.length ? fields[k + 1]![1] : size
        if (next > at && at < size) {
          out.push({ path: `${name}.${field}`, addr: addr + at, size: next - at, kind: 'other' })
        }
      })
      return
    }
    out.push({ path: name, addr, size, kind: memberKind(name, size, p) })
  })
  return out
}

/** `_thread_base`: its queue node, what it is pended on, its state and priority. */
function threadBase(addr: number, size: number, layouts: KernelLayouts): ObjectMember[] {
  const tb = layouts.structs._thread_base ?? {}
  const p = layouts.ptrBytes
  const out: ObjectMember[] = []
  // The queue node sits in an anonymous union at offset 0, so DWARF gives it no
  // name here; it is everything before pended_on. With tree-shaped wait queues
  // a pended thread hangs in the tree by `qnode_rb` (two child pointers, the
  // colour in a low bit), where next/prev would be the wrong reading.
  const node = tb.pended_on ?? 2 * p
  if (node === 2 * p) {
    out.push(
      waitQueuesAreTrees(layouts)
        ? { path: 'base.qnode_rb', addr, size: node, kind: 'other' }
        : { path: 'base.qnode_dlist', addr, size: node, kind: 'dnode' },
    )
  }
  if (tb.pended_on !== undefined) {
    out.push({ path: 'base.pended_on', addr: addr + tb.pended_on, size: p, kind: 'pointer' })
  }
  const options = tb.user_options
  const state = tb.thread_state
  if (options !== undefined && state !== undefined && state > options) {
    // Today: a u16 of options, then the {prio, sched_locked} union, then the
    // state. Older trees had a u8 of options and the state right after it,
    // with the union following the state. Little-endian: prio is the union's
    // first byte.
    const wide = state - options >= 3
    out.push({ path: 'base.user_options', addr: addr + options, size: wide ? 2 : 1, kind: 'flags' })
    out.push({ path: 'base.prio', addr: addr + (wide ? options + 2 : state + 1), size: 1, kind: 'signed' })
    out.push({ path: 'base.thread_state', addr: addr + state, size: 1, kind: 'flags' })
  }
  return out
    .filter((m) => m.addr + m.size <= addr + size)
    .sort((a, b) => a.addr - b.addr)
}

/** Every live object, tightest first so a nested one claims its bytes. */
export function kernelObjects(
  objects: ObjectCoreSnapshot | null,
  threads: readonly ZephyrThread[],
): KernelObjectRef[] {
  const out: KernelObjectRef[] = []
  for (const type of objects?.types ?? []) {
    for (const object of type.objects) {
      const size = object.size ?? type.objectSize ?? 0
      if (size <= 0) continue
      out.push({
        addr: object.addr,
        size,
        struct: structName(object.typeCode),
        code: object.typeCode.replace(/_+$/, ''),
        name: object.name,
        typeName: object.typeName,
        fields: object.fields,
        ...(object.typeCode === 'THRD'
          ? { thread: threads.find((thread) => thread.addr === object.addr && thread.name) }
          : {}),
      })
    }
  }
  return out.sort((a, b) => a.size - b.size || a.addr - b.addr)
}

/** An object's name the way a person would say it: a thread by its own name. */
export function objectName(ref: KernelObjectRef): { head: string; tail: string } {
  return splitName(ref.thread ? ref.thread.name : ref.name)
}

/**
 * A label for an object, or a member of one. A member at the object's very
 * start goes unsaid: `k_event shell_uart_ctx+0x2d0` already is its `.wait_q`
 * address, and the inspector says which it is.
 */
/**
 * A link that lands on a member (a queue node's next, a `pended_on`) always
 * says which one, even at offset 0, and keeps it whole: the whole object name
 * is what truncates, so `k_event ….wait_q` never reads as an offset into it.
 */
function memberLinkLabel(where: Where): HexNoteLabel {
  const ref = where.object
  const name = ref.thread ? ref.thread.name : ref.name
  const delta = where.delta ? `+${hex(where.delta)}` : ''
  return {
    badge: ref.struct,
    head: name,
    tail: where.member ? `${cPath(where.member)}${delta}` : delta,
  }
}

const bytesOf = (bytes: Uint8Array, at: number, length: number) =>
  Array.from(bytes.subarray(at, at + length))

/**
 * Read the objects in one window. Everything is keyed by absolute address, so
 * a note keeps its identity as the window scrolls past it.
 */
export function buildStructure(ctx: StructureContext): {
  notes: MemoryNote[]
  sections: MemorySection[]
  /** The member an address sits in, for naming a pointer found there. */
  roleAt: (addr: number) => string | undefined
} {
  const { base, bytes, layouts } = ctx
  const p = ctx.ptrBytes
  const end = base + bytes.length
  const all = kernelObjects(ctx.objects, ctx.threads)
  const members = new Map<KernelObjectRef, ObjectMember[]>()
  const membersFor = (ref: KernelObjectRef) => {
    let list = members.get(ref)
    if (!list) {
      list = layouts ? membersOf(ref, layouts) : []
      members.set(ref, list)
    }
    return list
  }

  const whereIs = (addr: number): Where | null => {
    const object = all.find((ref) => addr >= ref.addr && addr < ref.addr + ref.size)
    if (!object) return null
    const member =
      membersFor(object).find((m) => addr >= m.addr && addr < m.addr + m.size) ?? null
    return { object, member, delta: addr - (member?.addr ?? object.addr) }
  }

  const resolve = (value: number) =>
    value >= MIN_POINTER && ctx.map ? ctx.map.resolve(value) : null

  const inView = all.filter((ref) => ref.addr < end && ref.addr + ref.size > base)
  const covered = new Set<number>()
  const notes: MemoryNote[] = []
  const claim = (note: MemoryNote) => {
    for (let i = 0; i < note.length; i++) {
      if (covered.has(note.offset + i)) return
    }
    for (let i = 0; i < note.length; i++) covered.add(note.offset + i)
    notes.push(note)
  }

  for (const ref of inView) {
    for (const member of membersFor(ref)) {
      const offset = member.addr - base
      // Half a member says nothing reliable; the next scroll shows all of it.
      if (offset < 0 || offset + member.size > bytes.length) continue
      const note = memberNote(ref, member, offset)
      if (note) claim(note)
    }
  }

  function memberNote(ref: KernelObjectRef, member: ObjectMember, offset: number): MemoryNote | null {
    const role = roleOf(member)
    const id = `m:${member.addr.toString(16)}`
    const raw = bytesOf(bytes, offset, member.size)

    if (member.kind === 'waitq' || member.kind === 'dlist') {
      const shape = member.size === 2 * p ? 'dlist' : member.kind === 'waitq' ? 'tree' : null
      if (!shape) return null
      return listNote({ id, offset, raw, owner: ref, member, shape })
    }

    if (member.kind === 'dnode') {
      const next = readLe(bytes, offset, p)
      const prev = readLe(bytes, offset + p, p)
      const idle = (next === 0 && prev === 0) || next === member.addr
      const where = idle ? null : whereIs(next)
      const info: MemberInfo = {
        kind: 'member',
        owner: ref,
        member,
        bytes: raw,
        value: next,
        target: idle ? null : resolve(next),
        where,
        prev: { value: prev, where: idle ? null : whereIs(prev) },
      }
      const label: HexNoteLabel = idle
        ? { role, head: 'not queued' }
        : where
          ? { role, ...memberLinkLabel(where) }
          : info.target
            ? { role, ...pointerLabel({ ...pointerFields(next, info.target) }) }
            : { role, head: hex(next) }
      const tone: NoteTone = idle ? 'quiet' : 'object'
      return {
        id,
        offset,
        length: member.size,
        tone,
        mark: idle ? 'dashed' : 'solid',
        label,
        ...(idle ? {} : { onFollow: () => ctx.follow(next), pointsAt: next }),
        group: `v:${next.toString(16)}`,
        quietAscii: true,
        rank: RANK[tone],
        info,
      }
    }

    if (member.kind === 'string') {
      let text = ''
      for (const b of raw) {
        if (b === 0) break
        text += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'
      }
      return {
        id,
        offset,
        length: member.size,
        tone: 'plain',
        mark: 'none',
        label: { role, head: `"${text}"` },
        rank: RANK.plain,
        info: { kind: 'member', owner: ref, member, bytes: raw, value: 0, target: null, where: null, text },
      }
    }

    if (member.kind === 'number' || member.kind === 'signed' || member.kind === 'flags') {
      let value = readLe(bytes, offset, member.size)
      if (member.kind === 'signed' && value >= 2 ** (member.size * 8 - 1)) {
        value -= 2 ** (member.size * 8)
      }
      const state = member.path === 'base.thread_state' ? threadStateNames(value) : ''
      const shown = member.kind === 'flags' ? `${hex(value)}${state ? ` ${state}` : ''}` : String(value)
      return {
        id,
        offset,
        length: member.size,
        tone: 'plain',
        mark: 'none',
        label: { role, head: shown },
        rank: RANK.plain,
        info: { kind: 'member', owner: ref, member, bytes: raw, value, target: null, where: null },
      }
    }

    // Pointer-sized: a declared pointer, object core's links, or a member of
    // unknown type whose value happens to land on a name.
    if (member.size !== p) return null
    const value = readLe(bytes, offset, p)
    const target = resolve(value)
    if (member.kind === 'other' && !target) return null
    const where = value && POINTS_AT_MEMBER.has(member.path) ? whereIs(value) : null
    const thread =
      target?.typeCode === 'THRD' && target.kind === 'object'
        ? ctx.threads.find((t) => t.addr === target.base && t.name)
        : undefined
    const stackOf =
      target?.kind === 'stack'
        ? ctx.threads.find((t) => t.stackStart === target.base && t.name)
        : undefined
    const info: MemberInfo = {
      kind: 'member',
      owner: ref,
      member,
      bytes: raw,
      value,
      target,
      where,
      ...(thread ? { thread } : {}),
      ...(stackOf ? { stackOf } : {}),
    }
    let label: HexNoteLabel
    let tone: NoteTone
    if (value === 0) {
      label = { role, head: member.kind === 'next' ? 'end of list' : 'NULL' }
      tone = 'quiet'
    } else if (member.kind === 'type') {
      label = { role, head: target?.name ?? hex(value) }
      tone = 'quiet'
    } else if (where?.member) {
      // Pointing at a member of a known object: say which one (`pended_on`
      // lands on a `.wait_q`, not on the object as a whole).
      label = { role, ...memberLinkLabel(where) }
      tone = 'object'
    } else if (target) {
      label = {
        role,
        ...pointerLabel({ ...pointerFields(value, target, thread), ...(stackOf ? { stackOf } : {}) }),
        // A member of unknown type whose value matches a name: evidence, not proof.
        ...(member.kind === 'other' ? { guess: true } : {}),
      }
      tone = member.kind === 'next' ? 'quiet' : targetTone(target)
    } else {
      label = { role, head: hex(value) }
      tone = 'plain'
    }
    return {
      id,
      offset,
      length: p,
      tone,
      // NULL is said in words ("end of list"); an underline would only add noise.
      // A member of unknown type that merely lands on a name is a guess: dotted.
      mark: value === 0 || tone === 'plain' ? 'none' : member.kind === 'other' ? 'dotted' : 'solid',
      label,
      ...(value && target ? { onFollow: () => ctx.follow(value), pointsAt: value } : {}),
      group: `v:${value.toString(16)}`,
      quietAscii: true,
      // A type descriptor is the same for every object of the type: last to
      // get a slot in a crowded row.
      rank: member.kind === 'type' || member.path === 'obj_core.stats' ? RANK.quiet + 1 : RANK[tone],
      info,
    }
  }

  function listNote({
    id,
    offset,
    raw,
    owner,
    member,
    shape,
  }: {
    id: string
    offset: number
    raw: number[]
    owner: KernelObjectRef | null
    member: ObjectMember | null
    shape: 'dlist' | 'tree'
  }): MemoryNote {
    const addr = base + offset
    const head = readLe(bytes, offset, p)
    const tail = readLe(bytes, offset + p, p)
    const waiters = ctx.threads.filter((thread) => thread.pendedOn === addr)
    // Only a dlist says "empty" in its own words. A tree's waiters are known
    // from the threads alone.
    const empty = shape === 'dlist' && head === addr && tail === addr
    const first = empty ? null : (ctx.threads.find((t) => t.addr === head && t.name) ?? null)
    const headTarget = empty || shape === 'tree' ? null : resolve(head)
    const info: ListInfo = {
      kind: 'list',
      addr,
      bytes: raw,
      ptrBytes: p,
      head,
      tail,
      owner,
      member,
      shape,
      empty,
      waiters,
      first,
      headTarget,
    }
    const role = member ? roleOf(member) : undefined
    let label: HexNoteLabel
    let tone: NoteTone
    if (empty) {
      label = owner ? { role, head: 'empty' } : { head: 'empty list?' }
      tone = 'quiet'
    } else if (waiters.length > 0) {
      const lead = first ?? waiters[0]!
      label = { role, badge: `${waiters.length} waiting`, keepBadge: true, ...splitName(lead.name) }
      tone = 'object'
    } else if (shape === 'tree') {
      label = { role, head: 'no waiters' }
      tone = 'quiet'
    } else if (headTarget) {
      label = { role, ...pointerLabel(pointerFields(head, headTarget)) }
      tone = targetTone(headTarget)
    } else {
      label = { role, head: hex(head) }
      tone = 'plain'
    }
    const follow = !empty && shape === 'dlist' && head >= MIN_POINTER
    return {
      id,
      offset,
      length: raw.length,
      tone,
      mark: empty ? 'dashed' : 'solid',
      label,
      ...(follow ? { onFollow: () => ctx.follow(head), pointsAt: head } : {}),
      group: `v:${head.toString(16)}`,
      quietAscii: true,
      rank: RANK[tone],
      info,
    }
  }

  function pointerFields(value: number, target: ResolvedAddress, thread?: ZephyrThread): PointerInfo {
    return {
      kind: 'pointer',
      addr: 0,
      bytes: [],
      value,
      target,
      self: false,
      ...(thread ? { thread } : {}),
    }
  }

  // A pair of words that both hold the first one's address is what an empty
  // sys_dlist_t looks like, known object or not.
  for (let offset = (p - (base % p)) % p; offset + 2 * p <= bytes.length; offset += p) {
    const addr = base + offset
    if (covered.has(offset) || covered.has(offset + p)) continue
    if (readLe(bytes, offset, p) !== addr || readLe(bytes, offset + p, p) !== addr) continue
    if (addr < MIN_POINTER) continue
    claim(
      listNote({
        id: `l:${addr.toString(16)}`,
        offset,
        raw: bytesOf(bytes, offset, 2 * p),
        owner: null,
        member: null,
        shape: 'dlist',
      }),
    )
  }

  const sections: MemorySection[] = []
  const seen = new Set<number>()
  for (const ref of inView) {
    if (ref.addr < base || seen.has(ref.addr)) continue
    seen.add(ref.addr)
    const name = objectName(ref)
    sections.push({
      id: `o:${ref.addr.toString(16)}`,
      offset: ref.addr - base,
      length: Math.min(ref.size, end - ref.addr),
      label: { badge: ref.struct, head: name.head, tail: name.tail, tone: 'object' },
      detail: formatStackSize(ref.size),
      info: { kind: 'object', owner: ref, members: membersFor(ref) },
    })
  }

  const roleAt = (addr: number) => {
    const where = whereIs(addr)
    if (!where?.member) return undefined
    return roleOf(where.member) + (where.delta ? `+${hex(where.delta)}` : '')
  }

  return { notes, sections: sections.sort((a, b) => a.offset - b.offset), roleAt }
}

/** `_THREAD_*` bits, include/zephyr/kernel_structs.h. */
const THREAD_STATES: ReadonlyArray<[number, string]> = [
  [0x01, 'dummy'],
  [0x02, 'pending'],
  [0x04, 'sleeping'],
  [0x08, 'dead'],
  [0x10, 'suspended'],
  [0x20, 'aborting'],
  [0x40, 'suspending'],
  [0x80, 'queued'],
]

/** `pending`, `pending sleeping`: the thread_state bits that are set. */
export function threadStateNames(value: number): string {
  return THREAD_STATES.filter(([bit]) => value & bit)
    .map(([, name]) => name)
    .join(' ')
}
