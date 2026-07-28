/**
 * Zephyr CTF event layouts: the minimal scheduling set used when the TSDL
 * metadata file cannot be fetched, mirroring scripts/tracing/trace_viewer.py.
 */

export type FieldType =
  | 'int8_t'
  | 'uint8_t'
  | 'uint16_t'
  | 'uint32_t'
  | 'int32_t'
  | 'uint64_t'
  | 'str20'

/** Scalar typedef or fixed-width CTF string (`str20` or `{ str: N }`). */
export type FieldDecl = [name: string, type: FieldType | { str: number }]

/** Built-in struct format character and byte size for each scalar typedef. */
export const SCALAR_TYPES: Record<Exclude<FieldType, 'str20'>, { code: string; size: number }> = {
  int8_t: { code: 'b', size: 1 },
  uint8_t: { code: 'B', size: 1 },
  uint16_t: { code: 'H', size: 2 },
  uint32_t: { code: 'I', size: 4 },
  int32_t: { code: 'i', size: 4 },
  uint64_t: { code: 'Q', size: 8 },
}

export const THREAD_SWITCHED_OUT = 0x10
export const THREAD_SWITCHED_IN = 0x11
export const THREAD_PRIO_SET = 0x12
export const THREAD_CREATE = 0x13
export const THREAD_INFO = 0x19
export const THREAD_NAME_SET = 0x1a
export const ISR_ENTER = 0x1b
export const ISR_EXIT = 0x1c
export const ISR_EXIT_TO_SCHEDULER = 0x1d
export const IDLE = 0x1e
export const THREAD_SCHED_PRIO_SET = 0xe9

/** Message-queue CTF ids (Zephyr TSDL). Depth is reconstructed from exits alone. */
export const MSGQ_PUT_EXIT = 0x8c
export const MSGQ_GET_EXIT = 0x8f
export const MSGQ_PURGE = 0x91
export const MSGQ_PUT_FRONT_EXIT = 0x93

/** Queue / FIFO / LIFO exit ids used by fallback decode (prefer name matching). */
export const QUEUE_APPEND_EXIT = 0x10c
export const QUEUE_ALLOC_APPEND_EXIT = 0x10e
export const QUEUE_PREPEND_EXIT = 0x110
export const QUEUE_ALLOC_PREPEND_EXIT = 0x112
export const QUEUE_INSERT_EXIT = 0x115
export const QUEUE_GET_EXIT = 0x11c
export const QUEUE_REMOVE_EXIT = 0x11e
export const QUEUE_UNIQUE_APPEND_EXIT = 0x120
export const FIFO_PUT_EXIT = 0x128
export const FIFO_ALLOC_PUT_EXIT = 0x12a
export const FIFO_GET_EXIT = 0x130
export const LIFO_PUT_EXIT = 0x138
export const LIFO_ALLOC_PUT_EXIT = 0x13a
export const LIFO_GET_EXIT = 0x13c

