/**
 * Zephyr CTF event layouts: the minimal scheduling set used when the TSDL
 * metadata file cannot be fetched, mirroring scripts/tracing/trace_viewer.py.
 *
 * The event ids below are a complete mirror of that upstream id space, not
 * only the subset this app currently decodes — several have no consumer here
 * and are kept deliberately, so the enumeration stays diffable against Zephyr
 * whenever the tracing subsystem adds, renames, or renumbers an event.
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
/**
 * Deliberately without a consumer, and it should stay that way. `sys_trace_idle`
 * is a point event: no exit, no duration, no cpu field. Deriving an end from
 * "the next event" would fabricate residency, which is the one number the CPU
 * power band exists to report honestly — so the band is built from the balanced
 * `pm_state_set_*` pair instead (see cpuPower.ts). It also fires without
 * CONFIG_PM, so folding it in would draw a power band for guests that have no
 * power management at all. If it ever earns a consumer, the honest home is a
 * tick on the idle thread's own lane.
 */
export const IDLE = 0x1e
export const THREAD_SCHED_PRIO_SET = 0xe9

/** Power management (Zephyr TSDL 0x147–0x15A). */
export const PM_SYSTEM_SUSPEND_ENTER = 0x147
export const PM_SYSTEM_SUSPEND_EXIT = 0x148
export const PM_STATE_SET_ENTER = 0x149
export const PM_STATE_SET_EXIT = 0x14a
export const PM_SUSPEND_DEVICES_ENTER = 0x155
export const PM_SUSPEND_DEVICES_EXIT = 0x156
export const PM_RESUME_DEVICES_ENTER = 0x157
export const PM_RESUME_DEVICES_EXIT = 0x158
export const PM_DEVICE_ACTION_RUN_ENTER = 0x159
export const PM_DEVICE_ACTION_RUN_EXIT = 0x15a

/**
 * `enum pm_state` (include/zephyr/pm/state.h), indexed by the `state` field the
 * PM events carry. Index 0 is ACTIVE, i.e. "not suspended at all" — which the
 * band stores as a gap rather than a segment.
 */
export const PM_STATE_NAMES = [
  'active',
  'runtime-idle',
  'suspend-to-idle',
  'standby',
  'suspend-to-ram',
  'suspend-to-disk',
  'soft-off',
] as const

/** `enum pm_device_action` (include/zephyr/pm/device.h). */
export const PM_DEVICE_ACTION_NAMES = ['suspend', 'resume', 'turn-on', 'turn-off'] as const

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
  0x143: {
    name: 'stack_push_exit',
    fields: [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x146: {
    name: 'stack_pop_exit',
    fields: [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x147: { name: 'pm_system_suspend_enter', fields: [['ticks', 'int32_t']] },
  0x148: {
    name: 'pm_system_suspend_exit',
    fields: [
      ['ticks', 'int32_t'],
      ['state', 'uint8_t'],
    ],
  },
  0x149: {
    name: 'pm_state_set_enter',
    fields: [
      ['cpu', 'uint8_t'],
      ['state', 'uint8_t'],
      ['substate_id', 'uint8_t'],
    ],
  },
  0x14a: {
    name: 'pm_state_set_exit',
    fields: [
      ['cpu', 'uint8_t'],
      ['state', 'uint8_t'],
      ['substate_id', 'uint8_t'],
    ],
  },
  0x14b: { name: 'pm_device_runtime_get_enter', fields: [['dev', 'uint32_t']] },
  0x14c: {
    name: 'pm_device_runtime_get_exit',
    fields: [
      ['dev', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x14d: { name: 'pm_device_runtime_put_enter', fields: [['dev', 'uint32_t']] },
  0x14e: {
    name: 'pm_device_runtime_put_exit',
    fields: [
      ['dev', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x14f: {
    name: 'pm_device_runtime_put_async_enter',
    fields: [
      ['dev', 'uint32_t'],
      ['delay', 'uint32_t'],
    ],
  },
  0x150: {
    name: 'pm_device_runtime_put_async_exit',
    fields: [
      ['dev', 'uint32_t'],
      ['delay', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x151: { name: 'pm_device_runtime_enable_enter', fields: [['dev', 'uint32_t']] },
  0x152: {
    name: 'pm_device_runtime_enable_exit',
    fields: [
      ['dev', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x153: { name: 'pm_device_runtime_disable_enter', fields: [['dev', 'uint32_t']] },
  0x154: {
    name: 'pm_device_runtime_disable_exit',
    fields: [
      ['dev', 'uint32_t'],
      ['ret', 'int32_t'],
    ],
  },
  0x155: { name: 'pm_suspend_devices_enter', fields: [] },
  0x156: {
    name: 'pm_suspend_devices_exit',
    fields: [
      ['count', 'uint32_t'],
      ['ok', 'uint8_t'],
    ],
  },
  0x157: { name: 'pm_resume_devices_enter', fields: [['count', 'uint32_t']] },
  0x158: { name: 'pm_resume_devices_exit', fields: [] },
  0x159: {
    name: 'pm_device_action_run_enter',
    fields: [
      ['dev', 'uint32_t'],
      ['action', 'uint8_t'],
    ],
  },
  0x15a: {
    name: 'pm_device_action_run_exit',
    fields: [
      ['dev', 'uint32_t'],
      ['action', 'uint8_t'],
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
