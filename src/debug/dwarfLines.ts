/**
 * The DWARF line-number program, run to a table of `address ↔ file:line`.
 *
 * This is what lets a tour say `at: main.c:31` about a build nobody prepared
 * for it. Zephyr compiles with debug info by default, so the mapping is already
 * in the ELF the page fetches to boot the guest — the same one thread info and
 * function symbols come from. Nothing is added to the firmware and nothing is
 * generated at build time; the address of a source line is simply *looked up*.
 *
 * Handles DWARF 2 through 5, which covers every toolchain Zephyr ships with.
 * `.debug_line` is a bytecode, not a table: each unit runs a little state
 * machine whose `copy`/special opcodes emit rows. Everything here is
 * best-effort — a unit using a form this reader does not know is skipped rather
 * than poisoning the whole index, because losing one translation unit costs one
 * tour step and bailing out entirely costs the feature.
 */

import { findSection } from '@/debug/elfSections'

/** `is_stmt`: a place a debugger may sensibly stop. */
export const ROW_IS_STMT = 1
/** `prologue_end`: where a function's arguments are actually live. */
export const ROW_PROLOGUE_END = 2
/** `end_sequence`: one past the last byte of a range; carries no location. */
export const ROW_END_SEQUENCE = 4

export interface LineIndex {
  /** Row addresses, ascending. */
  addrs: Float64Array
  lines: Int32Array
  /** Index into {@link files}. */
  fileIds: Int32Array
  /** ROW_* bits. */
  flags: Uint8Array
  /** File paths as the compiler recorded them. */
  files: string[]
  /** Lowercase basenames of {@link files}, for anchor matching. */
  baseNames: string[]
}

export interface SourceLocation {
  /** Path as recorded in the line table. */
  file: string
  line: number
}

/**
 * Cap on rows kept. A Zephyr image with full debug info runs to tens of
 * thousands; a corrupt unit could claim far more, and this page has a terminal
 * to keep responsive.
 */
const MAX_ROWS = 500_000

class Reader {
  at = 0

  constructor(readonly data: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.data.length
  }

  u8(): number {
    return this.data[this.at++] ?? 0
  }

  u16(): number {
    return this.u8() | (this.u8() << 8)
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }

  u64(): number {
    const lo = this.u32()
    return lo + this.u32() * 0x1_0000_0000
  }

  uleb(): number {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = this.u8()
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
      shift += 7
      if (shift > 63) return value
    }
  }

  sleb(): number {
    let value = 0
    let shift = 0
    let byte = 0
    do {
      byte = this.u8()
      value += (byte & 0x7f) * 2 ** shift
      shift += 7
    } while (byte & 0x80 && shift <= 63)
    if (byte & 0x40 && shift <= 63) value -= 2 ** shift
    return value
  }

  cstring(): string {
    const start = this.at
    while (this.at < this.data.length && this.data[this.at] !== 0) this.at++
    const text = new TextDecoder().decode(this.data.subarray(start, this.at))
    this.at++
    return text
  }

  skip(n: number): void {
    this.at += n
  }
}

function stringAt(section: Uint8Array | null, offset: number): string {
  if (!section || offset >= section.length) return ''
  let end = offset
  while (end < section.length && section[end] !== 0) end++
  return new TextDecoder().decode(section.subarray(offset, end))
}

/* DW_FORM_* values used by the v5 directory / file entry formats. */
const FORM_BLOCK = 0x09
const FORM_BLOCK1 = 0x0a
const FORM_DATA1 = 0x0b
const FORM_DATA2 = 0x05
const FORM_DATA4 = 0x06
const FORM_DATA8 = 0x07
const FORM_DATA16 = 0x1e
const FORM_STRING = 0x08
const FORM_STRP = 0x0e
const FORM_LINE_STRP = 0x1f
const FORM_UDATA = 0x0f

interface StrSections {
  str: Uint8Array | null
  lineStr: Uint8Array | null
}

/**
 * Read one attribute of a v5 entry format. Returns a string for path forms and
 * a number for the rest; `undefined` means "form not understood", which drops
 * the unit.
 */
