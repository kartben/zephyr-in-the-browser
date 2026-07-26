/**
 * Page-side ADI TMCM-3216 model over uart1 TMCL/RS485.
 *
 * Speaks the 9-byte datagram Zephyr's `adi_tmcm_rs485` expects: guest TX is
 * looped back in QEMU (RS485 echo); we parse complete frames and feed 9-byte
 * replies. Axis motion is simulated in wall time so the dock dial tracks
 * position/velocity while `samples/drivers/stepper/tmcm3216` ping-pongs.
 */

import * as hostUart1 from '@/hostUart1'
import type { StepperAxisSnapshot, StepperSnapshot } from '@/hostStepper'

const FRAME = 9
const STATUS_OK = 100

const CMD_ROR = 1
const CMD_ROL = 2
const CMD_MST = 3
const CMD_MVP = 4
const CMD_SAP = 5
const CMD_GAP = 6

const MVP_ABS = 0
const MVP_REL = 1

const AP_TARGET_POSITION = 0
const AP_ACTUAL_POSITION = 1
const AP_TARGET_VELOCITY = 2
const AP_ACTUAL_VELOCITY = 3
const AP_MAX_VELOCITY = 4
const AP_MAX_ACCELERATION = 5
const AP_MAX_CURRENT = 6
const AP_STANDBY_CURRENT = 7
const AP_POSITION_REACHED = 8
const AP_RIGHT_ENDSTOP = 10
const AP_LEFT_ENDSTOP = 11
const AP_MICROSTEP_RESOLUTION = 140

/** Default microstep code 4 → 1/16 (matches stock sample overlay). */
const DEFAULT_MRES = 4

interface AxisState {
  actualPosition: number
  targetPosition: number
  actualVelocity: number
  maxVelocity: number
  maxAcceleration: number
  maxCurrent: number
  standbyCurrent: number
  positionReached: boolean
  rightEndstop: boolean
  leftEndstop: boolean
  microstepRes: number
  /** Continuous run direction: +1 / -1 / 0. */
  runDir: number
}

interface MotionRuntime {
  axis: number
  /** usteps/s signed while animating toward target (MVP) or continuous run. */
  velocity: number
  lastTs: number
  kind: 'mvp' | 'run'
}

let active = false
let unsubTx: (() => void) | undefined
let raf: number | undefined
let rxBuf = new Uint8Array(0)
let moduleAddr = 1

const axes: AxisState[] = [0, 1, 2].map(() => freshAxis())
let motions: MotionRuntime[] = []

const listeners = new Set<() => void>()
let snapshotCache: StepperSnapshot = { axes: [] }

function freshAxis(): AxisState {
  return {
    actualPosition: 0,
    targetPosition: 0,
    actualVelocity: 0,
    maxVelocity: 2000,
    maxAcceleration: 500,
    maxCurrent: 100,
    standbyCurrent: 0,
    positionReached: true,
    rightEndstop: false,
    leftEndstop: false,
    microstepRes: DEFAULT_MRES,
    runDir: 0,
  }
}

function checksum(datagram: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < FRAME - 1; i++) sum = (sum + datagram[i]!) & 0xff
  return sum
}

function be32(n: number): [number, number, number, number] {
  const v = n >>> 0
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}

function readBe32(buf: Uint8Array, off: number): number {
  return (
    ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0
  )
}

function toSigned32(u: number): number {
  return u | 0
}

function reply(cmd: number, value: number): void {
  const data = be32(value)
  const frame = new Uint8Array([
    2, // host address (conventional)
    moduleAddr & 0xff,
    STATUS_OK,
    cmd & 0xff,
    data[0]!,
    data[1]!,
    data[2]!,
    data[3]!,
    0,
  ])
  frame[8] = checksum(frame)
  hostUart1.feed(frame)
}

function axisOf(bank: number): AxisState | undefined {
  if (bank < 0 || bank > 2) return undefined
  return axes[bank]
}

function stopMotion(axisIdx: number) {
  motions = motions.filter((m) => m.axis !== axisIdx)
  const ax = axes[axisIdx]!
  ax.actualVelocity = 0
  ax.runDir = 0
}

