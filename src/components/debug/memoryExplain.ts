/**
 * The inspector's sentences for what the layout knows: list heads, members,
 * and the object a section line starts.
 *
 * Stated plainly where DWARF and object core back it (`k_sem.count` is the
 * count), hedged where only a byte pattern does ("probably"), and always in
 * terms a student can check against the Zephyr source.
 */

import { describeTarget, hex, structName } from '@/components/debug/memoryLabels'
import type {
  KernelObjectRef,
  ListInfo,
  MemberInfo,
  Where,
} from '@/components/debug/memoryStructure'
import { formatStackSize } from '@/debug/kernel/threads'

const NOUN: Record<string, string> = {
  k_sem: 'semaphore',
  k_mutex: 'mutex',
  k_event: 'event',
  k_msgq: 'message queue',
  k_stack: 'stack',
  k_mem_slab: 'memory slab',
  k_timer: 'timer',
  k_condvar: 'condition variable',
  k_thread: 'thread',
  k_queue: 'queue',
  k_fifo: 'FIFO',
  k_lifo: 'LIFO',
  k_pipe: 'pipe',
  k_mbox: 'mailbox',
}

/** `semaphore`, falling back to the C type. */
export function nounFor(struct: string): string {
  return NOUN[struct] ?? struct
}

/** `k_sem shell_uart_ctx+0x300`, or a thread by the name the Threads tab uses. */
export function objectTitle(ref: KernelObjectRef): string {
  return ref.thread ? `${ref.struct} ${ref.thread.name}` : `${ref.struct} ${ref.name}`
}

/** `.wait_q of k_event shell_uart_ctx+0x2d0`, `k_thread shell_uart`. */
export function whereText(where: Where): string {
  const member = where.member ? `.${where.member.path}` : ''
  const delta = where.delta ? `+${hex(where.delta)}` : ''
  if (!member) return `${objectTitle(where.object)}${delta}`
  return `${member}${delta} of ${objectTitle(where.object)}`
}

function names(threads: readonly { name: string }[]): string {
  return threads.map((thread) => thread.name).join(', ')
}

export function explainList(info: ListInfo): string {
  const own = hex(info.addr)
  if (!info.owner || !info.member) {
    return `Both words hold ${own}, the address of the first. That is what an empty Zephyr list (sys_dlist_t) looks like, so this is probably one.`
  }
  const path = `${info.owner.struct}.${info.member.path}`
  const noun = nounFor(info.owner.struct)
  const isWaitQueue = info.member.kind === 'waitq'
  const n = info.waiters.length
  const pended =
    n === 0
      ? 'No thread is pended on it.'
      : n === 1
        ? `One thread is pended on it: ${info.waiters[0]!.name}.`
        : `${n} threads are pended on it: ${names(info.waiters)}.`

  if (info.shape === 'tree') {
    return `${path} is a red-black tree in this build (CONFIG_WAITQ_SCALABLE), not a list, so its words are tree pointers. ${pended}`
  }
  if (info.empty) {
    const nobody = isWaitQueue ? ` No thread is waiting on this ${noun}.` : ''
    return `${path} (sys_dlist_t) is empty: head and tail both hold ${own}, the list's own address. That is how a Zephyr dlist says it has no nodes.${nobody}`
  }
  if (isWaitQueue && n > 0) {
    const first = info.first?.name ?? info.waiters[0]!.name
    if (n === 1 && info.head === info.tail) {
      return `Head and tail point at the same node, so exactly one thread is waiting: ${first}. The node is its base.qnode_dlist, at offset 0 of k_thread, which is why the address is the thread's own.`
    }
    return `${n} threads are waiting (each one's pended_on says so), first in line ${first}. Head and tail point at the first and last one's base.qnode_dlist; the nodes link to each other and the last points back here.`
  }
  if (info.member.path === 'poll_events') {
    return `${path} holds the k_poll events waiting on this ${noun}, not threads. Head ${hex(info.head)}, tail ${hex(info.tail)}.`
  }
  const target = info.headTarget ? `, ${describeTarget({ target: info.headTarget })}` : ''
  return `${path} is a list (sys_dlist_t). Its head points at ${hex(info.head)}${target}, its tail at ${hex(info.tail)}: the nodes are embedded in whatever the list holds.`
}

export function explainMember(info: MemberInfo): string {
  const { owner, member } = info
  const path = `${owner.struct}.${member.path}`
  const noun = nounFor(owner.struct)
  const value = hex(info.value)

  switch (member.kind) {
    case 'string':
      return `${path} is a C string: "${info.text ?? ''}".`
    case 'number':
    case 'signed':
      return `${path} is ${member.size === 1 ? 'one byte' : `${member.size} bytes, lowest first,`} = ${info.value}.`
    case 'flags':
      return `${path} is a bit field: ${value}.`
    case 'next': {
      if (info.value === 0) {
        return `${path} is NULL: this is the last ${owner.struct} on object core's list of them.`
      }
      const coreOffset = member.addr - owner.addr
      return `Object core keeps every ${owner.struct} on one singly linked list (sys_slist_t) through .obj_core. This is the next link. It lands on the .obj_core of the next ${noun}, not on its start: subtract ${hex(coreOffset)} to get that ${owner.struct} (container_of).`
    }
    case 'type':
      return `${path} points at ${info.target?.name ?? value}, the k_obj_type descriptor every ${owner.struct} shares.`
    case 'dnode': {
      if (!info.where && !info.target) {
        return `${path} is not linked: ${owner.thread?.name ?? 'this thread'} is in no wait or ready queue right now.`
      }
      const who = owner.thread?.name ?? 'This thread'
      const next = info.where ? whereText(info.where) : value
      if (info.prev?.value === info.value) {
        return `${who}'s queue node: next and prev both → ${next}, so it is the only node in that list. A pended thread sits in its wait queue by this node.`
      }
      const prev = info.prev?.where ? whereText(info.prev.where) : hex(info.prev?.value ?? 0)
      return `${who}'s queue node: next → ${next}, prev → ${prev}. A pended thread sits in its wait queue by this node; the list's first and last nodes point back at the list head.`
    }
    default:
      break
  }

  if (info.value === 0) {
    if (member.path === 'owner') return `${path} is NULL: no thread holds this ${noun}.`
    if (member.path === 'base.pended_on') return `${path} is NULL: ${owner.thread?.name ?? 'the thread'} is not waiting on anything.`
    return `${path} is NULL.`
  }
  if (info.where) {
    return `${path} holds ${value}: the ${whereText(info.where)}.`
  }
  if (info.target) {
    const what = describeTarget({ target: info.target, ...(info.thread ? { thread: info.thread } : {}) })
    return member.kind === 'pointer'
      ? `${path} holds ${value}, the address of ${what}.`
      : `${path} holds ${value}, the address of ${what}, so it is probably a pointer to it.`
  }
  return `${path} holds ${value}.`
}

/** `k_sem shell_uart_ctx+0x300 · 48 B at 0x4005bd20`. */
export function describeObject(ref: KernelObjectRef): string {
  return `${objectTitle(ref)} · ${formatStackSize(ref.size)} at ${hex(ref.addr)}`
}

/** The member offsets, `wait_q +0x0 · count +0x10`, as a map of the object. */
export function memberMap(ref: KernelObjectRef, members: readonly { path: string; addr: number }[]): string {
  const top = new Map<string, number>()
  for (const member of members) {
    const name = member.path.split('.')[0]!
    if (!top.has(name)) top.set(name, member.addr - ref.addr)
  }
  return [...top].map(([name, offset]) => `${name} +${hex(offset)}`).join(' · ')
}

export { structName }