function readFormValue(
  r: Reader,
  form: number,
  dwarf64: boolean,
  strs: StrSections,
): string | number | undefined {
  switch (form) {
    case FORM_STRING:
      return r.cstring()
    case FORM_STRP:
      return stringAt(strs.str, dwarf64 ? r.u64() : r.u32())
    case FORM_LINE_STRP:
      return stringAt(strs.lineStr, dwarf64 ? r.u64() : r.u32())
    case FORM_UDATA:
      return r.uleb()
    case FORM_DATA1:
      return r.u8()
    case FORM_DATA2:
      return r.u16()
    case FORM_DATA4:
      return r.u32()
    case FORM_DATA8:
      return r.u64()
    case FORM_DATA16:
      r.skip(16)
      return 0
    case FORM_BLOCK1:
      r.skip(r.u8())
      return 0
    case FORM_BLOCK:
      r.skip(r.uleb())
      return 0
    default:
      return undefined
  }
}

/** DW_LNCT_path */
const LNCT_PATH = 1
/** DW_LNCT_directory_index */
const LNCT_DIRECTORY_INDEX = 2

function joinPath(dir: string, name: string): string {
  if (name.startsWith('/') || dir === '') return name
  return `${dir.replace(/\/$/, '')}/${name}`
}

interface Rows {
  addrs: number[]
  lines: number[]
  fileIds: number[]
  flags: number[]
}

/**
 * Run one unit's program, appending rows.
 *
 * `unitEnd` comes back even when the unit could not be read, so the caller can
 * skip to the next one: a single translation unit using a form this reader does
 * not know should cost that unit's lines, not every unit after it.
 */
