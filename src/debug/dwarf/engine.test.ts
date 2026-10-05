import { describe, expect, it } from 'vitest'
import { AT, ATE, FORM, LLE, RLE, TAG } from '@/debug/dwarf/constants'
import { DwarfEngine, type FrameTarget } from '@/debug/dwarf/engine'
import { assembleUnit, listSection, makeElf, sleb, u32, uleb, type DieSpec } from '@/debug/dwarf/testing/dwarfBuilder'
import { ValueReader, type ValueTarget } from '@/debug/dwarf/values'
import { createInspector } from '@/debug/inspect'

/* ------------------------------------------------------------------ *
 * A unit shaped like GCC's -O2 output, small enough to read:
 *
 *   struct point { int x; int y; unsigned flags : 3; };
 *   typedef struct point point_t;
 *   point_t g_point;                       // global, at 0x20000000
 *   static int s_count;                    // file static, at 0x20000010
 *   static inline int helper(point_t *p) { int n; ... }
 *   void main(void) {                      // 0x1000..0x1100, CFA = sp + 16
 *     int count;                           // fbreg -8
 *     int gone;                            // optimized out
 *     { int inner; ... }                   // 0x1010..0x1020, in r5
 *     helper(&g_point);                    // inlined at 0x1040..0x1050, 0x1060..0x1070
 *   }
 *
 * helper's `p` is in r0 for its first 8 bytes and an entry value after that;
 * its `n` has no concrete DIE at all, as when the optimiser drops a variable.
 * ------------------------------------------------------------------ */

const loclists = listSection([
  LLE.start_length, ...u32(0x1040), ...uleb(8), ...uleb(1), 0x50, // [0x1040, 0x1048): r0
  LLE.start_length, ...u32(0x1048), ...uleb(0x28), ...uleb(4), 0xa3, 1, 0x50, 0x9f, // entry value
  LLE.end_of_list,
])
const rnglists = listSection([
  RLE.start_length, ...u32(0x1040), ...uleb(0x10),
  RLE.start_length, ...u32(0x1060), ...uleb(0x10),
  RLE.end_of_list,
])

