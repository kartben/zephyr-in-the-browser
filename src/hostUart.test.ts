import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeUartModule } from '@/serial/testing/fakeUartModule'
import type { SerialOpenOptions, SerialPortInfo } from '@/serial/webSerial'

/** The devicetree the pipe consults before opening a port on its own. */
const tree = vi.hoisted(() => ({
  phase: 'ready' as 'pending' | 'ready' | 'absent',
  uartPaths: ['/soc/uart@4000c000', '/soc/uart@4000d000'],
  listeners: new Set<() => void>(),
}))

vi.mock('@/devicetree', () => ({
  get: () => ({ insights: { uartBuses: tree.uartPaths.map((path) => ({ path })) } }),
  getPhase: () => tree.phase,
  subscribe: (fn: () => void) => {
    tree.listeners.add(fn)
    return () => tree.listeners.delete(fn)
  },
}))

import * as hostUart from '@/hostUart'
import * as serialStore from '@/lib/serialStore'

const UART1 = 'uart@4000d000'
const FTDI: SerialPortInfo = { usbVendorId: 0x0403, usbProductId: 0x6001 }

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

/** A USB-serial adapter: what the guest sends lands in `written`. */
class FakePort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  written: number[] = []
  opens: SerialOpenOptions[] = []
  plugged = true
  failOpen: Error | null = null
  private source: ReadableStreamDefaultController<Uint8Array> | null = null

  constructor(private info: SerialPortInfo) {
    super()
  }

  getInfo() {
    return this.info
  }

  async open(options: SerialOpenOptions) {
    if (this.failOpen) throw this.failOpen
    if (this.readable) throw new DOMException('already open', 'InvalidStateError')
    this.opens.push(options)
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.source = c
      },
    })
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.written.push(...chunk)
      },
    })
  }

  async close() {
    this.readable = null
    this.writable = null
    this.source = null
  }

  /** The device sends bytes. */
  receive(bytes: number[]) {
    this.source?.enqueue(new Uint8Array(bytes))
  }

  /** Pull the cable: the stream dies and the port has no streams left. */
  unplug() {
    this.plugged = false
    this.source?.error(new DOMException('device lost', 'NetworkError'))
    this.source = null
    this.readable = null
    this.writable = null
  }
}

class FakeSerial extends EventTarget {
  ports: FakePort[] = []
  pick: FakePort | null = null

  async getPorts() {
    return this.ports.filter((p) => p.plugged)
  }

  requestPort() {
    const picked = this.pick
    if (!picked) return Promise.reject(new DOMException('no port selected', 'NotFoundError'))
    if (!this.ports.includes(picked)) this.ports.push(picked)
    return Promise.resolve(picked)
  }

  /** Chrome fires `connect` at the port and it bubbles here, target intact. */
  fire(type: 'connect' | 'disconnect', port: FakePort) {
    const event = new Event(type)
    Object.defineProperty(event, 'target', { value: port })
    this.dispatchEvent(event)
  }
}

let serial: FakeSerial

/** Run the 10 ms poll and let the stream promises settle. */
const tick = (ms = 30) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', new MemoryStorage())
  serialStore.reloadFromStorage()
  serial = new FakeSerial()
  vi.stubGlobal('navigator', { serial })
  tree.phase = 'ready'
  tree.uartPaths = ['/soc/uart@4000c000', `/soc/${UART1}`]
})

