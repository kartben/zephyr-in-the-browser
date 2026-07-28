import { describe, expect, it } from 'vitest'
import {
  classifyQueueEvent,
  classifyQueueEnter,
  classifyQueueKinds,
  isNestedQueueEvent,
} from './queueKinds'

describe('classifyQueueEvent', () => {
  it('maps msgq exits with errno success', () => {
    expect(classifyQueueEvent('msgq_put_exit', { id: 1, ret: 0 })).toMatchObject({
      kind: 'msgq',
      flowOp: 'put',
      ok: true,
    })
    expect(classifyQueueEvent('msgq_get_exit', { id: 1, ret: -11 })).toMatchObject({
      ok: false,
    })
    expect(classifyQueueEvent('msgq_purge', { id: 1 })).toMatchObject({
      depthAction: 'purge',
      flowOp: null,
    })
  })

  it('maps msgq put/get enters for mark pairing', () => {
    expect(classifyQueueEnter('msgq_put_enter', { id: 1, timeout: 0 })).toMatchObject({
      kind: 'msgq',
      flowOp: 'put',
      id: 1,
    })
    expect(classifyQueueEnter('msgq_get_enter', { id: 2, timeout: 0 })).toMatchObject({
      flowOp: 'get',
    })
    expect(classifyQueueEnter('msgq_put_exit', { id: 1, ret: 0 })).toBeNull()
  })

  it('maps fifo put to put and get with pointer ret', () => {
    expect(classifyQueueEvent('fifo_put_exit', { id: 2, data: 9 })).toMatchObject({
      kind: 'fifo',
      flowOp: 'put',
      ok: true,
    })
    expect(classifyQueueEvent('fifo_get_exit', { id: 2, timeout: 0, ret: 0xabc })).toMatchObject({
      flowOp: 'get',
      ok: true,
    })
    expect(classifyQueueEvent('fifo_get_exit', { id: 2, timeout: 0, ret: 0 })).toMatchObject({
      ok: false,
    })
  })

  it('maps lifo put to put_front', () => {
    expect(classifyQueueEvent('lifo_put_exit', { id: 3, data: 1 })).toMatchObject({
      kind: 'lifo',
      flowOp: 'put_front',
      ok: true,
    })
  })

  it('maps stack push/pop with errno success', () => {
    expect(classifyQueueEvent('stack_push_exit', { id: 4, ret: 0 })).toMatchObject({
      kind: 'stack',
      flowOp: 'put',
      depthAction: 'put',
      ok: true,
    })
    expect(classifyQueueEvent('stack_pop_exit', { id: 4, timeout: 0, ret: 0 })).toMatchObject({
      kind: 'stack',
      flowOp: 'get',
      depthAction: 'get',
      ok: true,
    })
    expect(classifyQueueEvent('stack_pop_exit', { id: 4, timeout: 0, ret: -11 })).toMatchObject({
      ok: false,
    })
    expect(classifyQueueEnter('stack_push_enter', { id: 4 })).toMatchObject({
      kind: 'stack',
      flowOp: 'put',
    })
    expect(classifyQueueEnter('stack_pop_enter', { id: 4, timeout: 0 })).toMatchObject({
      flowOp: 'get',
    })
  })

  it('skips bulk list ops', () => {
    expect(classifyQueueEvent('fifo_put_list_exit', { id: 1, head: 0, tail: 0 })).toBeNull()
    expect(classifyQueueEvent('queue_append_list_exit', { id: 1, ret: 0 })).toBeNull()
    expect(classifyQueueEvent('queue_merge_slist_exit', { id: 1, ret: 0 })).toBeNull()
  })
})

describe('classifyQueueKinds + nested hide', () => {
  it('prefers fifo over nested queue for the same id', () => {
    const kinds = classifyQueueKinds([
      { name: 'fifo_put_enter', fields: { id: 0x1000 } },
      { name: 'queue_append_enter', fields: { id: 0x1000 } },
      { name: 'queue_append_exit', fields: { id: 0x1000 } },
      { name: 'fifo_put_exit', fields: { id: 0x1000, data: 1 } },
    ])
    expect(kinds.get(0x1000)).toBe('fifo')
    const nested = classifyQueueEvent('queue_append_exit', { id: 0x1000 })!
    expect(isNestedQueueEvent(nested, kinds)).toBe(true)
    const outer = classifyQueueEvent('fifo_put_exit', { id: 0x1000, data: 1 })!
    expect(isNestedQueueEvent(outer, kinds)).toBe(false)
  })

  it('keeps bare queue when no fifo/lifo appears', () => {
    const kinds = classifyQueueKinds([
      { name: 'queue_append_exit', fields: { id: 0x2000 } },
      { name: 'queue_get_exit', fields: { id: 0x2000, timeout: 0, ret: 1 } },
    ])
    expect(kinds.get(0x2000)).toBe('queue')
  })
})
