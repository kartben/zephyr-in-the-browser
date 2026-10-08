/**
 * Browser end of uart1, the emulated board's second UART, and its pipe to a
 * real serial port through Web Serial (src/serial/webSerial.ts).
 *
 * The emulator exposes uart1 as a two-way `browser` chardev slot (UART1_ARGS).
 * With no port connected the slot carries the simulated GNSS fix
 * (src/hostGnss.ts) and whatever the guest transmits goes nowhere, as it always
 * did. Connect a port and the slot belongs to it: bytes the adapter receives go
 * to the guest, bytes the guest sends go out of the adapter, and the simulated
 * fix pauses.
 *
 * The saved choice (src/lib/serialStore.ts) brings the pipe back after a
 * restart: navigator.serial.getPorts() returns the ports this origin was
 * granted without a user gesture, so the one with the saved USB IDs reopens on
 * its own, or the pipe waits for it to be plugged in. Only when the guest's
 * devicetree enables uart1, though: a sample that never uses it would hold the
 * port with no dock card to let it go.
 */

import {
  bindChardev,
  chardevAvailable,
  drainBytes,
  feedBytes,
  feedSome,
  type ChardevExports,
} from '@/debug/browserChardev'
import {
  get as getDeviceTree,
  getPhase as getDeviceTreePhase,
  subscribe as subscribeDeviceTree,
} from '@/devicetree'
import { defaultPipe, getPipe, setPipe, type UartPipeSettings } from '@/lib/serialStore'
import {
  describeIds,
  describePort,
  findGrantedPort,
  getSerial,
  openErrorMessage,
  type SerialPortLike,
} from '@/serial/webSerial'

export type UartPipePhase = 'idle' | 'opening' | 'open' | 'waiting' | 'error'

export interface UartPipeSnapshot {
  /** The emulator has the two-way uart1 slot. */
  available: boolean
  /** The browser has Web Serial. */
  supported: boolean
  phase: UartPipePhase
  /** The port open, opening or waited for; '' when there is none. */
  portLabel: string
  /** Bytes from the port to the guest, from the guest to the port. */
  rx: number
  tx: number
  /** Guest bytes thrown away because the port could not keep up. */
  dropped: number
  error: string
}

const POLL_MS = 10
/** Stop reading the port while this much is still waiting for the guest. */
const RX_HIGH_WATER = 16 * 1024
/** Guest output beyond this, unsent, is dropped rather than queued forever. */
const TX_CAP = 256 * 1024
/** As the desktop bridge's serialOpenTimeout: a wedged USB node never answers. */
const OPEN_TIMEOUT_MS = 5000
/** Counters change every tick; the dock does not need to repaint that often. */
const PUBLISH_MS = 250

const IDLE: UartPipeSnapshot = {
  available: false,
  supported: false,
  phase: 'idle',
  portLabel: '',
  rx: 0,
  tx: 0,
  dropped: 0,
  error: '',
}

let snapshot: UartPipeSnapshot = { ...IDLE, supported: getSerial() !== null }
const listeners = new Set<() => void>()

let ch: ChardevExports | null = null
/** Devicetree node name of the board's uart1, `uart@4000d000`. */
let uartNode: string | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let unhook: Array<() => void> = []

let port: SerialPortLike | null = null
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let readDone: Promise<void> = Promise.resolve()
/** Bumped on every open and close; async work from an older one gives up. */
let session = 0
let autoConnecting = false

let rxQueue: Uint8Array[] = []
let rxQueued = 0
let txPending = 0
const counters = { rx: 0, tx: 0, dropped: 0 }
let lastPublish = 0

function setSnapshot(patch: Partial<UartPipeSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): UartPipeSnapshot {
  return snapshot
}

export function available(): boolean {
  return snapshot.available
}

/**
 * A port owns uart1, or is about to: open, opening, or saved and waited for.
 * The simulated GNSS fix stays off the wire for all three.
 */
export function ownsUart(phase: UartPipePhase): boolean {
  return phase === 'open' || phase === 'opening' || phase === 'waiting'
}

export function isPiped(): boolean {
  return ownsUart(snapshot.phase)
}

/**
 * Bind uart1's chardev exports from an Emscripten Module. `node` is the
 * devicetree node name of the board's uart1, which decides whether the guest
 * uses it at all.
 */
