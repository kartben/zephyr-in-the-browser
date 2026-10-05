import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { readElfZbus, zbusObserverKindLabel, type ZbusTopology } from './elfZbus'

/*
 * A minimal ELF64 little-endian image laid out the way a zbus build is: the
 * three iterable sections back to back in one SHF_ALLOC section, with a symbol
 * per entry and the linker's start/end bounds. No DWARF, so this also covers
 * the layout read from the end of each struct.
 */

const BASE = 0x4000_0000
const SEC_OFF = 0x200

interface Sym {
  name: string
  addr: number
  size: number
  /** STT_NOTYPE (0), STT_OBJECT (1) or STT_FUNC (2). */
  type: number
}

function buildElf(data: Uint8Array, syms: Sym[]): Uint8Array {
  const enc = new TextEncoder()
  const nameOffsets: number[] = []
  let acc = 1
  for (const s of syms) {
    nameOffsets.push(acc)
    acc += s.name.length + 1
  }
  const strtab = enc.encode(['\0', ...syms.map((s) => `${s.name}\0`)].join(''))
  const symtab = new Uint8Array((syms.length + 1) * 24)
  const sv = new DataView(symtab.buffer)
  syms.forEach((s, i) => {
    const o = (i + 1) * 24
    sv.setUint32(o, nameOffsets[i]!, true)
    symtab[o + 4] = 0x10 | s.type // STB_GLOBAL, type
    sv.setUint16(o + 6, 1, true)
    sv.setBigUint64(o + 8, BigInt(s.addr), true)
    sv.setBigUint64(o + 16, BigInt(s.size), true)
  })

  const SYMTAB_OFF = SEC_OFF + data.length
  const STRTAB_OFF = SYMTAB_OFF + symtab.length
  const SHOFF = (STRTAB_OFF + strtab.length + 7) & ~7
  const elf = new Uint8Array(SHOFF + 4 * 64)
  const ev = new DataView(elf.buffer)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0)
  ev.setUint16(16, 2, true)
  ev.setUint16(18, 183, true) // EM_AARCH64
  ev.setBigUint64(40, BigInt(SHOFF), true)
  ev.setUint16(58, 64, true)
  ev.setUint16(60, 4, true)
  elf.set(data, SEC_OFF)
  elf.set(symtab, SYMTAB_OFF)
  elf.set(strtab, STRTAB_OFF)
  const section = (i: number, type: number, flags: number, addr: number, off: number, size: number, link = 0) => {
    const sh = SHOFF + i * 64
    ev.setUint32(sh + 4, type, true)
    ev.setBigUint64(sh + 8, BigInt(flags), true)
    ev.setBigUint64(sh + 16, BigInt(addr), true)
    ev.setBigUint64(sh + 24, BigInt(off), true)
    ev.setBigUint64(sh + 32, BigInt(size), true)
    ev.setUint32(sh + 40, link, true)
  }
  section(0, 0, 0, 0, 0, 0)
  section(1, 1, 0x6, BASE, SEC_OFF, data.length) // PROGBITS, ALLOC | EXEC
  section(2, 2, 0, 0, SYMTAB_OFF, symtab.length, 3)
  section(3, 3, 0, 0, STRTAB_OFF, strtab.length)
  return elf
}

/**
 * Two channels with `CONFIG_ZBUS_CHANNEL_NAME` (48-byte structs) and two
 * observers with `CONFIG_ZBUS_OBSERVER_NAME` (32 bytes), as hello_world builds
 * them on the A53. `temp_chan` has a listener then a subscriber; `cfg_chan` has
 * a validator and no observers.
 */
