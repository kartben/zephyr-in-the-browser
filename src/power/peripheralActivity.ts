/**
 * Host-side peripheral activity for the Trace · Power tab.
 *
 * I²C / SPI transfers (and GPIO output edges) are stamped with
 * `performance.now()` and mapped onto approximate guest CTF ns via
 * {@link guestNsApproxFromHostMs}. This is not device-runtime PM — it answers
 * “was this chip on the bus?” while CPU residency answers “was the core idle?”
 */

import { guestNsApproxFromHostMs } from '@/hostTrace'
import { gpioModel, i2cModel, spiModel } from '@/virtio'
import type { I2cTransaction } from '@/virtio/devices/i2c'
import type { SpiTransaction } from '@/virtio/devices/spi'

export type PeripheralBus = 'i2c' | 'spi' | 'gpio'

export interface PeripheralMark {
  /** Approximate guest CTF ns (affine from host ms). */
  ts: number
  /** Host `performance.now()` stamp. */
  atMs: number
  bus: PeripheralBus
  /** Stable lane key, e.g. `i2c:40`, `spi:0`, `gpio:out`. */
  laneKey: string
  label: string
  detail: string
  ok: boolean
  bytes?: number
}

export interface PeripheralLane {
  key: string
  bus: PeripheralBus
  label: string
  sub: string
  marks: PeripheralMark[]
}

export interface PeripheralWindowStats {
  lanes: number
  marks: number
  bytes: number
  buses: { i2c: number; spi: number; gpio: number }
}

export type HostToGuestNs = (hostMs: number) => number | null

const GPIO_EDGE_CAP = 400

interface GpioEdge {
  atMs: number
  word: number
  changed: number
}

let gpioEdges: GpioEdge[] = []
let gpioPrev: number | null = null
let gpioListening = false
let gpioUnsub: (() => void) | null = null

function ensureGpioListener() {
  if (gpioListening) return
  gpioListening = true
  gpioPrev = gpioModel.getOutputs()
  gpioUnsub = gpioModel.subscribe(() => {
    const word = gpioModel.getOutputs()
    if (gpioPrev === null) {
      gpioPrev = word
      return
    }
    if (word === gpioPrev) return
    const changed = word ^ gpioPrev
    gpioPrev = word
    gpioEdges.push({ atMs: performance.now(), word, changed })
    if (gpioEdges.length > GPIO_EDGE_CAP) {
      gpioEdges = gpioEdges.slice(gpioEdges.length - GPIO_EDGE_CAP)
    }
  })
}

/** Test helper — drop recorded GPIO edges and optionally stop listening. */
export function resetGpioActivityForTests(stop = false) {
  gpioEdges = []
  gpioPrev = null
  if (stop && gpioUnsub) {
    gpioUnsub()
    gpioUnsub = null
    gpioListening = false
  }
}

/** Test helper — append a synthetic GPIO edge. */
export function debugPushGpioEdge(atMs: number, word: number, changed: number) {
  gpioEdges.push({ atMs, word, changed })
}

function shortChipName(name: string | null, fallback: string): string {
  if (!name) return fallback
  const first = name.trim().split(/\s+/)[0] ?? name
  return first.length > 12 ? first.slice(0, 11) + '…' : first
}

export function marksFromI2c(
  txs: readonly I2cTransaction[],
  mapHost: HostToGuestNs,
): PeripheralMark[] {
  const marks: PeripheralMark[] = []
  for (const tx of txs) {
    const ts = mapHost(tx.atMs)
    if (ts == null) continue
    const addr = `0x${tx.address.toString(16)}`
    marks.push({
      ts,
      atMs: tx.atMs,
      bus: 'i2c',
      laneKey: `i2c:${tx.address.toString(16)}`,
      label: shortChipName(tx.chip, addr),
      detail: `${tx.dir} ${addr}`,
      ok: tx.ok,
      bytes: tx.byteLength,
    })
  }
  return marks
}

export function marksFromSpi(
  txs: readonly SpiTransaction[],
  mapHost: HostToGuestNs,
): PeripheralMark[] {
  const marks: PeripheralMark[] = []
  for (const tx of txs) {
    const ts = mapHost(tx.atMs)
    if (ts == null) continue
    const cs = `CS${tx.cs}`
    marks.push({
      ts,
      atMs: tx.atMs,
      bus: 'spi',
      laneKey: `spi:${tx.cs}`,
      label: shortChipName(tx.chip, cs),
      detail: `${cs} · ${tx.byteLength} B`,
      ok: tx.ok,
      bytes: tx.byteLength,
    })
  }
  return marks
}

export function marksFromGpioEdges(
  edges: readonly GpioEdge[],
  mapHost: HostToGuestNs,
): PeripheralMark[] {
  const marks: PeripheralMark[] = []
  for (const edge of edges) {
    const ts = mapHost(edge.atMs)
    if (ts == null) continue
    marks.push({
      ts,
      atMs: edge.atMs,
      bus: 'gpio',
      laneKey: 'gpio:out',
      label: 'GPIO',
      detail: `out 0x${edge.word.toString(16)}`,
      ok: true,
    })
  }
  return marks
}

/**
 * Build peripheral marks in approximate guest-ns space from the current I²C /
 * SPI rings (+ GPIO output edges). Marks that cannot be mapped are dropped.
 */
export function collectPeripheralMarks(
  mapHost: HostToGuestNs = guestNsApproxFromHostMs,
): PeripheralMark[] {
  ensureGpioListener()
  const marks = [
    ...marksFromI2c(i2cModel.transactions(), mapHost),
    ...marksFromSpi(spiModel.transactions(), mapHost),
    ...marksFromGpioEdges(gpioEdges, mapHost),
  ]
  marks.sort((a, b) => a.ts - b.ts)
  return marks
}

/** Group marks into swimlanes (chip / CS / GPIO), newest activity first. */
export function reconstructPeripheralLanes(
  marks: PeripheralMark[],
  view0: number,
  view1: number,
): PeripheralLane[] {
  const inView = marks.filter((m) => m.ts >= view0 && m.ts <= view1)
  const byKey = new Map<string, PeripheralLane>()

  for (const m of inView) {
    let lane = byKey.get(m.laneKey)
    if (!lane) {
      lane = {
        key: m.laneKey,
        bus: m.bus,
        label: m.label,
        sub: m.bus === 'i2c' ? 'I²C' : m.bus === 'spi' ? 'SPI' : 'GPIO',
        marks: [],
      }
      byKey.set(m.laneKey, lane)
    } else if (m.label !== lane.label && m.label.length >= lane.label.length) {
      lane.label = m.label
    }
    lane.marks.push(m)
  }

  return [...byKey.values()].sort((a, b) => {
    const busOrder = { i2c: 0, spi: 1, gpio: 2 }
    const d = busOrder[a.bus] - busOrder[b.bus]
    if (d !== 0) return d
    return a.key.localeCompare(b.key)
  })
}

export function peripheralWindowStats(lanes: PeripheralLane[]): PeripheralWindowStats {
  let marks = 0
  let bytes = 0
  const buses = { i2c: 0, spi: 0, gpio: 0 }
  for (const lane of lanes) {
    marks += lane.marks.length
    buses[lane.bus] += lane.marks.length
    for (const m of lane.marks) bytes += m.bytes ?? 0
  }
  return { lanes: lanes.length, marks, bytes, buses }
}