const unit: DieSpec = {
  tag: TAG.compile_unit,
  attrs: [
    [AT.name, FORM.string, 'main.c'],
    [AT.low_pc, FORM.addr, 0x1000],
    [AT.high_pc, FORM.data4, 0x100],
  ],
  children: [
    { id: 'int', tag: TAG.base_type, attrs: [[AT.name, FORM.string, 'int'], [AT.byte_size, FORM.data1, 4], [AT.encoding, FORM.data1, ATE.signed]] },
    { id: 'uint', tag: TAG.base_type, attrs: [[AT.name, FORM.string, 'unsigned int'], [AT.byte_size, FORM.data1, 4], [AT.encoding, FORM.data1, ATE.unsigned]] },
    {
      id: 'point',
      tag: TAG.structure_type,
      attrs: [[AT.name, FORM.string, 'point'], [AT.byte_size, FORM.data1, 12]],
      children: [
        { tag: TAG.member, attrs: [[AT.name, FORM.string, 'x'], [AT.type, FORM.ref4, { ref: 'int' }], [AT.data_member_location, FORM.data1, 0]] },
        { tag: TAG.member, attrs: [[AT.name, FORM.string, 'y'], [AT.type, FORM.ref4, { ref: 'int' }], [AT.data_member_location, FORM.data1, 4]] },
        { tag: TAG.member, attrs: [[AT.name, FORM.string, 'flags'], [AT.type, FORM.ref4, { ref: 'uint' }], [AT.bit_size, FORM.data1, 3], [AT.data_bit_offset, FORM.data1, 64]] },
      ],
    },
    { id: 'point_t', tag: TAG.typedef, attrs: [[AT.name, FORM.string, 'point_t'], [AT.type, FORM.ref4, { ref: 'point' }]] },
    { id: 'point_ptr', tag: TAG.pointer_type, attrs: [[AT.byte_size, FORM.data1, 4], [AT.type, FORM.ref4, { ref: 'point_t' }]] },
    {
      id: 'helper',
      tag: TAG.subprogram,
      attrs: [[AT.name, FORM.string, 'helper'], [AT.inline, FORM.data1, 3]],
      children: [
        { id: 'helper.p', tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 'p'], [AT.type, FORM.ref4, { ref: 'point_ptr' }]] },
        { id: 'helper.n', tag: TAG.variable, attrs: [[AT.name, FORM.string, 'n'], [AT.type, FORM.ref4, { ref: 'int' }]] },
      ],
    },
    {
      tag: TAG.subprogram,
      attrs: [
        [AT.name, FORM.string, 'main'],
        [AT.low_pc, FORM.addr, 0x1000],
        [AT.high_pc, FORM.data4, 0x100],
        [AT.frame_base, FORM.exprloc, [0x9c]],
      ],
      children: [
        { tag: TAG.variable, attrs: [[AT.name, FORM.string, 'count'], [AT.type, FORM.ref4, { ref: 'int' }], [AT.location, FORM.exprloc, [0x91, ...sleb(-8)]]] },
        { tag: TAG.variable, attrs: [[AT.name, FORM.string, 'gone'], [AT.type, FORM.ref4, { ref: 'int' }]] },
        {
          tag: TAG.lexical_block,
          attrs: [[AT.low_pc, FORM.addr, 0x1010], [AT.high_pc, FORM.data4, 0x10]],
          children: [
            { tag: TAG.variable, attrs: [[AT.name, FORM.string, 'inner'], [AT.type, FORM.ref4, { ref: 'int' }], [AT.location, FORM.exprloc, [0x55]]] },
          ],
        },
        {
          tag: TAG.inlined_subroutine,
          attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'helper' }], [AT.ranges, FORM.sec_offset, rnglists.first], [AT.call_line, FORM.data1, 42]],
          children: [
            { tag: TAG.formal_parameter, attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'helper.p' }], [AT.location, FORM.sec_offset, loclists.first]] },
          ],
        },
      ],
    },
    { tag: TAG.variable, attrs: [[AT.name, FORM.string, 'g_point'], [AT.type, FORM.ref4, { ref: 'point_t' }], [AT.external, FORM.flag_present, true], [AT.location, FORM.exprloc, [0x03, ...u32(0x2000_0000)]]] },
    { tag: TAG.variable, attrs: [[AT.name, FORM.string, 's_count'], [AT.type, FORM.ref4, { ref: 'int' }], [AT.location, FORM.exprloc, [0x03, ...u32(0x2000_0010)]]] },
  ],
}

/** main's frame: CFA = r13 at entry, r13 + 16 from 0x1004 on. */
function debugFrame(): Uint8Array {
  const cie = [...u32(0xffffffff), 3, 0, 1, 0x7c, 14, 0x0c, 13, 0]
  const fde = [...u32(0), ...u32(0x1000), ...u32(0x100), 0x40 | 4, 0x0e, 16]
  return new Uint8Array([...u32(cie.length), ...cie, ...u32(fde.length), ...fde])
}

const { info, abbrev } = assembleUnit(unit)
const elf = makeElf({
  '.debug_info': info,
  '.debug_abbrev': abbrev,
  '.debug_loclists': loclists.bytes,
  '.debug_rnglists': rnglists.bytes,
  '.debug_frame': debugFrame(),
})
const engine = DwarfEngine.forElf(elf)!

/** RAM at 0x20000000: g_point = {3, -4, flags 5}, s_count = 7. Stack at 0x20000800. */
function memory(): Uint8Array {
  const ram = new Uint8Array(0x1000)
  const dv = new DataView(ram.buffer)
  dv.setInt32(0, 3, true)
  dv.setInt32(4, -4, true)
  dv.setUint32(8, 5, true)
  dv.setInt32(0x10, 7, true)
  dv.setInt32(0x808, 99, true) // count: CFA (0x20000810) - 8
  return ram
}

function target(pc: number): FrameTarget & ValueTarget {
  const ram = memory()
  const regs = new Map<number, bigint>([
    [0, 0x2000_0000n],
    [5, 21n],
    [13, 0x2000_0800n],
  ])
  return {
    pc,
    reg: (n) => regs.get(n) ?? null,
    read: async (addr, size) =>
      addr >= 0x2000_0000 && addr + size <= 0x2000_1000 ? ram.slice(addr - 0x2000_0000, addr - 0x2000_0000 + size) : null,
    label: () => null,
    codeAddress: (addr) => addr,
  }
}