export const FALLBACK_EVENTS: Record<number, { name: string; fields: FieldDecl[] }> = {
  0x10: { name: 'thread_switched_out', fields: [['thread_id', 'uint32_t'], ['name', 'str20']] },
  0x11: { name: 'thread_switched_in', fields: [['thread_id', 'uint32_t'], ['name', 'str20']] },
  0x12: {
    name: 'thread_priority_set',
    fields: [
      ['thread_id', 'uint32_t'],
      ['name', 'str20'],
      ['prio', 'int8_t'],
    ],
  },
  0x13: { name: 'thread_create', fields: [['thread_id', 'uint32_t'], ['name', 'str20']] },
  0x14: { name: 'thread_abort', fields: [['thread_id', 'uint32_t'], ['name', 'str20']] },
  0x19: {
    name: 'thread_info',
    fields: [
      ['thread_id', 'uint32_t'],
      ['name', 'str20'],
      ['stack_base', 'uint32_t'],
      ['stack_size', 'uint32_t'],
    ],
  },
  0x1a: { name: 'thread_name_set', fields: [['thread_id', 'uint32_t'], ['name', 'str20']] },
  0x1b: { name: 'isr_enter', fields: [] },
  0x1c: { name: 'isr_exit', fields: [] },
  0x1d: { name: 'isr_exit_to_scheduler', fields: [] },
  0x1e: { name: 'idle', fields: [] },
  0x7f: { name: 'thread_sleep_enter', fields: [['timeout', 'uint32_t']] },
  0x80: {
    name: 'thread_sleep_exit',
    fields: [
      ['timeout', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x8a: {
    name: 'msgq_put_enter',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
    ],
  },
  0x8c: {
    name: 'msgq_put_exit',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x8d: {
    name: 'msgq_get_enter',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
    ],
  },
  0x8f: {
    name: 'msgq_get_exit',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x91: { name: 'msgq_purge', fields: [['id', 'uint32_t']] },
  0x92: {
    name: 'msgq_put_front_enter',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
    ],
  },
  0x93: {
    name: 'msgq_put_front_exit',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x17: { name: 'thread_ready', fields: [['thread_id', 'uint32_t'], ['name', 'str20']] },
  0xea: { name: 'thread_sched_ready', fields: [['thread_id', 'uint32_t'], ['name', 'str20']] },
  0x10c: { name: 'queue_append_exit', fields: [['id', 'uint32_t']] },
  0x10e: {
    name: 'queue_alloc_append_exit',
    fields: [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x110: { name: 'queue_prepend_exit', fields: [['id', 'uint32_t']] },
  0x112: {
    name: 'queue_alloc_prepend_exit',
    fields: [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x115: { name: 'queue_insert_exit', fields: [['id', 'uint32_t']] },
  0x11c: {
    name: 'queue_get_exit',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'uint32_t'],
    ],
  },
  0x11e: {
    name: 'queue_remove_exit',
    fields: [
      ['id', 'uint32_t'],
      ['ret', 'uint8_t'],
    ],
  },
  0x120: {
    name: 'queue_unique_append_exit',
    fields: [
      ['id', 'uint32_t'],
      ['ret', 'uint8_t'],
    ],
  },
  0x128: {
    name: 'fifo_put_exit',
    fields: [
      ['id', 'uint32_t'],
      ['data', 'uint32_t'],
    ],
  },
  0x12a: {
    name: 'fifo_alloc_put_exit',
    fields: [
      ['id', 'uint32_t'],
      ['data', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x130: {
    name: 'fifo_get_exit',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'uint32_t'],
    ],
  },
  0x138: {
    name: 'lifo_put_exit',
    fields: [
      ['id', 'uint32_t'],
      ['data', 'uint32_t'],
    ],
  },
  0x13a: {
    name: 'lifo_alloc_put_exit',
    fields: [
      ['id', 'uint32_t'],
      ['data', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x13c: {
    name: 'lifo_get_exit',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'uint32_t'],
    ],
  },
}

/** Thread state codes — darker/solid == closer to running. */
export type ThreadState = 'run' | 'rdy' | 'blk' | 'slp' | 'sus' | 'dead'

export const STATE_PREC: Record<ThreadState, number> = {
  run: 5,
  blk: 4,
  rdy: 3,
  slp: 2,
  sus: 1,
  dead: 0,
}

export const STATE_LABEL: Record<ThreadState, string> = {
  run: 'run',
  rdy: 'ready',
  blk: 'blocked',
  slp: 'sleep',
  sus: 'susp',
  dead: 'dead',
}

/** Colours aligned with the terminal viewer's legend. */
export const STATE_COLOR: Record<ThreadState, string> = {
  run: '#22c55e',
  rdy: '#eab308',
  blk: '#ef4444',
  slp: '#22d3ee',
  sus: '#94a3b8',
  dead: 'transparent',
}
