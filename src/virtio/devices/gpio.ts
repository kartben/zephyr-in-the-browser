/**
 * VIRTIO GPIO device model (virtio spec 1.3, section 5.16), in the page.
 *
 * This is a port of `hw/virtio/virtio-gpio.c` — the 576-line C device model
 * that patch 0010 added — onto the generic bridge. The guest side is
 * unchanged: the vendored upstream `virtio,gpio` driver talks to what it
 * believes is an ordinary VIRTIO GPIO controller, because it is one. Only the
 * far end of the virtqueues moved, from QEMU to here.
 *
 * Two things got better in the move, both because the model now lives where
 * the events originate:
 *
 * - **Edges are exact.** The C model sampled the input word on a 10 ms timer,
 *   so a press and release inside one tick was invisible. Here `setInputs` is
 *   called by the panel, so the edge is detected at the instant it happens.
 * - **Outputs are push, not pull.** hostGpio.ts used to poll the output word
 *   every 100 ms to light its LEDs. A guest SET_VALUE now notifies listeners
 *   synchronously.
 */

import type { VirtioDeviceModel, VirtioRequest } from '../transport'

/** Queue indices, per the spec. */
const VQ_REQUEST = 0
const VQ_EVENT = 1

const MSG_GET_LINE_NAMES = 0x0001
const MSG_GET_DIRECTION = 0x0002
const MSG_SET_DIRECTION = 0x0003
const MSG_GET_VALUE = 0x0004
const MSG_SET_VALUE = 0x0005
const MSG_IRQ_TYPE = 0x0006

const STATUS_OK = 0x0
const STATUS_ERR = 0x1

const DIRECTION_NONE = 0x00
const DIRECTION_OUT = 0x01
const DIRECTION_IN = 0x02

const IRQ_TYPE_NONE = 0x00
const IRQ_TYPE_EDGE_RISING = 0x01
const IRQ_TYPE_EDGE_FALLING = 0x02
const IRQ_TYPE_EDGE_BOTH = 0x03
const IRQ_TYPE_LEVEL_HIGH = 0x04
const IRQ_TYPE_LEVEL_LOW = 0x08

const IRQ_STATUS_INVALID = 0x0
const IRQ_STATUS_VALID = 0x1

/** A Zephyr GPIO port is at most a machine word wide. */
const MAX_LINES = 32

export interface GpioModel extends VirtioDeviceModel {
  /** Lines the device advertises, read from config space at attach. */
  readonly ngpio: number
  /** Drive the whole input word; edges fire interrupts synchronously. */
  setInputs(mask: number): void
  getInputs(): number
  getOutputs(): number
  subscribe(fn: () => void): () => void
}