export function attach(mod: unknown, node: string | null) {
  detach()
  const bound = bindChardev(mod as Record<string, unknown>, 'uart1')
  if (!chardevAvailable(bound)) return
  ch = bound
  uartNode = node
  counters.rx = counters.tx = counters.dropped = 0
  lastPublish = 0
  setSnapshot({ ...IDLE, available: true, supported: getSerial() !== null })
  pollTimer = setInterval(poll, POLL_MS)

  const serial = getSerial()
  if (serial) {
    const onConnect = () => void autoConnect()
    const onDisconnect = (event: Event) => {
      if (port && event.target === port) void lost(session)
    }
    serial.addEventListener('connect', onConnect)
    serial.addEventListener('disconnect', onDisconnect)
    unhook.push(() => {
      serial.removeEventListener('connect', onConnect)
      serial.removeEventListener('disconnect', onDisconnect)
    })
  }
  // The tree arrives after boot starts; the pipe may only open once it says
  // the guest has a uart1.
  unhook.push(subscribeDeviceTree(() => void autoConnect()))
  void autoConnect()
}

export function detach() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  for (const fn of unhook) fn()
  unhook = []
  void closePort()
  ch = null
  uartNode = null
  setSnapshot({ ...IDLE, supported: getSerial() !== null })
}

/**
 * Hand the simulated GNSS fix to the guest. False when the emulator predates
 * the uart1 slot, so the caller uses the old receive-only feed instead.
 */
export function feedSimulated(text: string): boolean {
  if (!ch) return false
  if (!isPiped()) feedBytes(ch, text)
  return true
}

/**
 * Show the browser's port picker, then pipe uart1 to the chosen port. Call it
 * straight from a click handler: requestPort() needs the user's gesture, and
 * an await before it would spend that gesture.
 */
export function chooseAndConnect(baudRate: number): void {
  const serial = getSerial()
  if (!serial || !ch) return
  let request: Promise<SerialPortLike>
  try {
    request = serial.requestPort()
  } catch (err) {
    setSnapshot({ phase: 'error', error: openErrorMessage(err, 'the port') })
    return
  }
  request.then(
    async (picked) => {
      await closePort()
      await openPort(picked, baudRate)
    },
    (err: unknown) => {
      // Closing the picker without choosing is not an error worth showing.
      if (err instanceof DOMException && err.name === 'NotFoundError') return
      setSnapshot({ phase: 'error', error: openErrorMessage(err, 'the port') })
    },
  )
}

/** Close the port, and forget it so a restart does not reopen it. */
export async function disconnect(): Promise<void> {
  await closePort()
  const saved = getPipe('uart1')
  if (saved) setPipe('uart1', { baudRate: saved.baudRate, autoReconnect: saved.autoReconnect })
  setSnapshot({ phase: 'idle', portLabel: '', error: '' })
}

/** Remember the rate, and reopen the port at it if one is open. */
export async function setBaudRate(baudRate: number): Promise<void> {
  const saved = getPipe('uart1') ?? defaultPipe()
  setPipe('uart1', { ...saved, baudRate })
  const open = port
  if (!open || snapshot.phase !== 'open') return
  await closePort()
  await openPort(open, baudRate)
}

export function setAutoReconnect(on: boolean): void {
  const saved = getPipe('uart1') ?? defaultPipe()
  setPipe('uart1', { ...saved, autoReconnect: on })
}

/** Whether the guest's devicetree enables the board's uart1. */
function guestUsesUart(): boolean {
  const phase = getDeviceTreePhase()
  if (phase === 'pending') return false
  const insights = getDeviceTree()?.insights
  // No tree: the dock falls back to its static table, which lists uart1.
  if (!insights || !uartNode) return true
  return insights.uartBuses.some((bus) => bus.path.split('/').pop() === uartNode)
}

function savedIdentity(saved: UartPipeSettings | undefined): saved is Required<UartPipeSettings> {
  return saved !== undefined && saved.vid !== undefined && saved.pid !== undefined
}

