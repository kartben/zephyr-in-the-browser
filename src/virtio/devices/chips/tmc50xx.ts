/**
 * Analog Devices / Trinamic TMC50xx — page-side SPI motion-controller model.
 *
 * Matches Zephyr `drivers/stepper/adi_tmc/tmc50xx` against the stock
 * `samples/drivers/stepper/tmc50xx` ping-pong: 5-byte SPI datagrams
 * (addr + 32-bit BE word), delayed-read latch, motor-0 ramp registers, and a
 * wall-clock motion sim that advances XACTUAL toward XTARGET so RAMPSTAT
 * POS_REACHED fires for the guest's poll. Timing is not silicon-accurate —
 * virtio RTT is ms-scale; the dial tracks the simulated position.
 *
 * Compatible: `adi,tmc50xx`. One axis (idx 0) is enough for the sample.
 */

import type { SpiChip, SpiTransferOpts } from '../spi'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import tmc50xxMap from './maps/tmc50xx.json'

const WRITE_BIT = 0x80
const ADDRESS_MASK = 0x7f
const DATAGRAM = 5

const REG_GCONF = 0x00
const REG_GSTAT = 0x01
const REG_RAMPMODE = 0x20
const REG_XACTUAL = 0x21
const REG_VACTUAL = 0x22
const REG_VMAX = 0x27
const REG_XTARGET = 0x2d
const REG_SWMODE = 0x34
const REG_RAMPSTAT = 0x35
const REG_CHOPCONF = 0x6c
const REG_DRVSTATUS = 0x6f

const RAMPMODE_POSITIONING = 0
const RAMPMODE_POS_VELOCITY = 1
const RAMPMODE_NEG_VELOCITY = 2
const RAMPMODE_HOLD = 3

const RAMPSTAT_POS_REACHED_EVENT = 1 << 7
const RAMPSTAT_POS_REACHED = 1 << 9
const RAMPSTAT_EVENT_CLEAR =
  (1 << 4) | (1 << 5) | (1 << 6) | RAMPSTAT_POS_REACHED_EVENT

const DRVSTATUS_STST = 1 << 31

/** Default clock used to turn VMAX TMC units into a rough µsteps/s. */
const DEFAULT_CLOCK_HZ = 10_000_000

/**
 * Floor for reported µsteps/s while a velocity-mode run is active. Positioning
 * completes on the SPI write (QEMU starves rAF); the dial still eases for color.
 */
const MIN_VELOCITY_USTEPS_PER_SEC = 80_000

/** Dock-only ease after an instant positioning arrive (registers already done). */
const DISPLAY_MOVE_MS = 320

const TMC50XX_REGISTERS = registersFromJson(tmc50xxMap as RegisterMapJson)

export interface Tmc50xxOptions {
  cs?: number
  name?: string
  /** `clock-frequency` from DT — shapes velocity conversion. */
  clockHz?: number
}

export interface Tmc50xxMotorSnapshot {
  position: number
  target: number
  velocity: number
  rampMode: number
  moving: boolean
  enabled: boolean
  stepsPerSec: number
  directionPositive: boolean
}

export interface Tmc50xxChip extends SpiChip {
  /** Chip-select, also used as {@link RegisterMapSource.address}. */
  readonly address: number
  readonly registers: readonly RegisterDecl[]
  readonly motorCount: 1
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  /** Motor 0 live state for the dock dial. */
  getMotor(index?: number): Tmc50xxMotorSnapshot
  version(): number
  subscribe(fn: () => void): () => void
}

export function isTmc50xx(chip: SpiChip | null | undefined): chip is Tmc50xxChip {
  return (
    !!chip &&
    typeof (chip as Tmc50xxChip).getMotor === 'function' &&
    (chip as Tmc50xxChip).motorCount === 1 &&
    Array.isArray((chip as Tmc50xxChip).registers)
  )
}

function asSigned32(n: number): number {
  return n | 0
}

function asU32(n: number): number {
  return n >>> 0
}

/** v[Hz] ≈ v[50xx] * (fCLK / 2) / 2^23  — datasheet µstep velocity. */
function vmaxToUstepsPerSec(vmax: number, clockHz: number): number {
  const v = Math.abs(vmax) >>> 0
  if (v === 0) return 0
  const hz = (v * (clockHz / 2)) / 2 ** 23
  return Math.max(hz, MIN_VELOCITY_USTEPS_PER_SEC)
}

