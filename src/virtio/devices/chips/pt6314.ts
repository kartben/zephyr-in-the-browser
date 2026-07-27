/**
 * Princeton PT6314 Dot Character VFD Controller — page-side SPI model.
 *
 * Matches Zephyr's `drivers/auxdisplay/auxdisplay_pt6314.c` and the datasheet
 * serial interface (Newhaven app note PT6314.pdf): each SPI write is a 2-byte
 * frame — start byte (sync 0xF8 | R/W | RS) then Instruction or Data. Commands
 * are HD44780-like; Function Set BR1:BR0 set VFD brightness (100/75/50/25%).
 *
 * Stock packaging uses a Futaba-style 20×2 viewport (`samples/drivers/auxdisplay`
 * with `-S pt6314-only`). Internal DDRAM is still 40×2; only `columns`×`rows`
 * are visible.
 */

import type { SpiChip, SpiTransferOpts } from '../spi'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import pt6314Map from './maps/pt6314.json'

/* Serial start-byte fields — same as Zephyr auxdisplay_pt6314.c. */
const SB_SYNC = 0xf8
const SB_RS_DATA = 1 << 1
const SB_RW_READ = 1 << 2

const CMD_CLEAR = 0x01
const CMD_HOME = 0x02
const CMD_ENTRY = 0x04
const CMD_DISPLAY = 0x08
const CMD_SHIFT = 0x10
const CMD_FUNCTION = 0x20
const CMD_CGRAM = 0x40
const CMD_DDRAM = 0x80

const DS_DISPLAY_ON = 1 << 2
const DS_CURSOR_ON = 1 << 1
const DS_BLINK_ON = 1 << 0

const REG_IR = 0x00
const REG_ENTRY = 0x04
const REG_DISPLAY = 0x08
const REG_FUNCTION = 0x20
const REG_DR = 0x40
const REG_START = 0xf8
const REG_DDRAM_AC = 0x81

/** Line bases for 2-line DDRAM (datasheet §5.2.3 / §6.8). */
const LINE0_BASE = 0x00
const LINE1_BASE = 0x40
const LINE_CHARS = 40

const PT6314_REGISTERS = registersFromJson(pt6314Map as RegisterMapJson)

export interface Pt6314ControllerState {
  on: boolean
  cursor: boolean
  blinking: boolean
  cursorColumn: number
  cursorRow: number
  entryIncrement: boolean
}

export interface Pt6314Options {
  cs?: number
  name?: string
  /** Visible columns — Zephyr DT enum 16 | 20 | 24. */
  columns?: number
  /** Visible rows — Zephyr DT enum 1 | 2. */
  rows?: number
}

export interface Pt6314Chip extends SpiChip {
  /** Chip-select, also used as {@link RegisterMapSource.address}. */
  readonly address: number
  readonly addressKind: 'spi-cs'
  readonly columns: number
  readonly rows: number
  /** Row-major visible cells; space = empty. */
  readonly cells: Uint8Array
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  isOn(): boolean
  /** Datasheet / Zephyr brightness level 1–4 (25% … 100%). */
  getBrightness(): number
  getControllerState(): Pt6314ControllerState
  version(): number
  subscribe(fn: () => void): () => void
}

export function isPt6314(chip: unknown): chip is Pt6314Chip {
  const c = chip as Pt6314Chip | null | undefined
  return (
    !!c &&
    typeof c.columns === 'number' &&
    typeof c.rows === 'number' &&
    c.cells instanceof Uint8Array &&
    typeof c.getBrightness === 'function' &&
    typeof c.getControllerState === 'function' &&
    Array.isArray(c.registers) &&
    typeof c.transfer === 'function'
  )
}

function clampColumns(n: number): number {
  if (n === 16 || n === 20 || n === 24) return n
  return 20
}

function clampRows(n: number): number {
  return n === 1 ? 1 : 2
}

/** Map Function Set BR1:BR0 → Zephyr brightness 1–4. */
function brightnessFromBr(br: number): number {
  switch (br & 0x03) {
    case 0:
      return 4 // 100%
    case 1:
      return 3 // 75%
    case 2:
      return 2 // 50%
    default:
      return 1 // 25%
  }
}

/** Zephyr `PT6314_FS_BRIGHTNESS(BR)` → BR1:BR0 field. */
function brFromBrightness(level: number): number {
  const br = Math.min(4, Math.max(1, level | 0))
  return (4 - (br & 0x03)) & 0x03
}