describe('DwarfEngine on a hand-built unit', () => {
  it('finds the function and the block around the PC', () => {
    const [frame] = engine.framesAt(0x1014)
    expect(frame?.name).toBe('main')
    expect(frame?.scopes.map((s) => s.tag)).toEqual([TAG.subprogram, TAG.lexical_block])
    expect(engine.resolve('inner', frame!, null)?.kind).toBe('local')
    expect(engine.resolve('gone', frame!, null)?.kind).toBe('local')
    // Outside the block, its local is not in scope.
    expect(engine.resolve('inner', engine.framesAt(0x1030)[0]!, null)).toBeNull()
  })

  it('splits an inlined call into its own frame, named by its abstract origin', () => {
    const frames = engine.framesAt(0x1044)
    expect(frames.map((f) => [f.name, f.inlined])).toEqual([
      ['helper', true],
      ['main', false],
    ])
    expect(engine.resolve('p', frames[0]!, null)?.kind).toBe('param')
    // `n` has no concrete DIE: it is found through the abstract origin.
    expect(engine.resolve('n', frames[0]!, null)?.kind).toBe('local')
    // The second range of the inlined call counts too.
    expect(engine.framesAt(0x1064)[0]?.name).toBe('helper')
    expect(engine.framesAt(0x1054)[0]?.name).toBe('main')
  })

  it('stops in the caller at the first instruction of an inlined call, as GDB does', () => {
    // 0x1040 begins the inlined helper: none of it has run yet.
    const frames = engine.framesAt(0x1040)
    expect(frames.map((f) => f.name)).toEqual(['main'])
    expect(engine.resolve('count', frames[0]!, null)?.kind).toBe('local')
    // One instruction on, the call is entered.
    expect(engine.framesAt(0x1042).map((f) => f.name)).toEqual(['helper', 'main'])
  })

  it('reads a location list at the PC', async () => {
    const p = engine.resolve('p', engine.framesAt(0x1044)[0]!, null)!
    expect(await engine.locate(p, target(0x1044))).toEqual({ kind: 'register', reg: 0 })
    expect(await engine.locate(p, target(0x104a))).toEqual({ kind: 'unavailable', reason: 'optimized out' })
    const n = engine.resolve('n', engine.framesAt(0x1044)[0]!, null)!
    expect(await engine.locate(n, target(0x1044))).toEqual({ kind: 'unavailable', reason: 'optimized out' })
  })

  it('puts frame-based locals at the CFA', async () => {
    const count = engine.resolve('count', engine.framesAt(0x1014)[0]!, null)!
    // CFA at 0x1014 is sp + 16; count is CFA - 8.
    expect(await engine.locate(count, target(0x1014))).toEqual({ kind: 'memory', addr: 0x2000_0808n })
  })

  it('resolves names the way C scopes them', () => {
    const frame = engine.framesAt(0x1014)[0]!
    expect(engine.resolve('inner', frame, null)?.kind).toBe('local')
    expect(engine.resolve('g_point', frame, null)?.kind).toBe('global')
    expect(engine.resolve('s_count', frame, null)?.kind).toBe('static')
    expect(engine.resolve('nope', frame, null)).toBeNull()
    // Inside the inlined helper, main's locals are not visible.
    expect(engine.resolve('count', engine.framesAt(0x1044)[0]!, null)).toBeNull()
  })

  it('names types as C spells them', () => {
    const p = engine.resolve('p', engine.framesAt(0x1044)[0]!, null)!
    expect(engine.types.name(engine.types.typeOf(p.die))).toBe('point_t *')
    const flags = engine.types.member(engine.types.typeOf(p.die), 'flags')
    expect(flags).toBeNull() // through a pointer there are no members
    const point = engine.types.strip(engine.types.typeOf(engine.resolve('g_point', null, engine.info.unitForPc(0x1000))!.die))
    expect(point.kind === 'struct' && point.members.map((m) => [m.name, m.offset, m.bitSize ?? null])).toEqual([
      ['x', 0, null],
      ['y', 4, null],
      ['flags', 8, 3],
    ])
  })

  it('reads values, struct members and bitfields', async () => {
    const t = target(0x1014)
    const reader = new ValueReader(engine, t)
    const g = engine.resolve('g_point', engine.framesAt(0x1014)[0]!, null)!
    const view = await reader.view({ name: 'g_point', type: engine.types.typeOf(g.die), loc: await engine.locate(g, t) })
    expect(view.text).toBe('{...}')
    expect(view.typeName).toBe('point_t')
    const members = await view.children()
    expect(members.map((m) => `${m.name}: ${m.text}`)).toEqual(['x: 3', 'y: -4', 'flags: 5'])
  })
})

