/**
 * The inspector's sentences for what the layout knows: list heads, members,
 * and the object a section line starts.
 *
 * Stated plainly where DWARF and object core back it (`k_sem.count` is the
 * count), hedged where only a byte pattern does ("probably"), and always in
 * terms a student can check against the Zephyr source.
 */

import { hex, landsOn, structName } from '@/components/debug/memoryLabels'
import {
  threadStateNames,
  type KernelObjectRef,
  type ListInfo,
  type MemberInfo,
  type Where,
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

/** What a number means, for the members a student meets first. */
const MEANING: Record<string, string> = {
  'k_sem.count':
    'k_sem_take() returns at once while it is above 0 and takes one; k_sem_give() adds one, up to .limit.',
  'k_sem.limit': 'the most .count can reach.',
  'k_mutex.lock_count':
    'how many times the owner has locked it without unlocking yet (a Zephyr mutex is recursive).',
  'k_event.events': 'the event bits posted so far; a waiter wakes when the bits it asked for are set.',
  'k_timer.status': 'how many times it has expired since its status was last read.',
  'k_thread.base.prio': 'its scheduling priority: lower runs first, and negative means cooperative.',
  'k_thread.base.user_options': 'thread options such as K_ESSENTIAL, as bits.',
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
    if (n === 1 && info.head === info.tail) {
      const only = info.first?.name ?? info.waiters[0]!.name
      return `Head and tail point at the same node, so exactly one thread is waiting: ${only}. The node is its base.qnode_dlist, at offset 0 of k_thread, which is why the address is the thread's own.`
    }
    if (n === 1) {
      return `One thread is pended on it (its pended_on says so): ${info.waiters[0]!.name}. Head ${hex(info.head)} and tail ${hex(info.tail)} disagree, so the list is being changed or the window is stale.`
    }
    const first = info.first ? `, first in line ${info.first.name}` : ''
    return `${n} threads are waiting (each one's pended_on says so)${first}: ${names(info.waiters)}. Head and tail point at the first and last one's base.qnode_dlist; the nodes link to each other, and the first one's prev and the last one's next point back here.`
  }
  if (info.member.path === 'poll_events') {
    return `${path} holds the k_poll events waiting on this ${noun}, not threads. Head ${hex(info.head)}, tail ${hex(info.tail)}.`
  }
  const target = info.headTarget ? `, ${landsOn({ target: info.headTarget })}` : ''
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
    case 'signed': {
      const meaning = MEANING[path]
      return meaning
        ? `${path} = ${info.value}: ${meaning}`
        : `${path} = ${info.value} (${member.size === 1 ? 'one byte' : `${member.size} bytes`}${member.kind === 'signed' ? ', signed' : ''}).`
    }
    case 'flags': {
      if (member.path === 'base.thread_state') {
        const set = threadStateNames(info.value)
        return `${path} = ${value}${set ? `: ${set}` : ''} (the _THREAD_* bits of kernel_structs.h).`
      }
      const bits = [...Array(member.size * 8).keys()].filter((bit) => info.value & (1 << bit))
      const which =
        bits.length === 0 ? 'no bits set' : `${bits.length === 1 ? 'bit' : 'bits'} ${bits.join(', ')} set`
      const meaning = MEANING[path]
      return `${path} = ${value}, ${which}${meaning ? `: ${meaning}` : '.'}`
    }
    case 'next': {
      if (info.value === 0) {
        return `${path} is NULL: this is the last ${owner.struct} on object core's list of them.`
      }
      const coreOffset = member.addr - owner.addr
      const next = info.target ? `, ${owner.struct} ${info.target.name.replace(/\.obj_core$/, '')}` : ''
      return `Object core keeps every ${owner.struct} on one singly linked list (sys_slist_t) through .obj_core. This is the next link. It lands on the .obj_core of the next ${noun}${next}, not on its start: subtract ${hex(coreOffset)} to get that ${owner.struct} (container_of).`
    }
    case 'type':
      return `${path} points at ${info.target?.name ?? value}, the k_obj_type descriptor every ${owner.struct} shares.`
    case 'dnode': {
      if (!info.where && !info.target) {
        return `${path} is not linked: ${owner.thread?.name ?? 'this thread'} is in no wait or ready queue right now.`
      }
      const who = owner.thread?.name ?? 'This thread'
      const next = info.where ? whereText(info.where) : value
      const why =
        'A thread sits in at most one queue at a time by this node: the ready queue while it is ready, a wait queue while it is pended.'
      if (info.prev?.value === info.value) {
        return `${who}'s queue node: next and prev both → ${next}, so it is the only node in that list. ${why}`
      }
      const prev = info.prev?.where ? whereText(info.prev.where) : hex(info.prev?.value ?? 0)
      return `${who}'s queue node: next → ${next}, prev → ${prev}. ${why}`
    }
    default:
      break
  }

  const who = owner.thread?.name ?? 'the thread'
  if (member.path.startsWith('callee_saved.')) {
    const reg = member.path.slice('callee_saved.'.length)
    const returns = info.target?.kind === 'code' && info.target.offset > 0 ? ': a return address' : ''
    const held = info.target ? `, ${landsOn(targetOf(info))}${returns}` : ''
    return `${path}: register ${reg} as it was when ${who} was last switched out, kept here until it runs again (stale while it runs). It holds ${value}${held}. Only callee-saved registers live here; the others were saved on its stack.`
  }
  if (member.path === 'entry.pEntry' && info.target) {
    return `${path}: the function ${who} was created to run, ${info.target.name}. k_thread_create() stored it here.`
  }
  const argument = /^entry\.parameter(\d)$/.exec(member.path)
  if (argument) {
    const nth = ['first', 'second', 'third'][Number(argument[1]) - 1] ?? 'an'
    const held = info.target ? `, ${landsOn(targetOf(info))}` : ''
    return `${path}: the ${nth} argument ${who} was created with, ${value}${held}.`
  }
  if (info.value === 0) {
    if (member.path === 'owner') return `${path} is NULL: no thread holds this ${noun}.`
    if (member.path === 'base.pended_on') {
      return `${path} is NULL: ${who} is in no wait queue. A sleeping or suspended thread has NULL here too; .thread_state says which.`
    }
    return `${path} is NULL.`
  }
  if (info.where) {
    return `${path} holds ${value}: the ${whereText(info.where)}.`
  }
  if (info.target) {
    const where = landsOn(targetOf(info))
    if (member.path === 'base.pended_on' && info.target.kind === 'stack') {
      return `${path} holds ${value}, ${where}: a wait queue on its own stack, the way k_poll() waits.`
    }
    if (member.path === 'owner' && info.thread) {
      return `${path} holds ${value}, ${where}: that thread holds this ${noun}.`
    }
    return member.kind === 'pointer'
      ? `${path} holds ${value}, ${where}.`
      : `${path} holds ${value}, ${where}, so it is probably a pointer.`
  }
  return `${path} holds ${value}.`
}

function targetOf(info: MemberInfo) {
  return {
    target: info.target!,
    ...(info.thread ? { thread: info.thread } : {}),
    ...(info.stackOf ? { stackOf: info.stackOf } : {}),
  }
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