function runUnit(
  r: Reader,
  end: number,
  strs: StrSections,
  files: string[],
  rows: Rows,
): { ok: boolean; unitEnd: number } {
  const first = r.u32()
  const dwarf64 = first === 0xffffffff
  const unitEnd = dwarf64 ? r.u64() + r.at : first + r.at
  if (unitEnd > end || unitEnd <= r.at) return { ok: false, unitEnd: end }

  const version = r.u16()
  if (version < 2 || version > 5) return { ok: true, unitEnd }
  if (version >= 5) {
    r.u8() // address_size
    r.u8() // segment_selector_size
  }
  const headerLength = dwarf64 ? r.u64() : r.u32()
  const programStart = r.at + headerLength
  const minInstLength = r.u8()
  const maxOpsPerInst = version >= 4 ? r.u8() : 1
  const defaultIsStmt = r.u8() !== 0
  const lineBase = (r.u8() << 24) >> 24 // signed
  const lineRange = r.u8()
  const opcodeBase = r.u8()
  const stdLengths: number[] = []
  for (let i = 1; i < opcodeBase; i++) stdLengths.push(r.u8())

  /** Unit-local file number → index into the shared `files` array. */
  const fileMap: number[] = []
  const intern = (path: string): number => {
    const found = files.indexOf(path)
    if (found >= 0) return found
    files.push(path)
    return files.length - 1
  }

  if (version <= 4) {
    const dirs = ['']
    for (;;) {
      const dir = r.cstring()
      if (dir === '') break
      dirs.push(dir)
    }
    // DWARF ≤4 numbers files from 1; slot 0 is the compilation unit's own name,
    // which the header does not repeat. Reserve it so indices line up.
    fileMap.push(-1)
    for (;;) {
      const name = r.cstring()
      if (name === '') break
      const dirIndex = r.uleb()
      r.uleb() // mtime
      r.uleb() // length
      fileMap.push(intern(joinPath(dirs[dirIndex] ?? '', name)))
    }
  } else {
    const dirFormatCount = r.u8()
    const dirFormats: Array<[number, number]> = []
    for (let i = 0; i < dirFormatCount; i++) dirFormats.push([r.uleb(), r.uleb()])
    const dirCount = r.uleb()
    const dirs: string[] = []
    for (let i = 0; i < dirCount; i++) {
      let path = ''
      for (const [type, form] of dirFormats) {
        const value = readFormValue(r, form, dwarf64, strs)
        if (value === undefined) return { ok: false, unitEnd }
        if (type === LNCT_PATH && typeof value === 'string') path = value
      }
      dirs.push(path)
    }

    const fileFormatCount = r.u8()
    const fileFormats: Array<[number, number]> = []
    for (let i = 0; i < fileFormatCount; i++) fileFormats.push([r.uleb(), r.uleb()])
    const fileCount = r.uleb()
    for (let i = 0; i < fileCount; i++) {
      let name = ''
      let dirIndex = 0
      for (const [type, form] of fileFormats) {
        const value = readFormValue(r, form, dwarf64, strs)
        if (value === undefined) return { ok: false, unitEnd }
        if (type === LNCT_PATH && typeof value === 'string') name = value
        if (type === LNCT_DIRECTORY_INDEX && typeof value === 'number') dirIndex = value
      }
      fileMap.push(intern(joinPath(dirs[dirIndex] ?? '', name)))
    }
  }

  // The header may carry vendor padding; the program starts where it said.
  r.at = programStart
  if (r.at < 0 || r.at > unitEnd) return { ok: false, unitEnd }

  let address = 0
  let opIndex = 0
  let file = 1
  let line = 1
  let isStmt = defaultIsStmt
  let prologueEnd = false

  const emit = (endSequence: boolean) => {
    if (rows.addrs.length >= MAX_ROWS) return
    const id = fileMap[file] ?? -1
    rows.addrs.push(address)
    rows.lines.push(line)
    rows.fileIds.push(id)
    rows.flags.push(
      (isStmt ? ROW_IS_STMT : 0) |
        (prologueEnd ? ROW_PROLOGUE_END : 0) |
        (endSequence ? ROW_END_SEQUENCE : 0),
    )
    prologueEnd = false
  }

  const advance = (operationAdvance: number) => {
    if (maxOpsPerInst <= 1) {
      address += minInstLength * operationAdvance
      return
    }
    address += minInstLength * Math.floor((opIndex + operationAdvance) / maxOpsPerInst)
    opIndex = (opIndex + operationAdvance) % maxOpsPerInst
  }

  while (r.at < unitEnd) {
    const opcode = r.u8()
    if (opcode >= opcodeBase) {
      const adjusted = opcode - opcodeBase
      advance(Math.floor(adjusted / lineRange))
      line += lineBase + (adjusted % lineRange)
      emit(false)
      continue
    }
    if (opcode === 0) {
      // Extended opcode.
      const length = r.uleb()
      const next = r.at + length
      const sub = r.u8()
      if (sub === 0x01) {
        // DW_LNE_end_sequence
        emit(true)
        address = 0
        opIndex = 0
        file = 1
        line = 1
        isStmt = defaultIsStmt
      } else if (sub === 0x02) {
        // DW_LNE_set_address — width comes from the remaining operand bytes.
        const width = next - r.at
        address = width === 8 ? r.u64() : width === 4 ? r.u32() : 0
      }
      r.at = next
      continue
    }
    switch (opcode) {
      case 0x01: // copy
        emit(false)
        break
      case 0x02: // advance_pc
        advance(r.uleb())
        break
      case 0x03: // advance_line
        line += r.sleb()
        break
      case 0x04: // set_file
        file = r.uleb()
        break
      case 0x05: // set_column
        r.uleb()
        break
      case 0x06: // negate_stmt
        isStmt = !isStmt
        break
      case 0x07: // basic_block
        break
      case 0x08: // const_add_pc
        advance(Math.floor((255 - opcodeBase) / lineRange))
        break
      case 0x09: // fixed_advance_pc
        address += r.u16()
        opIndex = 0
        break
      case 0x0a: // set_prologue_end
        prologueEnd = true
        break
      case 0x0b: // set_epilogue_begin
        break
      case 0x0c: // set_isa
        r.uleb()
        break
      default: {
        // Vendor opcode: its operand count is in the header.
        const operands = stdLengths[opcode - 1] ?? 0
        for (let i = 0; i < operands; i++) r.uleb()
        break
      }
    }
  }

  return { ok: true, unitEnd }
}

/**
 * Build the address ↔ source index for an ELF, or null when it carries no
 * `.debug_line` (a stripped image, or a user-dropped binary).
 */
export function buildLineIndex(elf: Uint8Array): LineIndex | null {
  const section = findSection(elf, '.debug_line')
  if (!section || section.size === 0) return null
  const strs: StrSections = {
    str: sectionBytes(elf, '.debug_str'),
    lineStr: sectionBytes(elf, '.debug_line_str'),
  }

  const data = elf.subarray(section.offset, section.offset + section.size)
  const r = new Reader(data)
  const files: string[] = []
  const rows: Rows = { addrs: [], lines: [], fileIds: [], flags: [] }

  while (!r.done && rows.addrs.length < MAX_ROWS) {
    const start = r.at
    let unitEnd = data.length
    try {
      unitEnd = runUnit(r, data.length, strs, files, rows).unitEnd
    } catch {
      // A malformed unit costs its own lines; the next one may be fine.
    }
    // No forward progress means the rest is unreadable; keep what was
    // collected rather than looping on it.
    if (unitEnd <= start) break
    r.at = unitEnd
  }
  if (rows.addrs.length === 0) return null

  const order = rows.addrs.map((_, i) => i).sort((a, b) => rows.addrs[a]! - rows.addrs[b]!)
  const index: LineIndex = {
    addrs: new Float64Array(order.length),
    lines: new Int32Array(order.length),
    fileIds: new Int32Array(order.length),
    flags: new Uint8Array(order.length),
    files,
    baseNames: files.map((f) => f.slice(f.lastIndexOf('/') + 1).toLowerCase()),
  }
  order.forEach((from, to) => {
    index.addrs[to] = rows.addrs[from]!
    index.lines[to] = rows.lines[from]!
    index.fileIds[to] = rows.fileIds[from]!
    index.flags[to] = rows.flags[from]!
  })
  return index
}

