/**
 * The CAN bridge: chip on one side, network on the other.
 *
 * {@link ./virtio/devices/chips/mcp2515.ts} speaks SPI and knows nothing about
 * other nodes; {@link ./can/bus.ts} owns the medium and knows nothing about
 * SPI. This module is the only place that knows both, and it is where the two
 * sideband facts live that neither of them should carry:
 *
 * - **INT is a GPIO.** The controller's interrupt line is a virtio-gpio input
 *   pin, active low, so an asserted interrupt drives the pin *low*. Without
 *   it the driver's interrupt thread never wakes and nothing is ever received.
 * - **The local node is the chip.** Its acceptance filters live in the chip,
 *   so the bus asks the chip whether an inbound frame was accepted, and the
 *   trace's `filtered` tag is that answer.
 */

import { createCanBus, type CanBus, type CanFrame, type CanNodeSpec } from '@/can/bus'
import { CAN_NODE_TYPES, nodeType } from '@/can/nodes'
import { isMcp2515, type Mcp2515Chip } from '@/virtio/devices/chips/mcp2515'
import { spiModel } from '@/virtio'
import { setInput } from '@/hostGpio'

/** Roster id of the controller this board drives. */
export const LOCAL_NODE = 'can0'

/**
 * virtio-gpio line carrying INT. 4 is LED0, 5 the buzzer, 6/7 are step/dir or
 * the SCT2024's LA/OE, so 8 is the first line nothing else claims.
 */
export const INT_PIN = 8

const bus = createCanBus()
let chip: Mcp2515Chip | null = null
let nodeSeq = 0

/**
 * Wire a controller that has appeared on the SPI bus. The attach picker builds
 * a bare chip — `devices/` must not reach into host modules — so the wiring
 * happens here, the same way hostStepper watches GPIO for step/dir edges.
 */
export function wire(built: Mcp2515Chip) {
  if (chip === built) return
  unwire()
  chip = built

  built.setHooks({
    onTransmit: (frame) => bus.send(LOCAL_NODE, frame),
    // Active low: an asserted interrupt drives the line to 0.
    onInt: (asserted) => setInput(INT_PIN, !asserted),
  })

  const local: CanNodeSpec = {
    id: LOCAL_NODE,
    name: LOCAL_NODE,
    local: true,
    // Acceptance filters live in the chip, so the trace's `filtered` tag is
    // the chip's own answer rather than a second copy of the filter logic.
    receive: (frame) => built.deliver(frame),
  }
  bus.attach(local)

  // Idle high until the controller has something to report.
  setInput(INT_PIN, true)
  bus.start()
}

export function unwire() {
  if (!chip) return
  chip.setHooks({})
  chip = null
  bus.detach(LOCAL_NODE)
  bus.stop()
  setInput(INT_PIN, true)
}

/** Follow the SPI roster: wire whatever MCP2515 is on it, unwire when it goes. */
function syncFromSpi() {
  const found = spiModel.chips().find(isMcp2515)
  if (found) wire(found)
  else unwire()
}

spiModel.subscribe(syncFromSpi)
syncFromSpi()

/** Add a page-side node from the catalog. */
export function addNode(typeId: string, opts: { id: number; periodMs: number }): void {
  const type = nodeType(typeId)
  if (!type) return
  bus.attach(type.create(`${typeId}-${nodeSeq++}`, opts))
}

export function removeNode(id: string) {
  bus.detach(id)
}

/** Send a composed frame as `nodeId`. */
export function sendAs(nodeId: string, frame: CanFrame) {
  bus.send(nodeId, frame)
}

export function recover(nodeId = LOCAL_NODE) {
  bus.recover(nodeId)
}

/** Page-side loopback on the local controller. See {@link CanBus.setLoopback}. */
export function setLoopback(on: boolean, nodeId = LOCAL_NODE) {
  bus.setLoopback(nodeId, on)
}

export function canBus(): CanBus {
  return bus
}

export function canChip(): Mcp2515Chip | null {
  return chip
}

export { CAN_NODE_TYPES }
