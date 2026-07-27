/**
 * Browser end of QEMU's QMP monitor.
 *
 * The emulator is built with `-chardev browser,id=mon0 -mon
 * chardev=mon0,mode=control`: a character device whose two ends sit either side
 * of the wasm boundary, wired to QEMU's control monitor. Sending `stop` halts
 * the machine and `cont` restarts it, and because that goes through QEMU's own
 * monitor, the big lock and the vCPU quiescing stay QEMU's problem. Exporting
 * `vm_stop()` directly would have meant hand-rolling both, with
 * `pause_all_vcpus()` blocking on the vCPU worker under wasm pthreads.
 *
 * QMP rather than the human monitor because this is a program talking: HMP
 * echoes every keystroke back with cursor-movement escapes, which is noise to
 * parse and worse to display. QMP answers in JSON and — the part that matters —
 * emits STOP and RESUME *events*, so the paused flag here is what QEMU actually
 * did rather than what we asked for. A pause from anywhere else stays in sync.
 *
 * Pausing is what makes an annotation readable: the popup can stop the guest on
 * the line it is talking about instead of narrating something that already
 * scrolled past. It is useful on its own too, which is why the top bar gets a
 * Pause button whether or not the running sample is annotated.
 *
 * Step 1 of in-page debugging reuses this same channel: when the machine is
 * stopped we ask for `info registers` (via `human-monitor-command`). There is
 * no HMP one-instruction step in QEMU 10.1 — that needs the gdbstub (see
 * docs/debug-gdb-plan.md). Until then this is a quiet "what is the PC" view
 * without a QEMU rebuild.
 *
 * Everything degrades to a no-op on an emulator built before the bridge —
 * `available()` is false, the button hides, annotations still show but stop
 * nothing. Old image tarballs stay bootable.
 */

