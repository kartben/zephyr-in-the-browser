import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createFakeBridge } from './testing/fakeBridge'
import { createGpioModel } from './devices/gpio'
import { attach, detach, available, boundNames, pollOnce, register, stats } from './transport'
import type { VirtioDeviceModel, VirtioRequest } from './transport'
import { CMP_FAIL, CMP_OK } from './protocol'

/** ngpio = 8, names_size = 0 — what `config=0800000000000000` seeds. */
const GPIO_CONFIG = Uint8Array.of(8, 0, 0, 0, 0, 0, 0, 0)

const VIRTIO_ID_GPIO = 41

/** struct virtio_gpio_request { le16 type; le16 gpio; le32 value; } */
function gpioRequest(type: number, line: number, value = 0): Uint8Array {
  const buf = new Uint8Array(8)
  const dv = new DataView(buf.buffer)
  dv.setUint16(0, type, true)
  dv.setUint16(2, line, true)
  dv.setUint32(4, value, true)
  return buf
}

/** struct virtio_gpio_irq_request { le16 gpio; } */
function eventRequest(line: number): Uint8Array {
  const buf = new Uint8Array(2)
  new DataView(buf.buffer).setUint16(0, line, true)
  return buf
}

const MSG_GET_DIRECTION = 0x0002
const MSG_SET_DIRECTION = 0x0003
const MSG_GET_VALUE = 0x0004
const MSG_SET_VALUE = 0x0005
const MSG_IRQ_TYPE = 0x0006

const DIRECTION_OUT = 0x01
const DIRECTION_IN = 0x02

const IRQ_TYPE_NONE = 0x00
const IRQ_TYPE_EDGE_RISING = 0x01
const IRQ_TYPE_EDGE_BOTH = 0x03
const IRQ_TYPE_LEVEL_HIGH = 0x04

const VQ_REQUEST = 0
const VQ_EVENT = 1

const STATUS_OK = 0x0
const STATUS_ERR = 0x1

const IRQ_STATUS_INVALID = 0x0
const IRQ_STATUS_VALID = 0x1