function startMvp(axisIdx: number, target: number) {
  const ax = axes[axisIdx]!
  ax.targetPosition = target
  ax.positionReached = false
  const delta = target - ax.actualPosition
  if (delta === 0) {
    ax.positionReached = true
    ax.actualVelocity = 0
    stopMotion(axisIdx)
    notify()
    return
  }
  const speed = Math.max(1, ax.maxVelocity)
  const velocity = delta > 0 ? speed : -speed
  ax.actualVelocity = velocity
  ax.runDir = 0
  motions = motions.filter((m) => m.axis !== axisIdx)
  motions.push({ axis: axisIdx, velocity, lastTs: performance.now(), kind: 'mvp' })
  ensureAnim()
  notify()
}

function startRun(axisIdx: number, dir: number) {
  const ax = axes[axisIdx]!
  const speed = Math.max(1, ax.maxVelocity)
  const velocity = dir * speed
  ax.positionReached = false
  ax.actualVelocity = velocity
  ax.runDir = dir
  motions = motions.filter((m) => m.axis !== axisIdx)
  motions.push({ axis: axisIdx, velocity, lastTs: performance.now(), kind: 'run' })
  ensureAnim()
  notify()
}

function ensureAnim() {
  if (raf !== undefined) return
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? (cb: (t: number) => void) => requestAnimationFrame(cb)
      : (cb: (t: number) => void) =>
          setTimeout(() => cb(performance.now()), 16) as unknown as number

  const tick = (now: number) => {
    raf = undefined
    if (motions.length === 0) {
      notify()
      return
    }
    for (const m of motions.slice()) {
      const ax = axes[m.axis]!
      const dt = Math.max(0, (now - m.lastTs) / 1000)
      m.lastTs = now
      if (dt <= 0) continue
      if (m.kind === 'mvp') {
        const remaining = ax.targetPosition - ax.actualPosition
        const step = m.velocity * dt
        if (Math.abs(step) >= Math.abs(remaining)) {
          ax.actualPosition = ax.targetPosition
          ax.actualVelocity = 0
          ax.positionReached = true
          stopMotion(m.axis)
        } else {
          ax.actualPosition = Math.round(ax.actualPosition + step)
          ax.actualVelocity = m.velocity
        }
      } else {
        ax.actualPosition = Math.round(ax.actualPosition + m.velocity * dt)
        ax.actualVelocity = m.velocity
      }
    }
    notify()
    if (motions.length > 0) raf = schedule(tick) as number
  }
  raf = schedule(tick) as number
}

function handleFrame(frame: Uint8Array) {
  if (checksum(frame) !== frame[8]) return

  const addr = frame[0]!
  const cmd = frame[1]!
  const type = frame[2]!
  const bank = frame[3]!
  const data = toSigned32(readBe32(frame, 4))

  moduleAddr = addr
  const ax = axisOf(bank)

  switch (cmd) {
    case CMD_SAP: {
      if (!ax) {
        reply(cmd, 0)
        return
      }
      switch (type) {
        case AP_ACTUAL_POSITION:
          ax.actualPosition = data
          ax.targetPosition = data
          ax.positionReached = true
          stopMotion(bank)
          break
        case AP_TARGET_POSITION:
          ax.targetPosition = data
          break
        case AP_TARGET_VELOCITY:
          ax.actualVelocity = data
          break
        case AP_MAX_VELOCITY:
          ax.maxVelocity = data >>> 0
          break
        case AP_MAX_ACCELERATION:
          ax.maxAcceleration = data >>> 0
          break
        case AP_MAX_CURRENT:
          ax.maxCurrent = data >>> 0
          break
        case AP_STANDBY_CURRENT:
          ax.standbyCurrent = data >>> 0
          break
        case AP_MICROSTEP_RESOLUTION:
          ax.microstepRes = data >>> 0
          break
        case AP_POSITION_REACHED:
          ax.positionReached = data !== 0
          break
        default:
          break
      }
      reply(cmd, data)
      notify()
      return
    }
    case CMD_GAP: {
      if (!ax) {
        reply(cmd, 0)
        return
      }
      let value = 0
      switch (type) {
        case AP_TARGET_POSITION:
          value = ax.targetPosition
          break
        case AP_ACTUAL_POSITION:
          value = ax.actualPosition
          break
        case AP_TARGET_VELOCITY:
        case AP_ACTUAL_VELOCITY:
          value = ax.actualVelocity
          break
        case AP_MAX_VELOCITY:
          value = ax.maxVelocity
          break
        case AP_MAX_ACCELERATION:
          value = ax.maxAcceleration
          break
        case AP_MAX_CURRENT:
          value = ax.maxCurrent
          break
        case AP_STANDBY_CURRENT:
          value = ax.standbyCurrent
          break
        case AP_POSITION_REACHED:
          value = ax.positionReached ? 1 : 0
          break
        case AP_RIGHT_ENDSTOP:
          value = ax.rightEndstop ? 1 : 0
          break
        case AP_LEFT_ENDSTOP:
          value = ax.leftEndstop ? 1 : 0
          break
        case AP_MICROSTEP_RESOLUTION:
          value = ax.microstepRes
          break
        default:
          value = 0
          break
      }
      reply(cmd, value)
      return
    }
    case CMD_MVP: {
      if (!ax) {
        reply(cmd, 0)
        return
      }
      if (type === MVP_REL) startMvp(bank, ax.actualPosition + data)
      else if (type === MVP_ABS) startMvp(bank, data)
      reply(cmd, data)
      return
    }
    case CMD_ROR: {
      if (ax) startRun(bank, 1)
      reply(cmd, data)
      return
    }
    case CMD_ROL: {
      if (ax) startRun(bank, -1)
      reply(cmd, data)
      return
    }
    case CMD_MST: {
      if (ax) {
        stopMotion(bank)
        ax.positionReached = true
        ax.actualVelocity = 0
        notify()
      }
      reply(cmd, 0)
      return
    }
    default:
      reply(cmd, 0)
  }
}