import { parseRegisters } from '@/debug/parseRegisters'
import { register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'

const POLL_ID = 'monitor'
const POLL_MS = 100
const REQUEST_TIMEOUT_MS = 3000

interface MonitorExports {
  /** Queue one byte of command text towards the monitor. */
  _qemu_browser_monitor_feed?: (value: number) => number
  /** The output ring: base pointer, size, and free-running indices. */
  _qemu_browser_monitor_ring?: () => number
  _qemu_browser_monitor_ring_size?: () => number
  _qemu_browser_monitor_read_index?: () => number
  _qemu_browser_monitor_write_index?: () => number
  _qemu_browser_monitor_set_read_index?: (value: number) => void
  HEAPU8?: Uint8Array
}

export interface MonitorState {
  /** The emulator exposes the bridge at all. */
  available: boolean
  /** The machine is stopped, as QEMU last reported it. */
  paused: boolean
  /** Parsed PC from the last register dump, when paused. */
  pc: string | null
  /** One-line PC summary for a closed chip. */
  summary: string | null
  /** Raw `info registers` text while paused; cleared on resume. */
  registers: string | null
  /** True while a register refresh is in flight. */
  registersLoading: boolean
}

const EMPTY: MonitorState = {
  available: false,
  paused: false,
  pc: null,
  summary: null,
  registers: null,
  registersLoading: false,
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let exports: MonitorExports | null = null
let state: MonitorState = EMPTY
let pending = ''
let negotiated = false
/** The mock stand-in, which has no machine and so never sends events. */
let stub = false
/** Fake HMP replies for attachStub / tests. */
let stubRegisters = 'R15=0000abcd\n'
let nextId = 1
const pendingCmds = new Map<string, Pending>()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function publish(next: Partial<MonitorState>) {
  const merged = { ...state, ...next }
  if (
    merged.available === state.available &&
    merged.paused === state.paused &&
    merged.pc === state.pc &&
    merged.summary === state.summary &&
    merged.registers === state.registers &&
    merged.registersLoading === state.registersLoading
  ) {
    return
  }
  state = merged
  notify()
}

function clearRegisters() {
  publish({ pc: null, summary: null, registers: null, registersLoading: false })
}

function rejectAllPending(reason: string) {
  for (const [, p] of pendingCmds) {
    clearTimeout(p.timer)
    p.reject(new Error(reason))
  }
  pendingCmds.clear()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): MonitorState {
  return state
}

export function available(): boolean {
  return typeof exports?._qemu_browser_monitor_feed === 'function'
}

/** Send one QMP command object. */
function send(command: Record<string, unknown>) {
  const feed = exports?._qemu_browser_monitor_feed
  if (!feed) return
  const text = `${JSON.stringify(command)}\n`
  for (let i = 0; i < text.length; i++) feed(text.charCodeAt(i))
}

/**
 * Send a QMP command and wait for the matching `id` reply.
 *
 * Pause / resume stay fire-and-forget: the STOP/RESUME events are the source
 * of truth for `paused`. Register dumps need the return value.
 */
function request(command: Record<string, unknown>): Promise<unknown> {
  if (stub) {
    const line = (command.arguments as { 'command-line'?: string } | undefined)?.['command-line']
    if (line === 'info registers') return Promise.resolve(stubRegisters)
    return Promise.resolve({})
  }
  if (!available()) return Promise.reject(new Error('monitor unavailable'))

  const id = `m${nextId++}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCmds.delete(id)
      reject(new Error(`QMP request ${id} timed out`))
    }, REQUEST_TIMEOUT_MS)
    pendingCmds.set(id, { resolve, reject, timer })
    send({ ...command, id })
  })
}

function applyRegisterDump(dump: string) {
  const parsed = parseRegisters(dump)
  publish({
    registers: dump.trimEnd(),
    pc: parsed.pc,
    summary: parsed.summary,
    registersLoading: false,
  })
}

/** Ask QEMU for a fresh `info registers` dump. No-op unless paused. */
export async function refreshRegisters(): Promise<void> {
  if (!available() || !state.paused) return
  publish({ registersLoading: true })
  try {
    const ret = await request({
      execute: 'human-monitor-command',
      arguments: { 'command-line': 'info registers' },
    })
    if (!state.paused) {
      clearRegisters()
      return
    }
    if (typeof ret === 'string') applyRegisterDump(ret)
    else publish({ registersLoading: false })
  } catch {
    if (state.paused) publish({ registersLoading: false })
  }
}

function onPaused(paused: boolean) {
  if (paused === state.paused) {
    if (paused && !state.registers && !state.registersLoading) void refreshRegisters()
    return
  }
  if (paused) {
    publish({ paused: true })
    void refreshRegisters()
  } else {
    publish({ paused: false, pc: null, summary: null, registers: null, registersLoading: false })
  }
}

function handleMessage(message: Record<string, unknown>) {
  // The greeting: QMP stays in capabilities-negotiation mode until answered,
  // and rejects every other command meanwhile.
  if ('QMP' in message && !negotiated) {
    negotiated = true
    send({ execute: 'qmp_capabilities' })
    send({ execute: 'query-status' })
    return
  }

  const id = message.id
  if (typeof id === 'string' || typeof id === 'number') {
    const key = String(id)
    const waiter = pendingCmds.get(key)
    if (waiter) {
      pendingCmds.delete(key)
      clearTimeout(waiter.timer)
      if (message.error) {
        const err = message.error as { desc?: string }
        waiter.reject(new Error(err.desc ?? 'QMP error'))
      } else {
        waiter.resolve(message.return)
      }
    }
  }

  const event = message.event
  if (event === 'STOP') onPaused(true)
  else if (event === 'RESUME') onPaused(false)

  const ret = message.return
  if (typeof ret === 'object' && ret !== null && 'running' in ret) {
    onPaused(!(ret as { running: boolean }).running)
  }
}

/**
 * Drain the output ring and parse whatever whole lines it holds.
 *
 * Indices are free-running uint32 and the offset is `index % size`, matching
 * the browser netdev rings (see src/net/ringCodec.ts). QMP is line-delimited
 * JSON, so a partial tail is kept for the next tick.
 */
function drain() {
  const mod = exports
  const heap = mod?.HEAPU8
  if (!mod || !heap || !mod._qemu_browser_monitor_ring) return
  const readIdx = mod._qemu_browser_monitor_read_index
  const writeIdx = mod._qemu_browser_monitor_write_index
  const setRead = mod._qemu_browser_monitor_set_read_index
  if (!readIdx || !writeIdx || !setRead) return

  const size = mod._qemu_browser_monitor_ring_size?.() ?? 0
  if (size <= 0) return
  const base = mod._qemu_browser_monitor_ring()
  let read = readIdx()
  const write = writeIdx()
  if (read === write) return

  const bytes: number[] = []
  while (read !== write) {
    bytes.push(heap[base + (read % size)])
    read = (read + 1) >>> 0
  }
  setRead(read)

  pending += String.fromCharCode(...bytes)
  let nl: number
  while ((nl = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, nl).trim()
    pending = pending.slice(nl + 1)
    if (!line) continue
    try {
      handleMessage(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // Not our line, or a truncated one after a ring overrun. Skip it.
    }
  }
}

/**
 * Stop the machine.
 *
 * The paused flag is not set here — it moves when QEMU's STOP event arrives,
 * so the button always reflects the machine rather than the request.
 */
export function pause() {
  if (!available() || state.paused) return
  send({ execute: 'stop' })
  if (stub) onPaused(true)
}

export function resume() {
  if (!available() || !state.paused) return
  send({ execute: 'cont' })
  if (stub) onPaused(false)
}

export function toggle() {
  if (state.paused) resume()
  else pause()
}

export function attach(mod: unknown) {
  detach()
  exports = mod as MonitorExports
  stub = false
  if (available()) {
    // The greeting is already waiting in the ring; drain() answers it.
    registerPoll(POLL_ID, POLL_MS, drain)
    publish({ available: true, paused: false })
  }
}

export function detach() {
  unregisterPoll(POLL_ID)
  rejectAllPending('monitor detached')
  exports = null
  pending = ''
  negotiated = false
  stub = false
  nextId = 1
  if (state !== EMPTY) {
    state = EMPTY
    notify()
  }
}

/**
 * Dev/mock hook: pretend the bridge is there so a walkthrough can be driven
 * without a QEMU build. The mock has no machine to stop, so this only tracks
 * the flag — enough for the UI to show a paused state. Register dumps come
 * from a canned Cortex-M line so the debug popover can be exercised too.
 */
export function attachStub(registers = 'R15=0000abcd\n') {
  detach()
  exports = { _qemu_browser_monitor_feed: () => 0 }
  stub = true
  stubRegisters = registers
  state = { ...EMPTY, available: true, paused: false }
  notify()
}

/** Test helper: push a raw QMP line through the parser. */
export function injectForTests(line: string) {
  handleMessage(JSON.parse(line) as Record<string, unknown>)
}

/** Test helper: reset module state between cases. */
export function resetForTests() {
  detach()
}