export function createTmc50xx({
  cs = 0,
  name = 'TMC50xx stepper',
  clockHz = DEFAULT_CLOCK_HZ,
}: Tmc50xxOptions = {}): Tmc50xxChip {
  const regs = new Map<number, number>()
  for (const decl of TMC50XX_REGISTERS) {
    regs.set(decl.addr, asU32(decl.reset))
  }
  // Standing still at power-on.
  regs.set(REG_DRVSTATUS, DRVSTATUS_STST)

  let latchAddr = 0
  let latchValid = false
  let pointer = REG_GCONF
  let generation = 0
  let animFrame: number | undefined
  let lastTickMs = 0
  let lastNotifyMs = 0

  // Display-only shaft for the dock. Guest SPI always sees register XACTUAL.
  let displayPos = 0
  let displayFrom = 0
  let displayTo = 0
  let displayStartMs = 0
  let displayFrame: number | undefined

  const listeners = new Set<() => void>()
  const byAddr = new Map(TMC50XX_REGISTERS.map((r) => [r.addr, r]))

  const notify = (force = false) => {
    const now = performance.now()
    if (!force && now - lastNotifyMs < 16) return
    lastNotifyMs = now
    generation++
    for (const fn of listeners) fn()
  }

  const readRaw = (addr: number): number => asU32(regs.get(addr & ADDRESS_MASK) ?? 0)

  const writeRaw = (addr: number, value: number) => {
    regs.set(addr & ADDRESS_MASK, asU32(value))
  }

  const driverEnabled = (): boolean => (readRaw(REG_CHOPCONF) & 0xf) !== 0

  const setMoving = (moving: boolean, velocity = 0) => {
    let drv = readRaw(REG_DRVSTATUS)
    if (moving) drv &= ~DRVSTATUS_STST
    else drv |= DRVSTATUS_STST
    writeRaw(REG_DRVSTATUS, drv)
    writeRaw(REG_VACTUAL, asU32(velocity | 0))
  }

  const markPositionReached = () => {
    const ramp = readRaw(REG_RAMPSTAT) | RAMPSTAT_POS_REACHED | RAMPSTAT_POS_REACHED_EVENT
    writeRaw(REG_RAMPSTAT, ramp)
    setMoving(false, 0)
  }

  const clearPositionReached = () => {
    writeRaw(
      REG_RAMPSTAT,
      readRaw(REG_RAMPSTAT) & ~RAMPSTAT_POS_REACHED & ~RAMPSTAT_POS_REACHED_EVENT,
    )
  }

  const schedule = (fn: (t: number) => void): number => {
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(fn)
    }
    return setTimeout(() => fn(performance.now()), 16) as unknown as number
  }

  const unschedule = (id: number) => {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(id)
    } else {
      clearTimeout(id)
    }
  }

  const stopAnim = () => {
    if (animFrame !== undefined) {
      unschedule(animFrame)
      animFrame = undefined
    }
  }

  const stopDisplay = () => {
    if (displayFrame !== undefined) {
      unschedule(displayFrame)
      displayFrame = undefined
    }
  }

  const displayMoving = () => displayFrame !== undefined

  const tickDisplay = (now: number) => {
    displayFrame = undefined
    const t = Math.min(1, (now - displayStartMs) / DISPLAY_MOVE_MS)
    const ease = 1 - (1 - t) * (1 - t)
    displayPos = displayFrom + (displayTo - displayFrom) * ease
    if (t < 1) {
      notify()
      displayFrame = schedule(tickDisplay)
      return
    }
    displayPos = displayTo
    notify(true)
  }

  /** Ease the dial toward `to` while registers already hold the final value. */
  const startDisplayMove = (to: number) => {
    stopDisplay()
    displayFrom = displayPos
    displayTo = to
    if (displayFrom === displayTo) {
      notify(true)
      return
    }
    displayStartMs = performance.now()
    displayFrame = schedule(tickDisplay)
    notify(true)
  }

  const syncDisplay = (pos: number) => {
    stopDisplay()
    displayPos = pos
    displayFrom = pos
    displayTo = pos
  }

  /**
   * Advance velocity-mode motion. Positioning snaps on write — rAF is starved
   * under qemu-wasm, so guest SPI polls must be enough for correctness.
   */
  const advanceVelocity = (now = performance.now()) => {
    const mode = readRaw(REG_RAMPMODE) & 0x3
    if (mode !== RAMPMODE_POS_VELOCITY && mode !== RAMPMODE_NEG_VELOCITY) {
      stopAnim()
      return false
    }
    const vmax = readRaw(REG_VMAX)
    const speed = vmaxToUstepsPerSec(vmax, clockHz)
    if (speed === 0) {
      setMoving(false, 0)
      stopAnim()
      return false
    }
    const dt = Math.min(0.25, Math.max(0, (now - lastTickMs) / 1000))
    lastTickMs = now
    const dir = mode === RAMPMODE_POS_VELOCITY ? 1 : -1
    const pos = asSigned32(readRaw(REG_XACTUAL)) + dir * Math.max(1, Math.round(speed * dt))
    writeRaw(REG_XACTUAL, asU32(pos))
    syncDisplay(pos)
    setMoving(true, dir * (vmax & 0x7fffff))
    clearPositionReached()
    return true
  }

  const tickVelocity = (now: number) => {
    animFrame = undefined
    if (!advanceVelocity(now)) {
      notify(true)
      return
    }
    notify()
    animFrame = schedule(tickVelocity)
  }

  const startVelocity = () => {
    stopAnim()
    stopDisplay()
    lastTickMs = performance.now()
    advanceVelocity(lastTickMs)
    animFrame = schedule(tickVelocity)
  }

  /** Positioning: registers arrive immediately; dial eases for moving color. */
  const completePositioning = () => {
    stopAnim()
    const target = asSigned32(readRaw(REG_XTARGET))
    writeRaw(REG_XACTUAL, asU32(target))
    markPositionReached()
    startDisplayMove(target)
  }

  const onRegisterWrite = (addr: number, value: number) => {
    const a = addr & ADDRESS_MASK
    const v = asU32(value)

    if (a === REG_GSTAT) {
      writeRaw(a, readRaw(a) & ~v)
      notify(true)
      return
    }

    writeRaw(a, v)

    if (a === REG_XACTUAL) {
      stopAnim()
      writeRaw(REG_VACTUAL, 0)
      setMoving(false, 0)
      syncDisplay(asSigned32(v))
      notify(true)
      return
    }

    if (a === REG_XTARGET || a === REG_RAMPMODE || a === REG_VMAX) {
      const mode = readRaw(REG_RAMPMODE) & 0x3
      if (mode === RAMPMODE_HOLD) {
        stopAnim()
        stopDisplay()
        setMoving(false, 0)
        syncDisplay(asSigned32(readRaw(REG_XACTUAL)))
        notify(true)
        return
      }
      if (mode === RAMPMODE_POSITIONING) {
        // Only arrive on XTARGET (Zephyr writes RAMPMODE then XTARGET). Completing
        // on the mode write would fire POS_REACHED against a stale target.
        if (a === REG_XTARGET) {
          completePositioning()
        } else {
          const pos = asSigned32(readRaw(REG_XACTUAL))
          const target = asSigned32(readRaw(REG_XTARGET))
          if (pos === target) completePositioning()
          else clearPositionReached()
        }
        notify(true)
        return
      }
      if (mode === RAMPMODE_POS_VELOCITY || mode === RAMPMODE_NEG_VELOCITY) {
        clearPositionReached()
        startVelocity()
        notify(true)
        return
      }
    }

    notify(true)
  }

  const peekLive = (addr: number): number => readRaw(addr & ADDRESS_MASK)

  const readAndSideEffect = (addr: number): number => {
    const a = addr & ADDRESS_MASK
    // Velocity runs must progress even when rAF is starved by the emulator.
    if (
      a === REG_RAMPSTAT ||
      a === REG_XACTUAL ||
      a === REG_VACTUAL ||
      a === REG_DRVSTATUS
    ) {
      if (advanceVelocity()) notify()
    }
    const value = peekLive(a)
    if (a === REG_RAMPSTAT) {
      writeRaw(a, value & ~RAMPSTAT_EVENT_CLEAR)
    }
    if (a === REG_GSTAT) {
      writeRaw(a, 0)
    }
    return value
  }

  const packRx = (rx: Uint8Array, status: number, data: number) => {
    rx[0] = status & 0xff
    const word = asU32(data)
    rx[1] = (word >>> 24) & 0xff
    rx[2] = (word >>> 16) & 0xff
    rx[3] = (word >>> 8) & 0xff
    rx[4] = word & 0xff
  }

  const transfer = (tx: Uint8Array, rx: Uint8Array, _opts: SpiTransferOpts): boolean => {
    if (tx.length < DATAGRAM || rx.length < DATAGRAM) return false

    const cmd = tx[0]!
    const addr = cmd & ADDRESS_MASK
    const isWrite = (cmd & WRITE_BIT) !== 0
    const data =
      ((tx[1]! << 24) | (tx[2]! << 16) | (tx[3]! << 8) | tx[4]!) >>> 0

    const status = 0

    if (isWrite) {
      const reply = latchValid ? readAndSideEffect(latchAddr) : 0
      packRx(rx, status, reply)
      pointer = addr
      onRegisterWrite(addr, data)
      latchAddr = addr
      latchValid = true
      return true
    }

    const reply = latchValid ? readAndSideEffect(latchAddr) : 0
    packRx(rx, status, reply)
    pointer = addr
    latchAddr = addr
    latchValid = true
    return true
  }

  return {
    cs,
    name,
    address: cs,
    registers: TMC50XX_REGISTERS,
    motorCount: 1,
    transfer,
    peek(addr) {
      return peekLive(addr)
    },
    getPointer() {
      return pointer
    },
    poke(addr, value) {
      const decl = byAddr.get(addr & ADDRESS_MASK)
      if (decl && decl.access === 'ro') return
      onRegisterWrite(addr, value)
    },
    setField(addr, field, value) {
      const decl = byAddr.get(addr & ADDRESS_MASK)
      if (decl && decl.access === 'ro') return
      onRegisterWrite(addr, insertField(peekLive(addr), field, value))
    },
    getMotor(index = 0) {
      if (index !== 0) {
        return {
          position: 0,
          target: 0,
          velocity: 0,
          rampMode: RAMPMODE_HOLD,
          moving: false,
          enabled: false,
          stepsPerSec: 0,
          directionPositive: true,
        }
      }
      const regPos = asSigned32(readRaw(REG_XACTUAL))
      const target = asSigned32(readRaw(REG_XTARGET))
      const velocity = asSigned32(readRaw(REG_VACTUAL))
      const rampMode = readRaw(REG_RAMPMODE) & 0x3
      const stst = (readRaw(REG_DRVSTATUS) & DRVSTATUS_STST) !== 0
      const easing = displayMoving()
      const position = easing ? Math.round(displayPos) : regPos
      const moving = easing || !stst
      const vmax = readRaw(REG_VMAX)
      const stepsPerSec = easing
        ? Math.abs(displayTo - displayFrom) / (DISPLAY_MOVE_MS / 1000)
        : moving
          ? vmaxToUstepsPerSec(vmax, clockHz)
          : 0
      return {
        position,
        target,
        velocity,
        rampMode,
        moving,
        enabled: driverEnabled(),
        stepsPerSec,
        directionPositive:
          rampMode === RAMPMODE_NEG_VELOCITY
            ? false
            : rampMode === RAMPMODE_POS_VELOCITY
              ? true
              : displayTo !== displayFrom
                ? displayTo > displayFrom
                : target >= regPos,
      }
    },
    version: () => generation,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export const tmc50xxMeta = {
  REG_GCONF,
  REG_GSTAT,
  REG_RAMPMODE,
  REG_XACTUAL,
  REG_VACTUAL,
  REG_VMAX,
  REG_XTARGET,
  REG_SWMODE,
  REG_RAMPSTAT,
  REG_CHOPCONF,
  REG_DRVSTATUS,
  RAMPMODE_POSITIONING,
  RAMPMODE_POS_VELOCITY,
  RAMPMODE_NEG_VELOCITY,
  RAMPMODE_HOLD,
  RAMPSTAT_POS_REACHED,
  RAMPSTAT_POS_REACHED_EVENT,
  DRVSTATUS_STST,
  WRITE_BIT,
  ADDRESS_MASK,
}
