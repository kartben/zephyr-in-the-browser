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

export type FieldDecl = [name: string, type: FieldType]

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