function onTx(bytes: Uint8Array) {
  if (!active) return
  // RS485 local-echo first (one RX stream: echo bytes, then the TMCL reply).
  hostUart1.feed(bytes)

  const merged = new Uint8Array(rxBuf.length + bytes.length)
  merged.set(rxBuf, 0)
  merged.set(bytes, rxBuf.length)
  let offset = 0
  while (merged.length - offset >= FRAME) {
    const frame = merged.subarray(offset, offset + FRAME)
    handleFrame(frame)
    offset += FRAME
  }
  rxBuf = merged.subarray(offset)
}

function buildSnapshot(): StepperSnapshot {
  return {
    axes: axes.map((ax, i) => {
      const moving = Math.abs(ax.actualVelocity) >= 0.5
      return {
        id: `tmcm3216-axis-${i}`,
        label: `Motor ${i}`,
        stepPin: -1,
        dirPin: -1,
        position: ax.actualPosition,
        directionPositive: ax.actualVelocity >= 0,
        stepsPerSec: Math.abs(ax.actualVelocity),
        stepActive: false,
        dirActive: ax.actualVelocity > 0,
        moving,
      } satisfies StepperAxisSnapshot
    }),
  }
}

function snapshotsEqual(a: StepperSnapshot, b: StepperSnapshot): boolean {
  if (a.axes.length !== b.axes.length) return false
  for (let i = 0; i < a.axes.length; i++) {
    const x = a.axes[i]!
    const y = b.axes[i]!
    if (
      x.position !== y.position ||
      x.moving !== y.moving ||
      x.directionPositive !== y.directionPositive ||
      Math.abs(x.stepsPerSec - y.stepsPerSec) > 0.5
    ) {
      return false
    }
  }
  return true
}

function notify() {
  const next = buildSnapshot()
  if (!snapshotsEqual(snapshotCache, next)) {
    snapshotCache = next
  }
  for (const fn of listeners) fn()
}

/** Start TMCL simulation on uart1 (pauses GNSS NMEA while active). */
export function attach(): void {
  if (active) return
  active = true
  rxBuf = new Uint8Array(0)
  for (let i = 0; i < axes.length; i++) axes[i] = freshAxis()
  motions = []
  unsubTx = hostUart1.onTx(onTx)
  notify()
}

export function detach(): void {
  if (!active) return
  active = false
  unsubTx?.()
  unsubTx = undefined
  if (raf !== undefined) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
    else clearTimeout(raf)
  }
  raf = undefined
  motions = []
  notify()
}

export function isActive(): boolean {
  return active
}

export function getSnapshot(): StepperSnapshot {
  return snapshotCache
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Test helper. */
export function resetForTests() {
  detach()
  listeners.clear()
  snapshotCache = { axes: [] }
  moduleAddr = 1
}

/** Test helper: feed a raw guest TX frame (bypasses UART). */
export function handleFrameForTests(frame: Uint8Array) {
  const was = active
  active = true
  handleFrame(frame)
  active = was
}

export function checksumForTests(datagram: Uint8Array): number {
  return checksum(datagram)
}
