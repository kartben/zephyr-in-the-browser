import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DwarfEngine, type FrameTarget } from '@/debug/dwarf/engine'
import { addressForLine, buildLineIndex } from '@/debug/dwarfLines'
import { buildSymbolIndex } from '@/debug/elfSymbols'

/**
 * The variable reader against the images the site ships: GCC 14 at -O2, DWARF
 * 5, on every architecture the page boots. The images are a release asset, not
 * part of the repository, so this is skipped when they are absent, like
 * src/tours/images.test.ts (`TOUR_IMAGES_DIR` points it elsewhere).
 */

const DIR = resolve(process.cwd(), process.env.TOUR_IMAGES_DIR || 'public/qemu/zephyr')

const BOARDS = [
  { board: 'qemu_cortex_m3', firstArg: 0, ptr: 4 },
  { board: 'qemu_cortex_a53', firstArg: 0, ptr: 8 },
  { board: 'qemu_riscv32', firstArg: 10, ptr: 4 },
  { board: 'esp32c3_devkitc', firstArg: 10, ptr: 4 },
  // Windowed ABI: the callee finds its first argument in a2.
  { board: 'esp32_devkitc_esp32_procpu', firstArg: 2, ptr: 4 },
]

/** A target with every register readable and no memory. */
function registersOnly(pc: number): FrameTarget {
  return { pc, reg: (n) => BigInt(0x1000 + n), read: async () => null }
}

for (const { board, firstArg, ptr } of BOARDS) {
  const file = join(DIR, board, 'basic_button.elf')
  describe.skipIf(!existsSync(file))(`basic_button on ${board}`, () => {
    let engine: DwarfEngine
    let pc: number
    beforeAll(() => {
      // Read here, not in the describe body: vitest collects a skipped suite's
      // body too, and CI has no images.
      const elf = new Uint8Array(readFileSync(file))
      engine = DwarfEngine.forElf(elf)!
      pc = addressForLine(buildLineIndex(elf)!, 'main.c', 22)!.addr
    })

    it('stops in button_input_cb with its parameters in scope', () => {
      const [frame] = engine.framesAt(pc)
      expect(frame?.name).toBe('button_input_cb')
      expect(engine.resolve('evt', frame!, null)?.kind).toBe('param')
      expect(engine.resolve('user_data', frame!, null)?.kind).toBe('param')
    })

    it('finds evt in the first argument register', async () => {
      const evt = engine.resolve('evt', engine.framesAt(pc)[0]!, null)!
      expect(await engine.locate(evt, registersOnly(pc))).toEqual({ kind: 'register', reg: firstArg })
      expect(engine.types.name(engine.types.typeOf(evt.die))).toBe('struct input_event *')
    })

    it('lays out struct input_event for the pointer width', () => {
      const evt = engine.resolve('evt', engine.framesAt(pc)[0]!, null)!
      const pointer = engine.types.strip(engine.types.typeOf(evt.die))
      expect(pointer.kind).toBe('pointer')
      if (pointer.kind !== 'pointer') return
      const event = engine.types.complete(engine.types.strip(pointer.target))
      expect(event.kind === 'struct' && event.members.map((m) => [m.name, m.offset])).toEqual([
        ['dev', 0],
        ['sync', ptr],
        ['type', ptr + 1],
        ['code', ptr + 2],
        ['value', ptr + 4],
      ])
    })

    it('says led0 is optimized out, as GDB would', async () => {
      const led0 = engine.resolve('led0', engine.framesAt(pc)[0]!, null)!
      expect(led0.kind).toBe('static')
      expect(await engine.locate(led0, registersOnly(pc))).toEqual({ kind: 'unavailable', reason: 'optimized out' })
    })

    it('has a call-frame rule at the stop', () => {
      expect(engine.cfi?.rowAt(pc)?.cfa.kind).toBe('reg')
    })
  })
}

const zbus = join(DIR, 'qemu_cortex_a53', 'zbus.elf')
describe.skipIf(!existsSync(zbus))('zbus on qemu_cortex_a53', () => {
  let engine: DwarfEngine
  let main: number
  beforeAll(() => {
    const elf = new Uint8Array(readFileSync(zbus))
    engine = DwarfEngine.forElf(elf)!
    main = buildSymbolIndex(elf)!.byName.find((s) => s.name === 'main')!.addr
  })

  it("puts main's stack locals at the CFA from .debug_frame", async () => {
    const pc = main + 8
    const row = engine.cfi!.rowAt(pc)!
    expect(row.cfa).toEqual({ kind: 'reg', reg: 31, offset: 64 })
    const value = engine.resolve('value', engine.framesAt(pc)[0]!, null)!
    const sp = 0x4001_0000n
    const target: FrameTarget = { pc, reg: (n) => (n === 31 ? sp : null), read: async () => null }
    // DW_OP_fbreg -24 from a frame base of DW_OP_call_frame_cfa.
    expect(await engine.locate(value, target)).toEqual({ kind: 'memory', addr: sp + 64n - 24n })
  })
})

const blinky = join(DIR, 'qemu_riscv32', 'blinky.elf')
const blinkySource = join(DIR, 'qemu_riscv32', 'src', 'blinky', 'main.c')
describe.skipIf(!existsSync(blinky) || !existsSync(blinkySource))('blinky on qemu_riscv32', () => {
  let engine: DwarfEngine
  let pc: number
  beforeAll(() => {
    const elf = new Uint8Array(readFileSync(blinky))
    engine = DwarfEngine.forElf(elf)!
    const line = readFileSync(blinkySource, 'utf8').split('\n').findIndex((l) => l.includes('k_msleep(')) + 1
    pc = addressForLine(buildLineIndex(elf)!, 'main.c', line)!.addr
  })

  it('stops in main, not in the k_msleep it is about to call, as GDB does', () => {
    // k_msleep, k_sleep and k_sleep_ticks are inlined, and all three begin on
    // this instruction: none of them has run yet.
    const frames = engine.framesAt(pc)
    expect(frames.map((f) => f.name)).toEqual(['main'])
    expect(engine.resolve('led_state', frames[0]!, null)?.kind).toBe('local')
  })
})