function zbusImage(): Uint8Array {
  const CHANS = 0x000
  const OBSS = 0x060
  const PAIRS = 0x0a0
  const CODE = 0x0c0
  const MSGQ = 0x0e0
  const data = new Uint8Array(0x100)
  const dv = new DataView(data.buffer)
  const put = (off: number, v: number) => dv.setBigUint64(off, BigInt(v), true)

  // struct zbus_channel { name, message, message_size, user_data, validator, data }:
  // cfg_chan at CHANS, temp_chan at CHANS + 0x30.
  put(CHANS + 0x10, 12) // cfg_chan.message_size
  put(CHANS + 0x20, BASE + CODE + 0x10) // cfg_chan.validator
  put(CHANS + 0x30 + 0x10, 4) // temp_chan.message_size
  // struct zbus_observer { name, type, data, union }
  data[OBSS + 8] = 0 // temp_lis: listener
  put(OBSS + 0x18, BASE + CODE) // its callback
  data[OBSS + 0x20 + 8] = 1 // temp_sub: subscriber
  put(OBSS + 0x20 + 0x18, BASE + MSGQ) // its queue
  // { chan, obs } pairs: temp_chan's two observers, in order
  put(PAIRS + 0x00, BASE + CHANS + 0x30)
  put(PAIRS + 0x08, BASE + OBSS)
  put(PAIRS + 0x10, BASE + CHANS + 0x30)
  put(PAIRS + 0x18, BASE + OBSS + 0x20)

  return buildElf(data, [
    { name: '_zbus_channel_list_start', addr: BASE + CHANS, size: 0, type: 0 },
    // Sorted by name, as the linker leaves them.
    { name: 'cfg_chan', addr: BASE + CHANS, size: 0x30, type: 1 },
    { name: 'temp_chan', addr: BASE + CHANS + 0x30, size: 0x30, type: 1 },
    { name: '_zbus_channel_list_end', addr: BASE + OBSS, size: 0, type: 0 },
    { name: '_zbus_observer_list_start', addr: BASE + OBSS, size: 0, type: 0 },
    { name: 'temp_lis', addr: BASE + OBSS, size: 0x20, type: 1 },
    { name: 'temp_sub', addr: BASE + OBSS + 0x20, size: 0x20, type: 1 },
    { name: '_zbus_observer_list_end', addr: BASE + PAIRS, size: 0, type: 0 },
    { name: '_zbus_channel_observation_list_start', addr: BASE + PAIRS, size: 0, type: 0 },
    { name: 'temp_chan00', addr: BASE + PAIRS, size: 0x10, type: 1 },
    { name: 'temp_chan01', addr: BASE + PAIRS + 0x10, size: 0x10, type: 1 },
    { name: '_zbus_channel_observation_list_end', addr: BASE + PAIRS + 0x20, size: 0, type: 0 },
    { name: 'on_temp', addr: BASE + CODE, size: 0x10, type: 2 },
    { name: 'cfg_valid', addr: BASE + CODE + 0x10, size: 0x10, type: 2 },
    { name: '_zbus_observer_queue_temp_sub', addr: BASE + MSGQ, size: 0x20, type: 1 },
  ])
}

describe('readElfZbus', () => {
  const topo = readElfZbus(zbusImage())!

  it('lists the channels in section order, with their message sizes and validators', () => {
    expect(topo.channels.map((c) => c.name)).toEqual(['cfg_chan', 'temp_chan'])
    expect(topo.channels.map((c) => c.messageSize)).toEqual([12, 4])
    expect(topo.channels[0]!.validator).toBe('cfg_valid')
    expect(topo.channels[1]!.validator).toBeNull()
  })

  it('gives each channel its observers in notification order, with their kinds', () => {
    const temp = topo.channelByAddr32.get(BASE + 0x30)!
    expect(temp.observers.map((o) => [o.name, o.kind, o.targetName])).toEqual([
      ['temp_lis', 'listener', 'on_temp'],
      ['temp_sub', 'subscriber', '_zbus_observer_queue_temp_sub'],
    ])
    expect(topo.channelByAddr32.get(BASE)!.observers).toEqual([])
  })

  it('returns null for an image without zbus', () => {
    expect(readElfZbus(buildElf(new Uint8Array(16), []))).toBeNull()
    expect(readElfZbus(new Uint8Array(64))).toBeNull()
  })

  it('labels observer kinds as a person would', () => {
    expect(zbusObserverKindLabel('async_listener')).toBe('async listener')
    expect(zbusObserverKindLabel('msg_subscriber')).toBe('message subscriber')
    expect(zbusObserverKindLabel(null)).toBe('observer')
  })
})

/*
 * The real thing, when the images are present (tools/build-zephyr-image.sh, or
 * a release unpacked into public/qemu): upstream samples/subsys/zbus/hello_world,
 * read through its DWARF.
 */
const HELLO = resolve(
  process.cwd(),
  process.env.TOUR_IMAGES_DIR || 'public/qemu/zephyr',
  'qemu_cortex_a53/zbus.elf',
)

describe.skipIf(!existsSync(HELLO))('readElfZbus on zbus hello_world', () => {
  // In beforeAll, not the describe body: vitest runs a skipped suite's body to
  // collect it, and there is no image to read when it is skipped.
  let topo: ZbusTopology
  beforeAll(() => {
    topo = readElfZbus(new Uint8Array(readFileSync(HELLO)))!
  })

  it('finds the three channels, alphabetically', () => {
    expect(topo.channels.map((c) => c.name)).toEqual(['acc_data_chan', 'simple_chan', 'version_chan'])
    expect(topo.channels.map((c) => c.messageSize)).toEqual([12, 4, 4])
    expect(topo.channels.map((c) => c.validator)).toEqual([null, 'simple_chan_validator', null])
  })

  it('finds acc_data_chan’s observers in the order ZBUS_OBSERVERS() names them', () => {
    const acc = topo.channels[0]!
    expect(acc.observers.map((o) => [o.name, o.kind, o.targetName])).toEqual([
      ['foo_lis', 'listener', 'listener_callback_example'],
      ['bar_sub', 'subscriber', '_zbus_observer_queue_bar_sub'],
      ['baz_async_lis', 'async_listener', '_zbus_observer_work_baz_async_lis'],
    ])
  })

  it('maps the async listener’s work item back to the listener', () => {
    const baz = topo.observers.find((o) => o.name === 'baz_async_lis')!
    expect(topo.observerByWork32.get(baz.target! >>> 0)).toBe(baz)
  })
})
