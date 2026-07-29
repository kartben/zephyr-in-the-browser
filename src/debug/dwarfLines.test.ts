import { describe, expect, it } from 'vitest'
import {
  addressForLine,
  bodyStart,
  buildLineIndex,
  locationForAddress,
  ROW_PROLOGUE_END,
} from '@/debug/dwarfLines'

/* ------------------------------------------------------------------ *
 * A hand-built ELF carrying one DWARF 4 line program.
 *
 * Small enough to reason about byte by byte, which is the only way to be sure
 * a bytecode interpreter is running the program rather than something that
 * happens to agree with it on one real image.
 * ------------------------------------------------------------------ */

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

function uleb(value: number): number[] {
  const out: number[] = []
  let rest = value
  do {
    let byte = rest & 0x7f
    rest >>>= 7
    if (rest !== 0) byte |= 0x80
    out.push(byte)
  } while (rest !== 0)
  return out
}

function sleb(value: number): number[] {
  const out: number[] = []
  let rest = value
  for (;;) {
    const byte = rest & 0x7f
    rest >>= 7
    const signBit = (byte & 0x40) !== 0
    if ((rest === 0 && !signBit) || (rest === -1 && signBit)) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0))
}

/** DWARF 4 program: main.c, three statement rows from 0x1000. */
function lineProgram(): Uint8Array {
  const header = [
    ...[4, 0], // version 4
  ]
  const afterHeaderLength = [
    1, // minimum_instruction_length
    1, // maximum_operations_per_instruction
    1, // default_is_stmt
    0xfb, // line_base = -5
    14, // line_range
    13, // opcode_base
    0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, // std_opcode_lengths
    0, // include_directories terminator
    ...ascii('main.c'), 0, ...uleb(0), ...uleb(0), ...uleb(0),
    0, // file_names terminator
  ]
  const program = [
    0x00, 5, 0x02, ...u32(0x1000), // DW_LNE_set_address 0x1000
    0x03, ...sleb(9), // advance_line → 10
    0x01, // copy
    0x02, ...uleb(4), // advance_pc 4
    0x03, ...sleb(2), // advance_line → 12
    0x0a, // set_prologue_end
    0x01, // copy
    0x02, ...uleb(4), // advance_pc 4
    0x03, ...sleb(3), // advance_line → 15
    0x01, // copy
    0x02, ...uleb(4), // advance_pc 4
    0x00, 1, 0x01, // DW_LNE_end_sequence
  ]
  const body = [...header, ...u32(afterHeaderLength.length), ...afterHeaderLength, ...program]
  return new Uint8Array([...u32(body.length), ...body])
}

/** Wrap sections in a minimal 32-bit little-endian ELF. */
function makeElf(sections: Record<string, Uint8Array>): Uint8Array {
  const names = ['', ...Object.keys(sections), '.shstrtab']
  const shstrtab: number[] = []
  const nameOffsets = new Map<string, number>()
  for (const name of names) {
    nameOffsets.set(name, shstrtab.length)
    shstrtab.push(...ascii(name), 0)
  }

  const EHDR = 52
  const SHENT = 40
  const count = names.length
  const shoff = EHDR
  let cursor = shoff + count * SHENT

  const bodies: Array<{ name: string; data: Uint8Array; offset: number }> = []
  for (const [name, data] of Object.entries(sections)) {
    bodies.push({ name, data, offset: cursor })
    cursor += data.length
  }
  const shstrOffset = cursor
  cursor += shstrtab.length

  const out = new Uint8Array(cursor)
  const dv = new DataView(out.buffer)
  out.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0)
  dv.setUint32(32, shoff, true) // e_shoff
  dv.setUint16(46, SHENT, true) // e_shentsize
  dv.setUint16(48, count, true) // e_shnum
  dv.setUint16(50, count - 1, true) // e_shstrndx

  const writeHeader = (index: number, name: string, offset: number, size: number) => {
    const at = shoff + index * SHENT
    dv.setUint32(at, nameOffsets.get(name)!, true)
    dv.setUint32(at + 4, 1, true) // SHT_PROGBITS
    dv.setUint32(at + 16, offset, true)
    dv.setUint32(at + 20, size, true)
  }
  writeHeader(0, '', 0, 0)
  bodies.forEach((body, i) => {
    out.set(body.data, body.offset)
    writeHeader(i + 1, body.name, body.offset, body.data.length)
  })
  out.set(shstrtab, shstrOffset)
  writeHeader(count - 1, '.shstrtab', shstrOffset, shstrtab.length)
  return out
}

const elf = makeElf({ '.debug_line': lineProgram() })

describe('buildLineIndex', () => {
  it('runs the line program into rows', () => {
    const index = buildLineIndex(elf)!
    expect(index).not.toBeNull()
    expect(index.files).toEqual(['main.c'])
    expect([...index.addrs]).toEqual([0x1000, 0x1004, 0x1008, 0x100c])
    expect([...index.lines]).toEqual([10, 12, 15, 15])
    expect(index.flags[1]! & ROW_PROLOGUE_END).toBe(ROW_PROLOGUE_END)
  })

  it('has nothing to say about an ELF with no debug info', () => {
    expect(buildLineIndex(makeElf({ '.text': new Uint8Array([1, 2, 3]) }))).toBeNull()
    expect(buildLineIndex(new Uint8Array(8))).toBeNull()
  })
})

describe('addressForLine', () => {
  it('finds the address of a line', () => {
    const index = buildLineIndex(elf)!
    expect(addressForLine(index, 'main.c', 12)).toEqual({ addr: 0x1004, line: 12, file: 'main.c' })
  })

  it('lands on the next line with code, the way `break file:n` does', () => {
    const index = buildLineIndex(elf)!
    // Nothing was emitted for 13 or 14 — an optimised build folds lines away,
    // and the step should still resolve rather than fail.
    expect(addressForLine(index, 'main.c', 13)).toEqual({ addr: 0x1008, line: 15, file: 'main.c' })
  })

  it('matches on basename, and gives up on an unknown file', () => {
    const index = buildLineIndex(elf)!
    expect(addressForLine(index, 'MAIN.C', 10)?.addr).toBe(0x1000)
    expect(addressForLine(index, 'other.c', 10)).toBeNull()
    expect(addressForLine(index, 'main.c', 99)).toBeNull()
  })
})

describe('locationForAddress', () => {
  it('maps an address inside a row back to its line', () => {
    const index = buildLineIndex(elf)!
    expect(locationForAddress(index, 0x1005)).toEqual({ file: 'main.c', line: 12 })
    expect(locationForAddress(index, 0x1000)).toEqual({ file: 'main.c', line: 10 })
  })

  it('has no location before the first row', () => {
    const index = buildLineIndex(elf)!
    expect(locationForAddress(index, 0x0f00)).toBeNull()
  })
})

describe('bodyStart', () => {
  it('prefers the prologue_end row', () => {
    const index = buildLineIndex(elf)!
    expect(bodyStart(index, 0x1000, 0x100c)).toBe(0x1004)
  })

  it('falls back to the first row when the range has no prologue marker', () => {
    const index = buildLineIndex(elf)!
    expect(bodyStart(index, 0x1008, 0x100c)).toBe(0x1008)
  })
})