export function createGpioModel(name = 'gpio'): GpioModel {
  const direction = new Uint8Array(MAX_LINES)
  const irqType = new Uint8Array(MAX_LINES)
  /**
   * One parked event chain per line. The driver may only have a single chain
   * outstanding per line, so one slot each is enough.
   */
  const irqReq: Array<VirtioRequest | null> = new Array(MAX_LINES).fill(null)

  const listeners = new Set<() => void>()
  let inputs = 0
  let outputs = 0
  let ngpio = 0
  let lineMask = 0

  const notify = () => {
    for (const fn of listeners) fn()
  }

  /** Hand a parked event chain back to the driver. */
  function completeIrq(line: number, status: number) {
    const req = irqReq[line]
    if (!req) return
    irqReq[line] = null
    req.reply(Uint8Array.of(status))
  }

  /**
   * Fire whichever parked chains the current input word satisfies. `rose` and
   * `fell` carry the lines that just changed, so a re-arm with no change
   * passes zero for both and only level conditions can match.
   */
  function fireIrqs(now: number, rose: number, fell: number) {
    for (let line = 0; line < ngpio; line++) {
      const bit = 1 << line
      if (!irqReq[line]) continue

      let fire = false
      switch (irqType[line]) {
        case IRQ_TYPE_EDGE_RISING:
          fire = (rose & bit) !== 0
          break
        case IRQ_TYPE_EDGE_FALLING:
          fire = (fell & bit) !== 0
          break
        case IRQ_TYPE_EDGE_BOTH:
          fire = ((rose | fell) & bit) !== 0
          break
        case IRQ_TYPE_LEVEL_HIGH:
          fire = (now & bit) !== 0
          break
        case IRQ_TYPE_LEVEL_LOW:
          fire = (~now & bit) !== 0
          break
        default:
          fire = false
      }

      if (fire) completeIrq(line, IRQ_STATUS_VALID)
    }
  }

  function handleRequest(req: VirtioRequest) {
    // struct virtio_gpio_request { le16 type; le16 gpio; le32 value; }
    if (req.out.length < 8) {
      console.warn('[virtio-gpio] short request')
      req.reply(Uint8Array.of(STATUS_ERR, 0))
      return
    }
    const dv = new DataView(req.out.buffer, req.out.byteOffset, req.out.byteLength)
    const type = dv.getUint16(0, true)
    const line = dv.getUint16(2, true)
    const value = dv.getUint32(4, true)

    // Anything that returns without setting status is a rejection.
    const err = () => req.reply(Uint8Array.of(STATUS_ERR, 0))
    const ok = (v = 0) => req.reply(Uint8Array.of(STATUS_OK, v))

    if (line >= ngpio) {
      console.warn(`[virtio-gpio] request ${type} for line ${line} beyond ngpio ${ngpio}`)
      err()
      return
    }

    switch (type) {
      case MSG_GET_DIRECTION:
        ok(direction[line])
        break

      case MSG_SET_DIRECTION:
        if (
          value !== DIRECTION_NONE &&
          value !== DIRECTION_OUT &&
          value !== DIRECTION_IN
        ) {
          err()
          return
        }
        direction[line] = value
        ok()
        break

      case MSG_GET_VALUE:
        // An output reads back the level the guest drives, an input the level
        // the page supplies. A line with no direction has no value to report,
        // which the spec makes an error rather than a zero.
        if (direction[line] === DIRECTION_OUT) {
          ok((outputs >> line) & 1)
        } else if (direction[line] === DIRECTION_IN) {
          ok((inputs >> line) & 1)
        } else {
          err()
        }
        break

      case MSG_SET_VALUE: {
        // Legal before the line is an output: the spec has SET_VALUE record
        // the level to drive and SET_DIRECTION_OUT start driving it.
        const next = value ? outputs | (1 << line) : outputs & ~(1 << line)
        ok()
        if (next !== outputs) {
          outputs = next
          notify()
        }
        break
      }

      case MSG_IRQ_TYPE:
        switch (value) {
          case IRQ_TYPE_NONE:
          case IRQ_TYPE_EDGE_RISING:
          case IRQ_TYPE_EDGE_FALLING:
          case IRQ_TYPE_EDGE_BOTH:
          case IRQ_TYPE_LEVEL_HIGH:
          case IRQ_TYPE_LEVEL_LOW:
            break
          default:
            err()
            return
        }
        irqType[line] = value
        ok()
        // Disabling releases the parked chain, flagged as not an event.
        if (value === IRQ_TYPE_NONE) completeIrq(line, IRQ_STATUS_INVALID)
        break

      case MSG_GET_LINE_NAMES:
        // gpio_names_size is 0: the lines are numbered, not named.
        err()
        break

      default:
        console.warn(`[virtio-gpio] unknown request ${type}`)
        err()
    }
  }

  function handleEvent(req: VirtioRequest) {
    // struct virtio_gpio_irq_request { le16 gpio; }
    if (req.out.length < 2) {
      console.warn('[virtio-gpio] short event buffer')
      req.reply(Uint8Array.of(IRQ_STATUS_INVALID))
      return
    }
    const line = new DataView(
      req.out.buffer,
      req.out.byteOffset,
      req.out.byteLength,
    ).getUint16(0, true)

    // A chain the device cannot park has to go straight back. Both cases mean
    // a driver bug, and neither is reachable from a driver that arms one chain
    // per line as the spec requires.
    if (line >= ngpio || irqReq[line]) {
      console.warn(`[virtio-gpio] rejecting event buffer for line ${line}`)
      req.reply(Uint8Array.of(IRQ_STATUS_INVALID))
      return
    }

    // Parked even when the line's interrupt is still disabled: holding it
    // makes the driver wait, whereas handing it back would look like an event
    // that never happened.
    irqReq[line] = req
    req.park()

    // A level-triggered line armed while its level already holds must fire
    // without waiting for a change, so re-evaluate rather than only sample.
    fireIrqs(inputs, 0, 0)
  }

  return {
    name,

    get ngpio() {
      return ngpio
    },

    attachConfig(config) {
      // struct virtio_gpio_config { le16 ngpio; u8 padding[2]; le32 names_size; }
      const dv = new DataView(config.buffer, config.byteOffset, config.byteLength)
      ngpio = Math.min(dv.getUint16(0, true), MAX_LINES)
      lineMask = ngpio >= 32 ? -1 : (1 << ngpio) - 1
      inputs &= lineMask
    },

    handle(req) {
      if (req.queue === VQ_REQUEST) handleRequest(req)
      else if (req.queue === VQ_EVENT) handleEvent(req)
      else {
        console.warn(`[virtio-gpio] request on unexpected queue ${req.queue}`)
        req.fail()
      }
    },

    reset() {
      direction.fill(DIRECTION_NONE)
      irqType.fill(IRQ_TYPE_NONE)
      irqReq.fill(null)
      // Outputs low at reset, so a browser LED goes dark with the guest.
      if (outputs !== 0) {
        outputs = 0
        notify()
      }
    },

    setInputs(mask) {
      const next = mask & lineMask
      if (next === inputs) return
      const rose = next & ~inputs
      const fell = ~next & inputs
      inputs = next
      fireIrqs(next, rose, fell)
      notify()
    },

    getInputs: () => inputs,
    getOutputs: () => outputs,

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