describe('createInspector on a hand-built unit', () => {
  const dump = (pc: number) =>
    [`R00=20000000`, `R05=00000015`, `R13=20000800`, `R15=${pc.toString(16).padStart(8, '0')}`].join('\n')

  it('evaluates hovered expressions at the stop', async () => {
    const ram = memory()
    const inspector = createInspector({
      elf,
      pc: 0x1044,
      registers: dump(0x1044),
      arch: 'arm',
      symbols: null,
      read: async (addr, size) =>
        addr >= 0x2000_0000 && addr + size <= 0x2000_1000 ? ram.slice(addr - 0x2000_0000, addr - 0x2000_0000 + size) : null,
    })!
    expect((await inspector.evaluate('p'))?.text).toBe('0x20000000')
    expect((await inspector.evaluate('p->y'))?.text).toBe('-4')
    expect((await inspector.evaluate('p->flags'))?.text).toBe('5')
    expect((await inspector.evaluate('n'))?.text).toBe('<optimized out>')
    expect((await inspector.evaluate('g_point.x'))?.text).toBe('3')
    expect((await inspector.evaluate('s_count'))?.text).toBe('7')
    // Not in scope inside the inlined helper, and not a variable at all: no hover.
    expect(await inspector.evaluate('count')).toBeNull()
    expect(await inspector.evaluate('MACRO')).toBeNull()
    expect(await inspector.evaluate('p->nope')).toBeNull()
  })

  it('opens a pointer to a struct onto its members, as VS Code does', async () => {
    const ram = memory()
    const inspector = createInspector({
      elf,
      pc: 0x1044,
      registers: dump(0x1044),
      arch: 'arm',
      symbols: null,
      read: async (addr, size) =>
        addr >= 0x2000_0000 && addr + size <= 0x2000_1000 ? ram.slice(addr - 0x2000_0000, addr - 0x2000_0000 + size) : null,
    })!
    const p = (await inspector.evaluate('p'))!
    expect(p.typeName).toBe('point_t *')
    expect(p.expandable).toBe(true)
    expect((await p.children()).map((m) => `${m.name}: ${m.text}`)).toEqual(['x: 3', 'y: -4', 'flags: 5'])
  })

  it('has nothing to inspect in an image without DWARF', () => {
    const bare = makeElf({ '.text': new Uint8Array([0, 1, 2, 3]) })
    expect(createInspector({ elf: bare, pc: 0, registers: '', arch: 'arm', symbols: null, read: async () => null })).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Parameter names for the register tooltips, in a second unit:
 *
 *   static inline int scale(int value, int shift);
 *   static int clamp(int lo, int v);
 *   int filter(int *s, int gain) {         // 0x2000..0x2040
 *     ... scale(*s, gain) ...              // inlined at 0x2010..0x2020
 *   }
 *   void report(int, int level);           // 0x2060..0x2070, first one unnamed
 *
 * scale is also kept out of line, split in two (0x2040..0x2050 and
 * 0x2080..0x2090), and names its parameters only through its abstract
 * origin, as button_input_cb does in the real images; no DIE is left for
 * `shift`. clamp exists only as clamp.constprop.0 (0x2050..0x2060), made
 * for lo == 0, and GCC lists the parameter it no longer takes last.
 * ------------------------------------------------------------------ */

const splitScale = listSection([
  RLE.start_length, ...u32(0x2040), ...uleb(0x10),
  RLE.start_length, ...u32(0x2080), ...uleb(0x10),
  RLE.end_of_list,
])

const paramsUnit: DieSpec = {
  tag: TAG.compile_unit,
  attrs: [
    [AT.name, FORM.string, 'filter.c'],
    [AT.low_pc, FORM.addr, 0x2000],
    [AT.high_pc, FORM.data4, 0x100],
  ],
  children: [
    { id: 'int', tag: TAG.base_type, attrs: [[AT.name, FORM.string, 'int'], [AT.byte_size, FORM.data1, 4], [AT.encoding, FORM.data1, ATE.signed]] },
    {
      id: 'scale',
      tag: TAG.subprogram,
      attrs: [[AT.name, FORM.string, 'scale'], [AT.inline, FORM.data1, 3]],
      children: [
        { id: 'scale.value', tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 'value'], [AT.type, FORM.ref4, { ref: 'int' }]] },
        { id: 'scale.shift', tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 'shift'], [AT.type, FORM.ref4, { ref: 'int' }]] },
      ],
    },
    {
      id: 'clamp',
      tag: TAG.subprogram,
      attrs: [[AT.name, FORM.string, 'clamp'], [AT.inline, FORM.data1, 1]],
      children: [
        { id: 'clamp.lo', tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 'lo'], [AT.type, FORM.ref4, { ref: 'int' }]] },
        { id: 'clamp.v', tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 'v'], [AT.type, FORM.ref4, { ref: 'int' }]] },
      ],
    },
    {
      tag: TAG.subprogram,
      attrs: [[AT.name, FORM.string, 'filter'], [AT.low_pc, FORM.addr, 0x2000], [AT.high_pc, FORM.data4, 0x40]],
      children: [
        { tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 's'], [AT.type, FORM.ref4, { ref: 'int' }]] },
        { tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 'gain'], [AT.type, FORM.ref4, { ref: 'int' }]] },
        {
          tag: TAG.inlined_subroutine,
          attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'scale' }], [AT.low_pc, FORM.addr, 0x2010], [AT.high_pc, FORM.data4, 0x10]],
          children: [
            { tag: TAG.formal_parameter, attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'scale.value' }]] },
            { tag: TAG.formal_parameter, attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'scale.shift' }]] },
          ],
        },
      ],
    },
    {
      tag: TAG.subprogram,
      attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'scale' }], [AT.ranges, FORM.sec_offset, splitScale.first]],
      children: [{ tag: TAG.formal_parameter, attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'scale.value' }]] }],
    },
    {
      tag: TAG.subprogram,
      attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'clamp' }], [AT.low_pc, FORM.addr, 0x2050], [AT.high_pc, FORM.data4, 0x10]],
      children: [
        { tag: TAG.formal_parameter, attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'clamp.v' }]] },
        { tag: TAG.formal_parameter, attrs: [[AT.abstract_origin, FORM.ref4, { ref: 'clamp.lo' }], [AT.const_value, FORM.data1, 0]] },
      ],
    },
    {
      tag: TAG.subprogram,
      attrs: [[AT.name, FORM.string, 'report'], [AT.low_pc, FORM.addr, 0x2060], [AT.high_pc, FORM.data4, 0x10]],
      children: [
        { tag: TAG.formal_parameter, attrs: [[AT.type, FORM.ref4, { ref: 'int' }]] },
        { tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 'level'], [AT.type, FORM.ref4, { ref: 'int' }]] },
      ],
    },
  ],
}

