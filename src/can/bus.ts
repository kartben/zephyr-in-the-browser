/**
 * The CAN bus, as a TypeScript object.
 *
 * Same idea as {@link ../net/stack.ts}: the page is not a device on the bus,
 * it *is* the rest of the bus. Every frame the board transmits terminates
 * here, every frame it receives originates here, and the nodes that answer are
 * page-side presets rather than anything emulated.
 *
 * What is modelled, and why each piece has to exist:
 *
 * - **Broadcast delivery.** CAN has no addressing. A frame is offered to every
 *   other attached node and each decides whether it wants it.
 * - **Occupancy.** A frame holds the medium for `bits / bitrate` seconds. This
 *   is the *only* thing bit timing is used for, and without it there is
 *   nothing to arbitrate: if transmissions completed instantly, two nodes
 *   would never be ready at once and every "lost arbitration" would be staged.
 * - **Arbitration.** A node that becomes ready while the medium is busy
 *   queues; when it frees, the lowest ID among the queued frames wins.
 * - **ACK.** "At least one other attached node acknowledges." This is the
 *   whole mechanism behind bus-off, and it is why unplugging the last other
 *   node is the interesting gesture in the panel.
 * - **Error counters**, close enough to ISO 11898-1 to teach: +8 on a transmit
 *   nobody acknowledged, −1 on a good one, error-passive above 127, bus-off
 *   at 256.
 *
 * What is *not* modelled, and must not be implied by any UI on top: bit-level
 * timing, stuffing, error frames, and CRC. Same latitude `ws2812.ts` takes
 * with pulse timing.
 *
 * Time is wall-clock, never guest time — icount freezes while the board waits
 * on a virtqueue, which is the lesson the DAC scope already learned.
 */

export interface CanFrame {
  /** 11-bit id, or 29-bit when `ext`. */
  id: number
  ext: boolean
  rtr: boolean
  /** Empty for an RTR frame; the DLC is this length. */
  data: Uint8Array
}

export type CanState = 'error-active' | 'error-passive' | 'bus-off'

/**
 * What a node did with a frame offered to it. `overflow` is distinct from
 * `filtered` because they mean opposite things about the receiver: one did not
 * want the frame, the other wanted it and had nowhere to put it.
 */
export type CanReceipt = 'accepted' | 'filtered' | 'overflow'

/** Wildcard for {@link CanNodeSpec.respondTo}: reply to any id. */
export const ANY_ID = -1

export interface CanNodeSpec {
  id: string
  name: string
  /** The controller this board drives. At most one. */
  local?: boolean
  /** False models listen-only: sends no dominant bit, ACK included. */
  acks?: boolean
  transmit?: {
    id: number
    ext?: boolean
    periodMs: number
    data: (seq: number) => Uint8Array
  }
  respondTo?: {
    /** {@link ANY_ID} to answer whatever arrives. */
    id: number
    reply: (frame: CanFrame) => CanFrame | null
  }
  /** Acceptance filtering. Only the local node has any; others take all. */
  receive?: (frame: CanFrame) => CanReceipt
}

/** Plain snapshot for the panel — no closures cross this line. */
export interface CanNodeSnapshot {
  id: string
  name: string
  local: boolean
  acks: boolean
  /**
   * Page-side loopback (MCP2515 loopback semantics): TX stays on this node,
   * never reaches the rest of the bus, and is offered back to its own receive
   * path. Only meaningful on the local controller.
   */
  loopback: boolean
  tec: number
  rec: number
  state: CanState
  /** One-line behaviour summary for the roster sub-line. */
  summary: string
}

export interface CanLogEntry {
  seq: number
  /** Wall-clock ms when the event landed. Lane view places ticks from this. */
  at: number
  kind: 'frame' | 'arbitration' | 'no-ack'
  /** Node id that transmitted (or tried to). */
  from: string
  /** Transmitted by the local controller. */
  local: boolean
  frame: CanFrame
  /** `kind: 'frame'`, inbound only: why the local node did not take it. */
  drop?: 'filtered' | 'overflow'
  /** `kind: 'arbitration'`: id of the frame that won. */
  lostTo?: number
  /** `kind: 'no-ack'`: transmit error counter after the failure. */
  tec?: number
}

const LOG_CAP = 400
const NOTIFY_MS = 50
const PUMP_MS = 5
const DEFAULT_BITRATE = 500_000

/** Bus-off threshold, and the error-passive one below it. */
const TEC_BUS_OFF = 256
const TEC_PASSIVE = 127

interface Attached extends CanNodeSpec {
  tec: number
  rec: number
  state: CanState
  nextTxAt: number
  txSeq: number
  /** Workbench loopback; see {@link CanNodeSnapshot.loopback}. */
  loopback: boolean
}

interface Queued {
  node: Attached
  frame: CanFrame
  /** Logged its loss already — re-arbitration must not spam the trace. */
  lostLogged: boolean
}

/**
 * Frame length on the wire, in bits. Standard frames carry ~47 bits of
 * overhead, extended ~67, and 3 bits of intermission follow every frame. Stuff
 * bits are not counted; nothing here is accurate to the bit, and the number
 * exists only to give the medium a duration.
 */