describe('virtio transport', () => {
  beforeEach(() => detach())

  it('binds a model to the device carrying its name', () => {
    const bridge = createFakeBridge([
      { name: 'gpio', deviceId: VIRTIO_ID_GPIO, numQueues: 2, config: GPIO_CONFIG },
    ])
    register(createGpioModel())
    attach(bridge.module)
    pollOnce()

    expect(available()).toBe(true)
    expect(boundNames()).toEqual(['gpio'])
  })

  it('matches by name, not by index or device id', () => {
    // Two devices sharing a device id is the case i2c will hit: two buses.
    const bridge = createFakeBridge([
      { name: 'bus-b', deviceId: 34 },
      { name: 'bus-a', deviceId: 34 },
    ])
    const seen: string[] = []
    const model = (name: string): VirtioDeviceModel => ({
      name,
      handle(req) {
        seen.push(`${name}:${req.out[0]}`)
        req.reply(Uint8Array.of(1))
      },
    })
    register(model('bus-a'))
    register(model('bus-b'))
    attach(bridge.module)
    pollOnce()

    bridge.device('bus-a').kick(0, Uint8Array.of(0xaa), 4)
    bridge.device('bus-b').kick(0, Uint8Array.of(0xbb), 4)
    pollOnce()

    expect(seen).toEqual(['bus-b:187', 'bus-a:170'])
  })

  it('round-trips a request and its answer', () => {
    const bridge = createFakeBridge([{ name: 'echo', deviceId: 99 }])
    register({
      name: 'echo',
      handle: (req) => req.reply(req.out.slice().reverse()),
    })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('echo')
    const token = dev.kick(0, Uint8Array.of(1, 2, 3), 8)
    pollOnce()

    expect(dev.completions()).toEqual([
      { token, flags: CMP_OK, data: Uint8Array.of(3, 2, 1) },
    ])
  })

  it('reports a failed chain distinctly from an empty answer', () => {
    const bridge = createFakeBridge([{ name: 'nope', deviceId: 99 }])
    register({ name: 'nope', handle: (req) => req.fail() })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('nope')
    dev.kick(0, Uint8Array.of(1), 4)
    pollOnce()

    const [done] = dev.completions()
    expect(done.flags).toBe(CMP_FAIL)
    expect(done.data).toEqual(new Uint8Array())
  })

  it('fails the chain when a model throws', () => {
    const bridge = createFakeBridge([{ name: 'boom', deviceId: 99 }])
    register({
      name: 'boom',
      handle() {
        throw new Error('device model blew up')
      },
    })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('boom')
    dev.kick(0, Uint8Array.of(1), 4)
    pollOnce()

    expect(dev.completions()[0].flags).toBe(CMP_FAIL)
  })

  it('answers out of order, and holds parked chains', () => {
    const bridge = createFakeBridge([{ name: 'park', deviceId: 99 }])
    const held: VirtioRequest[] = []
    register({
      name: 'park',
      handle(req) {
        held.push(req)
        req.park()
      },
    })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('park')
    const first = dev.kick(0, Uint8Array.of(1), 4)
    const second = dev.kick(0, Uint8Array.of(2), 4)
    pollOnce()

    // Nothing completes until the model says so.
    expect(dev.completions()).toEqual([])
    expect(dev.outstanding()).toBe(2)

    held[1].reply(Uint8Array.of(0x22))
    held[0].reply(Uint8Array.of(0x11))
    expect(dev.completions().map((c) => c.token)).toEqual([second, first])
  })

  it('ignores a second answer for the same chain', () => {
    const bridge = createFakeBridge([{ name: 'twice', deviceId: 99 }])
    let saved: VirtioRequest | null = null
    register({
      name: 'twice',
      handle(req) {
        saved = req
        req.reply(Uint8Array.of(1))
      },
    })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('twice')
    dev.kick(0, Uint8Array.of(0), 4)
    pollOnce()
    expect(dev.completions()).toHaveLength(1)

    saved!.reply(Uint8Array.of(2))
    expect(dev.completions()).toHaveLength(0)
  })

  it('wraps both rings without losing or splitting a record', () => {
    // A 256-byte ring and 48-byte payloads: several laps, and a skip marker
    // whenever a record would straddle the end.
    const bridge = createFakeBridge([{ name: 'wrap', deviceId: 99, ringSize: 256 }])
    register({ name: 'wrap', handle: (req) => req.reply(req.out.slice()) })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('wrap')
    for (let i = 0; i < 40; i++) {
      const payload = new Uint8Array(48).fill(i)
      const token = dev.kick(0, payload, 64)
      pollOnce()
      const [done] = dev.completions()
      expect(done.token).toBe(token)
      expect(done.data).toEqual(payload)
    }
  })

  it('drops in-flight state on reset and resyncs', () => {
    const bridge = createFakeBridge([{ name: 'rst', deviceId: 99 }])
    const held: VirtioRequest[] = []
    let resets = 0
    register({
      name: 'rst',
      handle(req) {
        held.push(req)
        req.park()
      },
      reset: () => resets++,
    })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('rst')
    dev.kick(0, Uint8Array.of(1), 4)
    pollOnce()
    expect(held).toHaveLength(1)

    dev.reset()
    pollOnce()
    expect(resets).toBe(1)

    // The device works again afterwards.
    const token = dev.kick(0, Uint8Array.of(2), 4)
    pollOnce()
    held[1].reply(Uint8Array.of(0xff))
    expect(dev.completions().map((c) => c.token)).toEqual([token])
  })

  it('never hands a shared view to TextDecoder', () => {
    // Regression, and a subtle one to test: readName used to decode a view
    // straight into the heap. Browsers reject that outright ("The provided
    // ArrayBufferView value must not be shared"), so the real emulator bound
    // no devices at all — but *Node's* TextDecoder accepts shared views, so
    // every test in this file passed regardless. Reproducing the browser's
    // rule is the only way this suite can see the bug.
    const RealTextDecoder = globalThis.TextDecoder
    class StrictTextDecoder extends RealTextDecoder {
      decode(input?: AllowSharedBufferSource, opts?: TextDecodeOptions): string {
        const buffer = ArrayBuffer.isView(input) ? input.buffer : input
        if (buffer instanceof SharedArrayBuffer) {
          throw new TypeError('The provided ArrayBufferView value must not be shared.')
        }
        return super.decode(input as BufferSource, opts)
      }
    }
    globalThis.TextDecoder = StrictTextDecoder as typeof RealTextDecoder

    try {
      const bridge = createFakeBridge(
        [{ name: 'gpio', deviceId: VIRTIO_ID_GPIO, numQueues: 2, config: GPIO_CONFIG }],
        { shared: true },
      )
      register(createGpioModel())
      attach(bridge.module)
      pollOnce()
      expect(boundNames()).toEqual(['gpio'])
    } finally {
      globalThis.TextDecoder = RealTextDecoder
    }
  })

  it('works against a SharedArrayBuffer heap, as -pthread gives us', () => {
    const bridge = createFakeBridge(
      [{ name: 'gpio', deviceId: VIRTIO_ID_GPIO, numQueues: 2, config: GPIO_CONFIG }],
      { shared: true },
    )
    expect(bridge.module.HEAPU8).toBeInstanceOf(Uint8Array)
    expect((bridge.module.HEAPU8 as Uint8Array).buffer).toBeInstanceOf(SharedArrayBuffer)

    const gpio = createGpioModel()
    register(gpio)
    attach(bridge.module)
    pollOnce()

    expect(boundNames()).toEqual(['gpio'])
    expect(gpio.ngpio).toBe(8)

    // And a full round trip, so the ring codec is exercised on shared memory.
    const dev = bridge.device('gpio')
    dev.kick(VQ_REQUEST, gpioRequest(MSG_SET_DIRECTION, 4, DIRECTION_OUT), 2)
    pollOnce()
    expect(dev.completions()[0].data).toEqual(Uint8Array.of(STATUS_OK, 0))
  })

  it('keeps polling after a tick throws', () => {
    const bridge = createFakeBridge([{ name: 'angry', deviceId: 99 }])
    let calls = 0
    register({
      name: 'angry',
      handle(req) {
        calls++
        req.reply(Uint8Array.of(calls))
      },
    })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('angry')
    dev.kick(0, Uint8Array.of(1), 4)
    pollOnce()
    expect(calls).toBe(1)

    // A later request still gets served — the loop did not latch off.
    dev.kick(0, Uint8Array.of(2), 4)
    pollOnce()
    expect(calls).toBe(2)
  })

  it('still delivers a request that arrives before it notices the reset', () => {
    // The sequence that hung a real boot: the guest driver resets the device
    // during probe, then kicks, and only afterwards does the page get a tick.
    // Rewinding to QEMU's write index on reset ate that request, and the guest
    // sat in `k_sem_take(…, K_FOREVER)` with nothing on screen.
    const bridge = createFakeBridge([{ name: 'probe', deviceId: 99 }])
    const seen: number[] = []
    register({
      name: 'probe',
      handle(req) {
        seen.push(req.out[0])
        req.reply(Uint8Array.of(0))
      },
    })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('probe')
    dev.reset()
    dev.kick(0, Uint8Array.of(0x5a), 4) // written after the reset, before any poll
    pollOnce()

    expect(seen).toEqual([0x5a])
    expect(dev.completions()).toHaveLength(1)
  })

  it('lets a model raise a config-change interrupt', () => {
    const bridge = createFakeBridge([
      { name: 'cfg', deviceId: 99, config: Uint8Array.of(1, 2, 3, 4) },
    ])
    let bump: (() => void) | null = null
    register({
      name: 'cfg',
      handle: (req) => req.fail(),
      attachConfig(config, notify) {
        expect(Array.from(config.subarray(0, 4))).toEqual([1, 2, 3, 4])
        config[0] = 0x42
        bump = notify
      },
    })
    attach(bridge.module)
    pollOnce()

    const dev = bridge.device('cfg')
    expect(dev.config[0]).toBe(0x42)
    expect(dev.configGen()).toBe(0)
    bump!()
    expect(dev.configGen()).toBe(1)
  })

  /*
   * Every other test here drives the loop by hand through pollOnce. This one
   * does not touch it: what is under test is the scheduling itself, which is
   * where the guest's latency comes from once it is blocking on us.
   *
   * What it cannot check is the reason the hot path bounces through a
   * MessagePort before arming its timer — browsers clamp a timer nested inside
   * another timer's callback to 4 ms, and node does not clamp at all, so the
   * pace here is honest about the plumbing and says nothing about the clamp.
   * The number that answers that question is `bridgePollMs` from
   * src/display/profile.ts, read in a real browser.
   */
  it('drives itself, and counts what it drained and how fast it looked', async () => {
    const bridge = createFakeBridge([
      { name: 'gpio', deviceId: VIRTIO_ID_GPIO, numQueues: 2, config: GPIO_CONFIG },
    ])
    register(createGpioModel())
    const before = stats()

    attach(bridge.module)
    const dev = bridge.device('gpio')
    dev.kick(VQ_REQUEST, gpioRequest(MSG_SET_DIRECTION, 0, DIRECTION_OUT), 8)

    const deadline = Date.now() + 2000
    while (dev.completions().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // Answering opens the hot window; let the loop spin inside it long enough
    // to have timed itself against a predecessor.
    await new Promise((resolve) => setTimeout(resolve, 40))

    const after = stats()
    expect(after.requests).toBe(before.requests + 1)
    // A request opens the hot window, so the loop should have gone round it a
    // few times under its own power while we waited.
    expect(after.hotPolls).toBeGreaterThan(before.hotPolls)
    const gap =
      (after.hotGapMsSum - before.hotGapMsSum) / Math.max(1, after.hotPolls - before.hotPolls)
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThan(20)
  })

  it('drains from the atomic request waiter without waiting for a timer', () => {
    class FakeRequestWaiter {
      static instance: FakeRequestWaiter | null = null

      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      posted: unknown = null
      terminated = false

      constructor(..._args: unknown[]) {
        FakeRequestWaiter.instance = this
      }

      postMessage(message: unknown) {
        this.posted = message
      }

      terminate() {
        this.terminated = true
      }

      emit(data: unknown) {
        this.onmessage?.({ data } as MessageEvent)
      }
    }

    vi.stubGlobal('Worker', FakeRequestWaiter)
    try {
      const bridge = createFakeBridge([{ name: 'echo', deviceId: 99 }], {
        shared: true,
      })
      register({
        name: 'echo',
        handle: (req) => req.reply(req.out.slice()),
      })
      const before = stats()

      attach(bridge.module)
      const worker = FakeRequestWaiter.instance
      expect(worker).not.toBeNull()
      expect(worker!.posted).toMatchObject({
        type: 'start',
        wordIndex: 3,
      })
      worker!.emit({ type: 'ready' })
      expect(stats().waiterActive).toBe(true)

      const dev = bridge.device('echo')
      dev.kick(0, Uint8Array.of(1, 2, 3), 3)
      expect(dev.completions()).toEqual([])

      worker!.emit({ type: 'wake', count: 1 })
      expect(dev.completions()).toHaveLength(1)
      expect(stats().waiterWakeups).toBe(before.waiterWakeups + 1)

      detach()
      expect(worker!.terminated).toBe(true)
      expect(stats().waiterActive).toBe(false)
    } finally {
      detach()
      vi.unstubAllGlobals()
    }
  })

  it('Atomics.notify-s the wake word and kicks QEMU after each completion', () => {
    const bridge = createFakeBridge([
      { name: 'echo', deviceId: 99 },
    ])
    register({
      name: 'echo',
      handle: (req) => req.reply(req.out.slice()),
    })
    const before = stats()
    const wakeAddr = (bridge.module as { _qemu_virtio_browser_wake_addr: () => number })
      ._qemu_virtio_browser_wake_addr()
    const words = new Int32Array((bridge.module as { HEAPU8: Uint8Array }).HEAPU8.buffer)
    const wakeBefore = Atomics.load(words, wakeAddr >> 2)

    attach(bridge.module)
    const dev = bridge.device('echo')
    dev.kick(0, Uint8Array.of(1, 2, 3), 3)
    pollOnce()

    const after = stats()
    expect(after.kicks).toBe(before.kicks + 1)
    // kick export and the page both bump the word — at least one notify landed.
    expect(Atomics.load(words, wakeAddr >> 2)).toBeGreaterThan(wakeBefore)
    expect(dev.completions()).toHaveLength(1)
  })

  it('coalesces one page→QEMU kick for a multi-request drain', () => {
    // Mirrors virtio-i2c: the guest queues every message of a transfer, then
    // notifies once, so N chains land in one poll. Each used to kick QEMU on
    // its own reply; one BH is enough for the whole batch.
    const bridge = createFakeBridge([{ name: 'echo', deviceId: 99 }])
    register({
      name: 'echo',
      handle: (req) => req.reply(req.out.slice()),
    })
    const before = stats()
    attach(bridge.module)
    const dev = bridge.device('echo')
    dev.kick(0, Uint8Array.of(1), 1)
    dev.kick(0, Uint8Array.of(2), 1)
    dev.kick(0, Uint8Array.of(3), 1)
    pollOnce()

    const after = stats()
    expect(after.requests).toBe(before.requests + 3)
    expect(after.kicks).toBe(before.kicks + 1)
    expect(dev.completions()).toHaveLength(3)
  })

  it('still kicks immediately for a reply outside the poll', () => {
    let held: VirtioRequest | null = null
    const bridge = createFakeBridge([{ name: 'park', deviceId: 99 }])
    register({
      name: 'park',
      handle(req) {
        req.park()
        held = req
      },
    })
    const before = stats()
    attach(bridge.module)
    const dev = bridge.device('park')
    dev.kick(0, Uint8Array.of(1), 1)
    pollOnce()
    // Parking answers nothing, so the drain produced no completion wake.
    expect(stats().kicks).toBe(before.kicks)
    expect(held).not.toBeNull()

    held!.reply(Uint8Array.of(0xaa))
    expect(stats().kicks).toBe(before.kicks + 1)
    expect(dev.completions()).toHaveLength(1)
  })
})

describe('virtio-gpio model', () => {
  let bridge: ReturnType<typeof createFakeBridge>
  let gpio: ReturnType<typeof createGpioModel>

  /** Submit one request-queue message and return its two-byte answer. */
  function request(type: number, line: number, value = 0) {
    const dev = bridge.device('gpio')
    dev.kick(VQ_REQUEST, gpioRequest(type, line, value), 2)
    pollOnce()
    const [done] = dev.completions()
    return { status: done.data[0], value: done.data[1] }
  }

  beforeEach(() => {
    detach()
    bridge = createFakeBridge([
      { name: 'gpio', deviceId: VIRTIO_ID_GPIO, numQueues: 2, config: GPIO_CONFIG },
    ])
    gpio = createGpioModel()
    register(gpio)
    attach(bridge.module)
    pollOnce()
  })

  it('reads ngpio out of config space', () => {
    expect(gpio.ngpio).toBe(8)
  })

  it('rejects a line beyond ngpio', () => {
    expect(request(MSG_GET_DIRECTION, 8).status).toBe(STATUS_ERR)
  })

  it('round-trips direction', () => {
    expect(request(MSG_SET_DIRECTION, 2, DIRECTION_OUT).status).toBe(STATUS_OK)
    expect(request(MSG_GET_DIRECTION, 2)).toEqual({
      status: STATUS_OK,
      value: DIRECTION_OUT,
    })
  })

  it('reads an input line from what the page drives', () => {
    request(MSG_SET_DIRECTION, 1, DIRECTION_IN)
    gpio.setInputs(0b0000_0010)
    expect(request(MSG_GET_VALUE, 1)).toEqual({ status: STATUS_OK, value: 1 })
    gpio.setInputs(0)
    expect(request(MSG_GET_VALUE, 1)).toEqual({ status: STATUS_OK, value: 0 })
  })

  it('reports a guest-driven output back to the page', () => {
    const seen: number[] = []
    gpio.subscribe(() => seen.push(gpio.getOutputs()))

    request(MSG_SET_DIRECTION, 4, DIRECTION_OUT)
    // Direction changes also notify (claimed-pin table dir column).
    expect(seen).toEqual([0])
    expect(request(MSG_SET_VALUE, 4, 1).status).toBe(STATUS_OK)
    expect(gpio.getOutputs()).toBe(0b0001_0000)
    // Push, not poll: the page learns the moment the guest writes.
    expect(seen).toEqual([0, 0b0001_0000])
    expect(request(MSG_GET_VALUE, 4)).toEqual({ status: STATUS_OK, value: 1 })
  })

  it('refuses to read a line with no direction', () => {
    expect(request(MSG_GET_VALUE, 3).status).toBe(STATUS_ERR)
  })

  it('rejects an unknown direction and an unknown irq type', () => {
    expect(request(MSG_SET_DIRECTION, 0, 0x7f).status).toBe(STATUS_ERR)
    expect(request(MSG_IRQ_TYPE, 0, 0x7f).status).toBe(STATUS_ERR)
  })

  it('fires a rising-edge interrupt on the parked event chain', () => {
    const dev = bridge.device('gpio')
    request(MSG_SET_DIRECTION, 0, DIRECTION_IN)
    request(MSG_IRQ_TYPE, 0, IRQ_TYPE_EDGE_RISING)

    const token = dev.kick(VQ_EVENT, eventRequest(0), 1)
    pollOnce()
    expect(dev.completions()).toEqual([]) // parked

    gpio.setInputs(0b0000_0001)
    expect(dev.completions()).toEqual([
      { token, flags: CMP_OK, data: Uint8Array.of(IRQ_STATUS_VALID) },
    ])
  })

  it('does not fire a rising edge on a falling one', () => {
    const dev = bridge.device('gpio')
    request(MSG_SET_DIRECTION, 0, DIRECTION_IN)
    request(MSG_IRQ_TYPE, 0, IRQ_TYPE_EDGE_RISING)
    gpio.setInputs(0b0000_0001)

    dev.kick(VQ_EVENT, eventRequest(0), 1)
    pollOnce()
    gpio.setInputs(0)
    expect(dev.completions()).toEqual([])
  })

  it('catches a press and release inside what used to be one sampling tick', () => {
    // The C model sampled at 10 ms, so this pair was invisible. The model now
    // lives where the events originate, so both edges land.
    const dev = bridge.device('gpio')
    request(MSG_SET_DIRECTION, 0, DIRECTION_IN)
    request(MSG_IRQ_TYPE, 0, IRQ_TYPE_EDGE_BOTH)

    dev.kick(VQ_EVENT, eventRequest(0), 1)
    pollOnce()
    gpio.setInputs(0b0000_0001)
    expect(dev.completions()).toHaveLength(1)

    dev.kick(VQ_EVENT, eventRequest(0), 1)
    pollOnce()
    gpio.setInputs(0)
    expect(dev.completions()).toHaveLength(1)
  })

  it('fires a level-triggered line that is already at its level when armed', () => {
    const dev = bridge.device('gpio')
    request(MSG_SET_DIRECTION, 2, DIRECTION_IN)
    request(MSG_IRQ_TYPE, 2, IRQ_TYPE_LEVEL_HIGH)
    gpio.setInputs(0b0000_0100)

    const token = dev.kick(VQ_EVENT, eventRequest(2), 1)
    pollOnce()
    expect(dev.completions()).toEqual([
      { token, flags: CMP_OK, data: Uint8Array.of(IRQ_STATUS_VALID) },
    ])
  })

  it('releases the parked chain when the interrupt is disabled', () => {
    const dev = bridge.device('gpio')
    request(MSG_SET_DIRECTION, 0, DIRECTION_IN)
    request(MSG_IRQ_TYPE, 0, IRQ_TYPE_EDGE_RISING)
    const token = dev.kick(VQ_EVENT, eventRequest(0), 1)
    pollOnce()
    expect(dev.completions()).toEqual([]) // parked

    // Disabling answers the IRQ_TYPE request *and* releases the chain, so both
    // land in the same drain — hence not going through the `request` helper,
    // which only looks at the first.
    dev.kick(VQ_REQUEST, gpioRequest(MSG_IRQ_TYPE, 0, IRQ_TYPE_NONE), 2)
    pollOnce()

    const done = dev.completions()
    expect(done[0].data).toEqual(Uint8Array.of(STATUS_OK, 0))
    expect(done[1]).toEqual({
      token,
      flags: CMP_OK,
      data: Uint8Array.of(IRQ_STATUS_INVALID),
    })
  })

  it('rejects a second event chain for a line that already has one', () => {
    const dev = bridge.device('gpio')
    request(MSG_SET_DIRECTION, 0, DIRECTION_IN)
    dev.kick(VQ_EVENT, eventRequest(0), 1)
    pollOnce()
    dev.completions()

    const token = dev.kick(VQ_EVENT, eventRequest(0), 1)
    pollOnce()
    expect(dev.completions()).toEqual([
      { token, flags: CMP_OK, data: Uint8Array.of(IRQ_STATUS_INVALID) },
    ])
  })

  it('drops outputs and parked chains when the guest resets it', () => {
    const dev = bridge.device('gpio')
    request(MSG_SET_DIRECTION, 4, DIRECTION_OUT)
    request(MSG_SET_VALUE, 4, 1)
    expect(gpio.getOutputs()).toBe(0b0001_0000)

    dev.reset()
    pollOnce()

    // Outputs low, so a browser LED goes dark with the guest.
    expect(gpio.getOutputs()).toBe(0)
    expect(request(MSG_GET_DIRECTION, 4).value).toBe(0)
  })
})