afterEach(async () => {
  hostUart.detach()
  await tick()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('hostUart', () => {
  it('stays unavailable on an emulator without the uart1 slot', () => {
    hostUart.attach({}, UART1)
    expect(hostUart.available()).toBe(false)
    expect(hostUart.feedSimulated('$GPGGA')).toBe(false)
  })

  it('carries the simulated fix while no port owns uart1', () => {
    const fake = createFakeUartModule()
    hostUart.attach(fake.module, UART1)
    expect(hostUart.getSnapshot()).toMatchObject({ available: true, supported: true, phase: 'idle' })
    expect(hostUart.feedSimulated('$G')).toBe(true)
    expect(fake.take()).toEqual([0x24, 0x47])
  })

  it('reports no Web Serial in a browser without it', () => {
    vi.stubGlobal('navigator', {})
    hostUart.attach(createFakeUartModule().module, UART1)
    expect(hostUart.getSnapshot()).toMatchObject({ available: true, supported: false })
  })

  it('pipes both ways once the user picks a port, and saves it', async () => {
    const fake = createFakeUartModule()
    hostUart.attach(fake.module, UART1)
    const port = new FakePort(FTDI)
    serial.pick = port

    hostUart.chooseAndConnect(9600)
    await tick()

    expect(port.opens).toEqual([{ baudRate: 9600 }])
    expect(hostUart.getSnapshot()).toMatchObject({
      phase: 'open',
      portLabel: 'FTDI FT232R (0403:6001)',
    })
    expect(serialStore.getPipe('uart1')).toEqual({
      vid: 0x0403,
      pid: 0x6001,
      baudRate: 9600,
      autoReconnect: true,
    })

    port.receive([1, 2, 3])
    await tick()
    expect(fake.take()).toEqual([1, 2, 3])

    fake.transmit([0x41, 0x54, 0x0d])
    await tick()
    expect(port.written).toEqual([0x41, 0x54, 0x0d])

    // A real port owns the wire: the simulated fix stays off it.
    expect(hostUart.isPiped()).toBe(true)
    hostUart.feedSimulated('$GPGGA')
    expect(fake.take()).toEqual([])

    await tick(300)
    expect(hostUart.getSnapshot()).toMatchObject({ rx: 3, tx: 3, dropped: 0 })
  })

  it('holds bytes the guest has no room for, and delivers them in order', async () => {
    const fake = createFakeUartModule({ inCapacity: 4 })
    hostUart.attach(fake.module, UART1)
    const port = new FakePort(FTDI)
    serial.pick = port
    hostUart.chooseAndConnect(115200)
    await tick()

    port.receive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await tick()
    expect(fake.take()).toEqual([1, 2, 3, 4])
    await tick()
    expect(fake.take()).toEqual([5, 6, 7, 8])
    await tick()
    expect(fake.take()).toEqual([9, 10])
  })

  it('treats closing the picker as nothing happening', async () => {
    hostUart.attach(createFakeUartModule().module, UART1)
    serial.pick = null
    hostUart.chooseAndConnect(115200)
    await tick()
    expect(hostUart.getSnapshot()).toMatchObject({ phase: 'idle', error: '' })
  })

  it('says another app may hold a port it cannot open', async () => {
    hostUart.attach(createFakeUartModule().module, UART1)
    const port = new FakePort(FTDI)
    port.failOpen = new DOMException('Failed to open serial port.', 'NetworkError')
    serial.pick = port
    hostUart.chooseAndConnect(115200)
    await tick()
    const snap = hostUart.getSnapshot()
    expect(snap.phase).toBe('error')
    expect(snap.error).toMatch(/Another app may have it open/)
  })

  it('reopens the saved port after a restart, without the picker', async () => {
    serialStore.setPipe('uart1', { vid: 0x0403, pid: 0x6001, baudRate: 9600, autoReconnect: true })
    const port = new FakePort(FTDI)
    serial.ports = [new FakePort({ usbVendorId: 0x10c4, usbProductId: 0xea60 }), port]

    hostUart.attach(createFakeUartModule().module, UART1)
    await tick()

    expect(port.opens).toEqual([{ baudRate: 9600 }])
    expect(hostUart.getSnapshot().phase).toBe('open')
  })

  it('waits for the saved port to be plugged in, then opens it', async () => {
    serialStore.setPipe('uart1', { vid: 0x0403, pid: 0x6001, baudRate: 9600, autoReconnect: true })
    hostUart.attach(createFakeUartModule().module, UART1)
    await tick()
    expect(hostUart.getSnapshot()).toMatchObject({
      phase: 'waiting',
      portLabel: 'FTDI FT232R (0403:6001)',
    })

    const port = new FakePort(FTDI)
    serial.ports = [port]
    serial.fire('connect', port)
    await tick()
    expect(hostUart.getSnapshot().phase).toBe('open')
  })

  it('leaves the saved port alone when reconnecting is off', async () => {
    serialStore.setPipe('uart1', { vid: 0x0403, pid: 0x6001, baudRate: 9600, autoReconnect: false })
    const port = new FakePort(FTDI)
    serial.ports = [port]
    hostUart.attach(createFakeUartModule().module, UART1)
    await tick()
    expect(port.opens).toEqual([])
    expect(hostUart.getSnapshot().phase).toBe('idle')
  })

  it('does not take the port for a guest whose devicetree leaves uart1 off', async () => {
    serialStore.setPipe('uart1', { vid: 0x0403, pid: 0x6001, baudRate: 9600, autoReconnect: true })
    const port = new FakePort(FTDI)
    serial.ports = [port]
    tree.uartPaths = ['/soc/uart@4000c000']
    hostUart.attach(createFakeUartModule().module, UART1)
    await tick()
    expect(port.opens).toEqual([])
  })

  it('waits for the devicetree before opening anything', async () => {
    serialStore.setPipe('uart1', { vid: 0x0403, pid: 0x6001, baudRate: 9600, autoReconnect: true })
    const port = new FakePort(FTDI)
    serial.ports = [port]
    tree.phase = 'pending'
    hostUart.attach(createFakeUartModule().module, UART1)
    await tick()
    expect(port.opens).toEqual([])

    tree.phase = 'ready'
    for (const fn of tree.listeners) fn()
    await tick()
    expect(port.opens).toEqual([{ baudRate: 9600 }])
  })

  it('goes back to waiting when the adapter is unplugged, and resumes on replug', async () => {
    const fake = createFakeUartModule()
    hostUart.attach(fake.module, UART1)
    const port = new FakePort(FTDI)
    serial.pick = port
    hostUart.chooseAndConnect(9600)
    await tick()

    port.unplug()
    serial.fire('disconnect', port)
    await tick()
    expect(hostUart.getSnapshot()).toMatchObject({ phase: 'waiting' })
    // Still piped: a real receiver that dropped out is not replaced by a fake fix.
    expect(hostUart.isPiped()).toBe(true)

    port.plugged = true
    serial.fire('connect', port)
    await tick()
    expect(hostUart.getSnapshot().phase).toBe('open')
    port.receive([7])
    await tick()
    expect(fake.take()).toEqual([7])
  })

  it('forgets the port on Disconnect, so a restart leaves it closed', async () => {
    hostUart.attach(createFakeUartModule().module, UART1)
    const port = new FakePort(FTDI)
    serial.pick = port
    hostUart.chooseAndConnect(9600)
    await tick()

    await hostUart.disconnect()
    expect(hostUart.getSnapshot()).toMatchObject({ phase: 'idle', portLabel: '' })
    expect(serialStore.getPipe('uart1')).toEqual({ baudRate: 9600, autoReconnect: true })
    expect(port.readable).toBeNull()
    expect(hostUart.isPiped()).toBe(false)
  })

  it('reopens an open port at a new baud rate', async () => {
    hostUart.attach(createFakeUartModule().module, UART1)
    const port = new FakePort(FTDI)
    serial.pick = port
    hostUart.chooseAndConnect(9600)
    await tick()

    await hostUart.setBaudRate(115200)
    await tick()
    expect(port.opens).toEqual([{ baudRate: 9600 }, { baudRate: 115200 }])
    expect(hostUart.getSnapshot().phase).toBe('open')
    expect(serialStore.getPipe('uart1')?.baudRate).toBe(115200)
  })
})