describe('DwarfEngine.parameterNames on a hand-built unit', () => {
  const unit = assembleUnit(paramsUnit)
  const params = DwarfEngine.forElf(
    makeElf({ '.debug_info': unit.info, '.debug_abbrev': unit.abbrev, '.debug_rnglists': splitScale.bytes }),
  )!

  it("lists a function's parameters in order", () => {
    expect(params.parameterNames(0x2000)).toEqual(['s', 'gain'])
    expect(params.parameterNames(0x2004)).toEqual(['s', 'gain'])
  })

  it('keeps the real function inside an inlined call: its arguments are the ones in registers', () => {
    expect(params.framesAt(0x2014).map((f) => f.name)).toEqual(['scale', 'filter'])
    expect(params.parameterNames(0x2014)).toEqual(['s', 'gain'])
  })

  it('names an out-of-line copy through its abstract origin, in either of its ranges', () => {
    // No DIE was kept for `shift`: only the abstract origin still declares it.
    expect(params.parameterNames(0x2044)).toEqual(['value', 'shift'])
    expect(params.parameterNames(0x2084)).toEqual(['value', 'shift'])
  })

  it("lists a clone's parameters as GDB does, the one it no longer takes last", () => {
    expect(params.parameterNames(0x2054)).toEqual(['v', 'lo'])
  })

  it('keeps the place of an unnamed parameter', () => {
    expect(params.parameterNames(0x2064)).toEqual(['', 'level'])
  })

  it('has none where there is no function', () => {
    expect(params.parameterNames(0x2074)).toEqual([])
    expect(params.parameterNames(0x9000)).toEqual([])
  })
})
