/**
 * Browser end of QEMU's HMP monitor.
 *
 * The emulator is built with `-chardev browser,id=mon0 -monitor chardev:mon0`,
 * a chardev backed by a ring in the shared heap. Writing `stop` into it halts
 * the machine and `cont` restarts it — and because that goes through QEMU's own
 * monitor, the big lock and the vCPU quiescing are QEMU's problem rather than
 * ours. Exporting `vm_stop()` directly would have meant hand-rolling both, with
 * `pause_all_vcpus()` blocking on the vCPU worker under wasm pthreads.
 *
 * Pausing is what makes an annotation readable: the popup can stop the guest on
 * the line it is talking about instead of narrating something that already
 * scrolled past. It is useful on its own too, which is why the top bar gets a
 * Pause button whether or not the running sample is annotated.
 *
 * Everything here degrades to a no-op when the emulator predates the bridge —
 * `available()` is false, the button hides, and annotations still show, just
 * without stopping anything. Old image tarballs stay bootable.
 */

const RESPONSE_LIMIT = 8192

interface MonitorExports {
  /** Feed one byte of command text to the monitor. */
  _qemu_browser_monitor_feed?: (value: number) => number
  /** Base of the monitor's output ring in the shared heap. */
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
  /** The machine is stopped. */
  paused: boolean
  /** Tail of what the monitor has said, for the debug view. */
  transcript: string
}

const EMPTY: MonitorState = { available: false, paused: false, transcript: '' }

let exports: MonitorExports | null = null
let state: MonitorState = EMPTY
let poll: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function publish(next: Partial<MonitorState>) {
  state = { ...state, ...next }
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

/**
 * Drain whatever the monitor has printed since the last look.
 *
 * Indices are free-running uint32 and the offset is `index % size`, matching
 * the browser netdev rings (see src/net/ringCodec.ts). Unlike those, this ring
 * carries an unframed byte stream — monitor output is just text.
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

  const transcript = (state.transcript + String.fromCharCode(...bytes)).slice(-RESPONSE_LIMIT)
  publish({ transcript })
}

/** Write a monitor command. Newline-terminated, as the HMP reader expects. */
export function send(command: string) {
  const feed = exports?._qemu_browser_monitor_feed
  if (!feed) return
  for (const ch of `${command}\n`) feed(ch.charCodeAt(0))
}

/**
 * Stop the machine.
 *
 * Idempotent: an annotation may pause while the user already has, and `stop` on
 * a stopped machine is harmless, but tracking it keeps the button honest.
 */
export function pause() {
  if (!available() || state.paused) return
  send('stop')
  publish({ paused: true })
}

export function resume() {
  if (!available() || !state.paused) return
  send('cont')
  publish({ paused: false })
}

export function toggle() {
  if (state.paused) resume()
  else pause()
}

export function attach(mod: unknown) {
  detach()
  exports = mod as MonitorExports
  state = { ...EMPTY, available: available() }
  if (state.available) {
    poll = setInterval(drain, 250)
  }
  notify()
}

export function detach() {
  if (poll !== undefined) clearInterval(poll)
  poll = undefined
  exports = null
  if (state !== EMPTY) {
    state = EMPTY
    notify()
  }
}

/**
 * Dev/mock hook: pretend the bridge is there so the walkthrough can be driven
 * without a QEMU build. The mock backend has no machine to stop, so this only
 * tracks the flag — enough for the UI to show a paused state.
 */
export function attachStub() {
  detach()
  exports = { _qemu_browser_monitor_feed: () => 0 }
  state = { available: true, paused: false, transcript: '' }
  notify()
}