function sectionBytes(elf: Uint8Array, name: string): Uint8Array | null {
  const section = findSection(elf, name)
  if (!section) return null
  return elf.subarray(section.offset, section.offset + section.size)
}

/** File ids whose basename matches `name` (`main.c`, or a longer suffix). */
function matchingFiles(index: LineIndex, name: string): Set<number> {
  const want = name.toLowerCase()
  const ids = new Set<number>()
  for (let i = 0; i < index.files.length; i++) {
    if (index.baseNames[i] === want) ids.add(i)
  }
  if (ids.size > 0) return ids
  // Fall back to a path suffix, so `drivers/gpio/gpio_emul.c` can disambiguate
  // between two files both called gpio_emul.c.
  for (let i = 0; i < index.files.length; i++) {
    if (index.files[i]!.toLowerCase().endsWith(`/${want}`)) ids.add(i)
  }
  return ids
}

export interface LineMatch {
  addr: number
  /** The line actually landed on — `-Os` folds lines away, so it can differ. */
  line: number
  file: string
}

/**
 * Lowest address whose row is at or after `file:line`.
 *
 * "At or after" is what gdb does with `break file:42` and it is what a tour
 * needs: an optimised build has no code for a comment, a declaration or a
 * folded branch, and the step should land on the next real statement rather
 * than fail. The line it landed on comes back so the card can highlight the
 * truth instead of the request.
 */
export function addressForLine(index: LineIndex, file: string, line: number): LineMatch | null {
  const ids = matchingFiles(index, file)
  if (ids.size === 0) return null

  let best: LineMatch | null = null
  for (let i = 0; i < index.addrs.length; i++) {
    if (index.flags[i]! & ROW_END_SEQUENCE) continue
    if (!(index.flags[i]! & ROW_IS_STMT)) continue
    if (!ids.has(index.fileIds[i]!)) continue
    const rowLine = index.lines[i]!
    if (rowLine < line) continue
    // Prefer the closest line; among equal lines, the lowest address (which is
    // where control reaches the statement first).
    if (best === null || rowLine < best.line || (rowLine === best.line && index.addrs[i]! < best.addr)) {
      best = { addr: index.addrs[i]!, line: rowLine, file: index.files[index.fileIds[i]!] ?? file }
    }
  }
  return best
}

/** The source location a stop address belongs to. */
export function locationForAddress(index: LineIndex, addr: number): SourceLocation | null {
  let lo = 0
  let hi = index.addrs.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (index.addrs[mid]! <= addr) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  // Walk back over rows sharing the address; the last one wins in DWARF order,
  // but end_sequence rows describe nothing.
  while (found >= 0 && index.flags[found]! & ROW_END_SEQUENCE) found--
  if (found < 0) return null
  const file = index.files[index.fileIds[found]!]
  if (!file) return null
  return { file, line: index.lines[found]! }
}

/**
 * Where a function's body really starts.
 *
 * Breaking on a symbol's first byte stops before the prologue has run, so
 * arguments are still in flight and a `watch:` on one reads garbage. DWARF
 * marks the spot; when the compiler did not, the second row inside the
 * function is the traditional fallback.
 */
export function bodyStart(index: LineIndex, low: number, high: number): number | null {
  let firstInside = -1
  for (let i = 0; i < index.addrs.length; i++) {
    const addr = index.addrs[i]!
    if (addr < low) continue
    if (addr >= high) break
    if (index.flags[i]! & ROW_END_SEQUENCE) continue
    if (index.flags[i]! & ROW_PROLOGUE_END) return addr
    if (firstInside < 0) firstInside = i
    else if (index.addrs[i]! > low) return addr
  }
  return firstInside >= 0 ? index.addrs[firstInside]! : null
}
