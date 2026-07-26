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
 * Everything degrades to a no-op on an emulator built before the bridge —
 * `available()` is false, the button hides, annotations still show but stop
 * nothing. Old image tarballs stay bootable.
 */

const POLL_MS = 120

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
}

const EMPTY: MonitorState = { available: false, paused: false }

let exports: MonitorExports | null = null
let state: MonitorState = EMPTY
let poll: ReturnType<typeof setInterval> | undefined
let pending = ''
let negotiated = false
/** The mock stand-in, which has no machine and so never sends events. */
let stub = false
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function publish(next: Partial<MonitorState>) {
  const merged = { ...state, ...next }
  if (merged.available === state.available && merged.paused === state.paused) return
  state = merged
  notify()
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

function handleMessage(message: Record<string, unknown>) {
  // The greeting: QMP stays in capabilities-negotiation mode until answered,
  // and rejects every other command meanwhile.
  if ('QMP' in message && !negotiated) {
    negotiated = true
    send({ execute: 'qmp_capabilities' })
    send({ execute: 'query-status' })
    return
  }

  const event = message.event
  if (event === 'STOP') publish({ paused: true })
  else if (event === 'RESUME') publish({ paused: false })

  const ret = message.return
  if (typeof ret === 'object' && ret !== null && 'running' in ret) {
    publish({ paused: !(ret as { running: boolean }).running })
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
  if (stub) publish({ paused: true })
}

export function resume() {
  if (!available() || !state.paused) return
  send({ execute: 'cont' })
  if (stub) publish({ paused: false })
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
    poll = setInterval(drain, POLL_MS)
    publish({ available: true, paused: false })
  }
}

export function detach() {
  if (poll !== undefined) clearInterval(poll)
  poll = undefined
  exports = null
  pending = ''
  negotiated = false
  stub = false
  if (state !== EMPTY) {
    state = EMPTY
    notify()
  }
}

/**
 * Dev/mock hook: pretend the bridge is there so a walkthrough can be driven
 * without a QEMU build. The mock has no machine to stop, so this only tracks
 * the flag — enough for the UI to show a paused state.
 */
export function attachStub() {
  detach()
  exports = { _qemu_browser_monitor_feed: () => 0 }
  stub = true
  state = { available: true, paused: false }
  notify()
}