export function createPt6314({
  cs = 0,
  name = 'PT6314 VFD',
  columns: columnsOpt = 20,
  rows: rowsOpt = 2,
}: Pt6314Options = {}): Pt6314Chip {
  const columns = clampColumns(columnsOpt)
  const rows = clampRows(rowsOpt)
  const cells = new Uint8Array(columns * rows).fill(0x20)
  /** Full DDRAM — 80 locations; only line ranges are meaningful. */
  const ddramMem = new Uint8Array(0x80).fill(0x20)

  const listeners = new Set<() => void>()
  const byAddr = new Map(PT6314_REGISTERS.map((r) => [r.addr, r]))

  // Datasheet §6.12 power-on: display off, entry I/D=1 S=0, function 0x38.
  let on = false
  let cursorOn = false
  let blinking = false
  let entryIncrement = true
  let displayShift = false
  let functionSet = CMD_FUNCTION | (1 << 4) | (1 << 3) // DL=1, N=1, BR=00
  let ddram = 0
  let lastIr = 0
  let lastDr = 0x20
  let lastStart = SB_SYNC
  let pointer = REG_IR
  let generation = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const syncCells = () => {
    for (let row = 0; row < rows; row++) {
      const base = row === 0 ? LINE0_BASE : LINE1_BASE
      for (let col = 0; col < columns; col++) {
        cells[row * columns + col] = ddramMem[base + col] ?? 0x20
      }
    }
  }

  const entryModeWord = () =>
    CMD_ENTRY | (entryIncrement ? 0x02 : 0) | (displayShift ? 0x01 : 0)

  const displayControlWord = () =>
    CMD_DISPLAY |
    (on ? DS_DISPLAY_ON : 0) |
    (cursorOn ? DS_CURSOR_ON : 0) |
    (blinking ? DS_BLINK_ON : 0)

  const cursorFromDdram = (): { column: number; row: number } => {
    if (rows >= 2 && ddram >= LINE1_BASE && ddram < LINE1_BASE + LINE_CHARS) {
      return { column: Math.min(ddram - LINE1_BASE, columns - 1), row: 1 }
    }
    if (ddram >= LINE0_BASE && ddram < LINE0_BASE + LINE_CHARS) {
      return { column: Math.min(ddram - LINE0_BASE, columns - 1), row: 0 }
    }
    return { column: 0, row: 0 }
  }

  const advanceCursor = () => {
    if (entryIncrement) {
      ddram = (ddram + 1) & 0x7f
      // Wrap within the active line's 40-char range when past the end.
      if (rows >= 2 && ddram >= LINE1_BASE && ddram >= LINE1_BASE + LINE_CHARS) {
        ddram = LINE1_BASE
      } else if (ddram < LINE1_BASE && ddram >= LINE0_BASE + LINE_CHARS) {
        ddram = rows >= 2 ? LINE1_BASE : LINE0_BASE
      }
    } else {
      ddram = (ddram - 1) & 0x7f
    }
  }

  const clear = () => {
    ddramMem.fill(0x20)
    syncCells()
    ddram = 0
  }

  const runCommand = (cmd: number) => {
    lastIr = cmd & 0xff

    if (cmd === CMD_CLEAR) {
      clear()
      notify()
      return
    }
    if ((cmd & 0xfe) === CMD_HOME) {
      ddram = 0
      notify()
      return
    }
    if ((cmd & 0xfc) === CMD_ENTRY) {
      entryIncrement = (cmd & 0x02) !== 0
      displayShift = (cmd & 0x01) !== 0
      notify()
      return
    }
    if ((cmd & 0xf8) === CMD_DISPLAY) {
      on = (cmd & DS_DISPLAY_ON) !== 0
      cursorOn = (cmd & DS_CURSOR_ON) !== 0
      blinking = (cmd & DS_BLINK_ON) !== 0
      notify()
      return
    }
    if ((cmd & 0xf0) === CMD_SHIFT) {
      // Cursor / display shift — update AC for cursor-only moves.
      const displayMove = (cmd & 0x08) !== 0
      const right = (cmd & 0x04) !== 0
      if (!displayMove) {
        ddram = right ? (ddram + 1) & 0x7f : (ddram - 1) & 0x7f
      }
      notify()
      return
    }
    if ((cmd & 0xe0) === CMD_FUNCTION) {
      functionSet = cmd & 0xff
      notify()
      return
    }
    if ((cmd & 0xc0) === CMD_CGRAM) {
      // CGRAM address set — stock sample does not use custom chars.
      notify()
      return
    }
    if ((cmd & 0x80) === CMD_DDRAM) {
      ddram = cmd & 0x7f
      notify()
    }
  }

  const writeData = (value: number) => {
    lastDr = value & 0xff
    if (ddram < ddramMem.length) {
      ddramMem[ddram] = lastDr
      // Mirror into the visible viewport when the AC is in range.
      if (ddram >= LINE0_BASE && ddram < LINE0_BASE + columns) {
        cells[ddram - LINE0_BASE] = lastDr
      } else if (
        rows >= 2 &&
        ddram >= LINE1_BASE &&
        ddram < LINE1_BASE + columns
      ) {
        cells[columns + (ddram - LINE1_BASE)] = lastDr
      }
    }
    advanceCursor()
    notify()
  }

  const acceptFrame = (start: number, value: number) => {
    lastStart = start & 0xff
    pointer = lastStart
    // Reads are not used by the Zephyr driver; ignore.
    if ((start & SB_RW_READ) !== 0) return
    if ((start & SB_SYNC) !== SB_SYNC) return
    if ((start & SB_RS_DATA) !== 0) {
      writeData(value)
      return
    }
    runCommand(value)
  }

  const peek = (addr: number): number => {
    switch (addr) {
      case REG_START:
        return lastStart
      case REG_IR:
        return lastIr
      case REG_DR:
        return lastDr
      case REG_ENTRY:
        return entryModeWord()
      case REG_DISPLAY:
        return displayControlWord()
      case REG_FUNCTION:
        return functionSet
      case REG_DDRAM_AC:
        return CMD_DDRAM | (ddram & 0x7f)
      default:
        return 0
    }
  }

  const poke = (addr: number, value: number) => {
    const reg = byAddr.get(addr)
    if (!reg || reg.access === 'ro') return
    const v = value & 0xff
    switch (addr) {
      case REG_START:
        lastStart = v
        pointer = REG_START
        notify()
        return
      case REG_IR:
        acceptFrame(SB_SYNC, v)
        return
      case REG_DR:
        acceptFrame(SB_SYNC | SB_RS_DATA, v)
        return
      case REG_ENTRY:
        runCommand(CMD_ENTRY | (v & 0x03))
        return
      case REG_DISPLAY:
        runCommand(CMD_DISPLAY | (v & 0x07))
        return
      case REG_FUNCTION: {
        const dlN = v & 0x18
        const br = v & 0x03
        runCommand(CMD_FUNCTION | dlN | br)
        return
      }
      case REG_DDRAM_AC:
        runCommand(CMD_DDRAM | (v & 0x7f))
        return
      default:
        return
    }
  }

  return {
    cs,
    address: cs,
    addressKind: 'spi-cs',
    name,
    columns,
    rows,
    cells,
    registers: PT6314_REGISTERS,
    peek,
    getPointer: () => pointer,
    poke,
    setField(addr, field, value) {
      const reg = byAddr.get(addr)
      if (!reg || reg.access === 'ro') return
      poke(addr, insertField(peek(addr), field, value))
    },
    isOn: () => on,
    getBrightness: () => brightnessFromBr(functionSet),
    getControllerState: () => {
      const { column, row } = cursorFromDdram()
      return {
        on,
        cursor: cursorOn,
        blinking,
        cursorColumn: column,
        cursorRow: row,
        entryIncrement,
      }
    },
    version: () => generation,
    transfer(tx: Uint8Array, _rx: Uint8Array, _opts: SpiTransferOpts) {
      // Driver writes exactly 2 bytes per frame; accept multiples of 2 as well.
      if (tx.length < 2) return false
      for (let i = 0; i + 1 < tx.length; i += 2) {
        acceptFrame(tx[i]!, tx[i + 1]!)
      }
      return true
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

export const pt6314Meta = {
  SB_SYNC,
  SB_RS_DATA,
  SB_RW_READ,
  CMD_CLEAR,
  CMD_HOME,
  CMD_ENTRY,
  CMD_DISPLAY,
  CMD_FUNCTION,
  CMD_DDRAM,
  REG_IR,
  REG_DR,
  REG_ENTRY,
  REG_DISPLAY,
  REG_FUNCTION,
  REG_START,
  REG_DDRAM_AC,
  brightnessFromBr,
  brFromBrightness,
}