/** Reopen the saved port, or wait for it, when the guest uses uart1. */
async function autoConnect(): Promise<void> {
  // An error does not block this: replugging a wedged adapter is the fix the
  // error asks for, and its `connect` event lands here.
  if (!ch || port || autoConnecting) return
  const saved = getPipe('uart1')
  if (!savedIdentity(saved) || !saved.autoReconnect || !guestUsesUart()) return
  autoConnecting = true
  try {
    const found = await findGrantedPort(saved.vid, saved.pid)
    if (!ch || port) return
    if (found) await openPort(found, saved.baudRate)
    else setSnapshot({ phase: 'waiting', portLabel: describeIds(saved.vid, saved.pid), error: '' })
  } catch {
    // getPorts() failing leaves the pipe idle; the user can still pick a port.
  } finally {
    autoConnecting = false
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException('open timed out', 'TimeoutError')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function openPort(picked: SerialPortLike, baudRate: number): Promise<void> {
  const mine = ++session
  port = picked
  const label = describePort(picked.getInfo())
  setSnapshot({ phase: 'opening', portLabel: label, error: '' })
  const opening = picked.open({ baudRate })
  try {
    await withTimeout(opening, OPEN_TIMEOUT_MS)
  } catch (err) {
    if (mine !== session) return
    port = null
    // An open that lands after the timeout still holds the port: give it back.
    opening.then(() => picked.close().catch(() => {}), () => {})
    setSnapshot({ phase: 'error', error: openErrorMessage(err, label) })
    return
  }
  if (mine !== session) return

  const info = picked.getInfo()
  const saved = getPipe('uart1') ?? defaultPipe()
  setPipe('uart1', {
    ...(info.usbVendorId !== undefined && info.usbProductId !== undefined
      ? { vid: info.usbVendorId, pid: info.usbProductId }
      : {}),
    baudRate,
    autoReconnect: saved.autoReconnect,
  })
  writer = picked.writable?.getWriter() ?? null
  readDone = readLoop(picked, mine)
  setSnapshot({ phase: 'open', error: '' })
}

async function readLoop(from: SerialPortLike, mine: number): Promise<void> {
  // The spec's own loop: a framing, parity, overrun or break error ends one
  // stream and the port hands out a fresh one; losing the device leaves
  // `readable` null.
  while (mine === session && from.readable) {
    const r = from.readable.getReader()
    reader = r
    try {
      for (;;) {
        while (rxQueued > RX_HIGH_WATER && mine === session) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        }
        if (mine !== session) return
        const { value, done } = await r.read()
        if (mine !== session) return
        if (done) {
          // Nobody here cancelled it, so the port closed under us.
          void lost(mine)
          return
        }
        if (value && value.length > 0) {
          rxQueue.push(value)
          rxQueued += value.length
          pumpRx()
        }
      }
    } catch {
      // Non-fatal line errors land here; the outer loop takes the next stream.
    } finally {
      try {
        r.releaseLock()
      } catch {
        /* already released by a cancel */
      }
    }
    if (mine !== session) return
  }
  if (mine === session) void lost(mine)
}

/** The open port went away (unplugged, or its stream died). */
async function lost(mine: number): Promise<void> {
  if (mine !== session) return
  const label = snapshot.portLabel
  await closePort()
  const saved = getPipe('uart1')
  if (ch && savedIdentity(saved) && saved.autoReconnect) {
    setSnapshot({ phase: 'waiting', portLabel: label, error: '' })
  } else {
    setSnapshot({ phase: 'idle', portLabel: '', error: '' })
  }
}

async function closePort(): Promise<void> {
  session++
  const closing = port
  const r = reader
  const w = writer
  const done = readDone
  port = null
  reader = null
  writer = null
  readDone = Promise.resolve()
  rxQueue = []
  rxQueued = 0
  txPending = 0
  if (!closing) return
  try {
    await r?.cancel()
  } catch {
    /* the device may already be gone */
  }
  await done
  try {
    await w?.abort()
  } catch {
    /* as above */
  }
  try {
    w?.releaseLock()
  } catch {
    /* as above */
  }
  try {
    await closing.close()
  } catch {
    /* as above */
  }
}

/** Move queued port bytes into the guest's receive ring, as far as it has room. */
function pumpRx() {
  if (!ch) return
  while (rxQueue.length > 0) {
    const head = rxQueue[0]!
    const n = feedSome(ch, head)
    counters.rx += n
    rxQueued -= n
    if (n < head.length) {
      rxQueue[0] = head.subarray(n)
      break
    }
    rxQueue.shift()
  }
}

function poll() {
  if (!ch) return
  pumpRx()
  // Drained even with no port, so a guest talking to nobody never fills it.
  const out = drainBytes(ch)
  const w = writer
  if (out.length > 0 && w && snapshot.phase === 'open') {
    if (txPending + out.length > TX_CAP) {
      counters.dropped += out.length
    } else {
      txPending += out.length
      w.write(out).then(
        () => {
          txPending -= out.length
          counters.tx += out.length
        },
        () => {
          txPending -= out.length
        },
      )
    }
  }
  publishCounters()
}

function publishCounters() {
  const now = Date.now()
  if (now - lastPublish < PUBLISH_MS) return
  if (
    counters.rx === snapshot.rx &&
    counters.tx === snapshot.tx &&
    counters.dropped === snapshot.dropped
  ) {
    return
  }
  lastPublish = now
  setSnapshot({ rx: counters.rx, tx: counters.tx, dropped: counters.dropped })
}