export function frameBits(frame: CanFrame): number {
  const dataBits = frame.rtr ? 0 : frame.data.length * 8
  return (frame.ext ? 67 : 47) + dataBits + 3
}

export interface CanBus {
  attach(spec: CanNodeSpec): () => void
  detach(id: string): void
  nodes(): readonly CanNodeSnapshot[]
  log(): readonly CanLogEntry[]
  clearLog(): void
  subscribe(fn: () => void): () => void
  /** Queue a frame for transmission by `nodeId`. */
  send(nodeId: string, frame: CanFrame): void
  /** Advance the medium. A timer drives this live; tests call it directly. */
  pump(at?: number): void
  setBitrate(bps: number): void
  bitrate(): number
  /** Clear a bus-off controller's counters (`can_recover()`). */
  recover(nodeId: string): void
  /**
   * Toggle page-side loopback on a node. Frames it transmits never leave it;
   * they are offered back to its own `receive` instead. Mirrors MCP2515
   * loopback without writing `CANCTRL` out from under the guest.
   */
  setLoopback(nodeId: string, on: boolean): void
  /** Frames that crossed the bus in the last second. */
  frameRate(): number
  start(): void
  stop(): void
}

export function createCanBus(now: () => number = () => Date.now()): CanBus {
  const attached = new Map<string, Attached>()
  const queue: Queued[] = []
  const entries: CanLogEntry[] = []
  const listeners = new Set<() => void>()
  const recent: number[] = []

  let bitrate = DEFAULT_BITRATE
  let busyUntil = 0
  let seq = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let notifyAt = 0
  let notifyTimer: ReturnType<typeof setTimeout> | null = null

  // `useSyncExternalStore` needs a snapshot whose reference is stable between
  // calls that see no change — recomputing `[...attached.values()].map(...)`
  // (or handing back a mutated-in-place `entries`) inside `nodes()`/`log()`
  // themselves either builds a new array every render (React treats that as
  // "changed every time" and throws "getSnapshot should be cached", the way
  // attaching an MCP2515 blanked the CAN panel) or never signals a change at
  // all. Snapshots are rebuilt here, once, wherever state actually mutates.
  let nodesSnapshot: readonly CanNodeSnapshot[] = []
  let logSnapshot: readonly CanLogEntry[] = entries

  function refreshSnapshots() {
    nodesSnapshot = [...attached.values()].map((n) => ({
      id: n.id,
      name: n.name,
      local: !!n.local,
      acks: n.acks !== false,
      loopback: n.loopback,
      tec: n.tec,
      rec: n.rec,
      state: n.state,
      summary: summarise(n),
    }))
    logSnapshot = entries.slice()
  }

  /**
   * Throttled: a loaded bus produces frames far faster than React should
   * re-render, and the trace is the only consumer that cares about every one.
   */
  function notify() {
    refreshSnapshots()
    const t = now()
    if (t - notifyAt >= NOTIFY_MS) {
      notifyAt = t
      for (const fn of listeners) fn()
      return
    }
    if (notifyTimer) return
    notifyTimer = setTimeout(() => {
      notifyTimer = null
      notifyAt = now()
      refreshSnapshots()
      for (const fn of listeners) fn()
    }, NOTIFY_MS)
  }

  function push(entry: Omit<CanLogEntry, 'seq'>) {
    entries.push({ seq: seq++, ...entry })
    if (entries.length > LOG_CAP) entries.splice(0, entries.length - LOG_CAP)
    notify()
  }

  function updateState(node: Attached) {
    // Bus-off is a latch: only recover() leaves it, which is exactly the point
    // of the state. Everything else follows the counters.
    if (node.state === 'bus-off') return
    if (node.tec >= TEC_BUS_OFF) node.state = 'bus-off'
    else if (node.tec > TEC_PASSIVE || node.rec > TEC_PASSIVE) node.state = 'error-passive'
    else node.state = 'error-active'
  }

  function enqueue(node: Attached, frame: CanFrame) {
    if (node.state === 'bus-off') return
    queue.push({ node, frame, lostLogged: false })
  }

  function transmit(q: Queued, at: number) {
    const { node, frame } = q
    busyUntil = at + (frameBits(frame) / bitrate) * 1000

    // Loopback never puts a dominant bit on the medium for anyone else: the
    // frame is acknowledged internally and offered back to the sender's own
    // receive path, matching MCP2515 loopback mode.
    if (node.loopback) {
      node.tec = Math.max(0, node.tec - 1)
      updateState(node)
      let drop: 'filtered' | 'overflow' | undefined
      if (node.receive) {
        const receipt = node.receive(frame)
        if (receipt !== 'accepted') drop = receipt
      }
      recent.push(at)
      push({ kind: 'frame', at, from: node.id, local: !!node.local, frame, drop })
      return
    }

    const others = [...attached.values()].filter((n) => n.id !== node.id)
    const acked = others.some((n) => n.acks !== false && n.state !== 'bus-off')

    if (!acked) {
      node.tec += 8
      updateState(node)
      push({ kind: 'no-ack', at, from: node.id, local: !!node.local, frame, tec: node.tec })
      // The MCP2515 retransmits automatically unless one-shot mode is set, so
      // the frame goes back on the queue and the counter climbs until bus-off
      // stops it. This loop *is* the demo.
      if (node.state === 'bus-off') dropQueued(node.id)
      else queue.push({ node, frame, lostLogged: true })
      return
    }

    node.tec = Math.max(0, node.tec - 1)
    updateState(node)

    let drop: 'filtered' | 'overflow' | undefined
    for (const other of others) {
      const receipt = other.receive ? other.receive(frame) : 'accepted'
      if (other.local && receipt !== 'accepted') drop = receipt
      if (receipt !== 'accepted') continue
      const responder = other.respondTo
      if (responder && (responder.id === ANY_ID || responder.id === frame.id)) {
        const reply = responder.reply(frame)
        if (reply) enqueue(other, reply)
      }
    }

    recent.push(at)
    push({ kind: 'frame', at, from: node.id, local: !!node.local, frame, drop })
  }

  function dropQueued(nodeId: string) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]!.node.id === nodeId) queue.splice(i, 1)
    }
  }

  function pump(at = now()) {
    // Periodic nodes become ready on their own schedule.
    for (const node of attached.values()) {
      const tx = node.transmit
      if (!tx || node.state === 'bus-off') continue
      if (at < node.nextTxAt) continue
      node.nextTxAt = at + tx.periodMs
      enqueue(node, {
        id: tx.id,
        ext: !!tx.ext,
        rtr: false,
        data: tx.data(node.txSeq++),
      })
    }

    // Drain while the medium is free. Everything queued contends; lowest id
    // wins, and insertion order breaks a tie between equal ids.
    let guard = 0
    while (queue.length > 0 && busyUntil <= at && guard++ < 64) {
      let best = 0
      for (let i = 1; i < queue.length; i++) {
        if (queue[i]!.frame.id < queue[best]!.frame.id) best = i
      }
      const winner = queue.splice(best, 1)[0]!
      for (const loser of queue) {
        if (loser.lostLogged) continue
        loser.lostLogged = true
        push({
          kind: 'arbitration',
          at,
          from: loser.node.id,
          local: !!loser.node.local,
          frame: loser.frame,
          lostTo: winner.frame.id,
        })
      }
      transmit(winner, at)
    }

    const cutoff = at - 1000
    while (recent.length > 0 && recent[0]! < cutoff) recent.shift()
  }

  function summarise(node: Attached): string {
    const parts: string[] = []
    if (node.transmit) {
      parts.push(`0x${hex(node.transmit.id)} every ${node.transmit.periodMs} ms`)
    }
    if (node.respondTo) {
      parts.push(
        node.respondTo.id === ANY_ID
          ? 'replies to traffic'
          : `replies 0x${hex(node.respondTo.id)}`,
      )
    }
    if (node.loopback) parts.push('loopback')
    if (node.acks === false) parts.push('listen-only')
    // "acks only" describes a Listener. The local controller transmits
    // whenever the board asks it to, so claiming that of it would be a lie.
    else if (parts.length === 0 && !node.local) parts.push('acks only')
    parts.push(`TEC ${node.tec} REC ${node.rec}`)
    return parts.join(' · ')
  }

  return {
    attach(spec) {
      const node: Attached = {
        ...spec,
        tec: 0,
        rec: 0,
        state: 'error-active',
        // First deadline is one period after attach, not after the first pump
        // — otherwise a node's phase depends on when the timer happened to
        // tick, which is invisible and untestable.
        nextTxAt: spec.transmit ? now() + spec.transmit.periodMs : 0,
        txSeq: 0,
        loopback: false,
      }
      attached.set(spec.id, node)
      notify()
      return () => this.detach(spec.id)
    },

    detach(id) {
      if (!attached.delete(id)) return
      dropQueued(id)
      notify()
    },

    nodes: () => nodesSnapshot,

    log: () => logSnapshot,

    clearLog() {
      entries.length = 0
      notify()
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    send(nodeId, frame) {
      const node = attached.get(nodeId)
      if (!node) return
      enqueue(node, frame)
      pump()
    },

    pump,

    setBitrate(bps) {
      if (bps > 0) bitrate = bps
    },
    bitrate: () => bitrate,

    recover(nodeId) {
      const node = attached.get(nodeId)
      if (!node) return
      node.tec = 0
      node.rec = 0
      node.state = 'error-active'
      notify()
    },

    setLoopback(nodeId, on) {
      const node = attached.get(nodeId)
      if (!node || node.loopback === on) return
      node.loopback = on
      notify()
    },

    frameRate: () => recent.length,

    start() {
      if (timer) return
      timer = setInterval(() => pump(), PUMP_MS)
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
      if (notifyTimer) clearTimeout(notifyTimer)
      notifyTimer = null
    },
  }
}

function hex(id: number): string {
  return id.toString(16).toUpperCase().padStart(3, '0')
}
