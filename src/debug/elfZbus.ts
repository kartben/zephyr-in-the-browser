/**
 * zbus channels and observers, read out of the ELF with no live target.
 *
 * zbus keeps its whole topology in constant data. `ZBUS_CHAN_DEFINE` puts a
 * `const struct zbus_channel` in the `zbus_channel` iterable section, and the
 * observer macros put a `const struct zbus_observer` in `zbus_observer`. Which
 * observers a channel has is a third section, `zbus_channel_observation`: one
 * `{ chan, obs }` pair per observer named in `ZBUS_OBSERVERS()`, each entry
 * named `<channel><index>` so that the linker's sort by name keeps a channel's
 * observers together, in the order they were written. That is the order the
 * dispatcher notifies them in.
 *
 * All three are in .rodata, at the addresses the guest uses, so the channel and
 * observer graph is a few reads of the image away: no gdb session, no halt, and
 * it is there before the guest boots. The zbus CTF events (ctf/zbus.ts) carry
 * nothing but addresses, and this is what names them.
 *
 * What changes at run time is not here: the message, the channel's lock,
 * whether an observer is enabled or masked, and observers added with
 * `zbus_chan_add_obs()`. Those live in RAM.
 */

import { dwarfStruct } from './dwarfMembers'
import {
  buildElfDataSymbols,
  buildSymbolIndex,
  readElfVirtual,
  resolveSymbol,
  type ElfTypedSymbol,
} from './elfSymbols'

/** `enum zbus_observer_type`, in the order zbus.h declares it. */
const OBSERVER_KINDS = ['listener', 'subscriber', 'msg_subscriber', 'async_listener'] as const

export type ZbusObserverKind = (typeof OBSERVER_KINDS)[number]

export interface ZbusObserverInfo {
  addr: number
  /** The C identifier that defined it, which is also what `CONFIG_ZBUS_OBSERVER_NAME` stores. */
  name: string
  /** Null when the type byte holds a value this page does not know. */
  kind: ZbusObserverKind | null
  /**
   * What the observer's union points at: a listener's callback, a subscriber's
   * message queue, a message subscriber's FIFO, an async listener's work item.
   */
  target: number | null
  /** That target's symbol: `listener_callback_example`, `_zbus_observer_queue_bar_sub`. */
  targetName: string | null
}

export interface ZbusChannelInfo {
  addr: number
  name: string
  /** `sizeof` the message type, from the channel's `message_size`. */
  messageSize: number | null
  /** The validator's function name, when the channel has one. */
  validator: string | null
  /** Observers from `ZBUS_OBSERVERS()`, in the order the dispatcher notifies them. */
  observers: ZbusObserverInfo[]
}

export interface ZbusTopology {
  /** In section order, which is the linker's alphabetical order. */
  channels: ZbusChannelInfo[]
  observers: ZbusObserverInfo[]
  /**
   * The CTF backend records pointers as `(uint32_t)(uintptr_t)`, so these are
   * keyed on the low 32 bits. On the A53 board RAM starts at 0x40000000, so the
   * truncation loses nothing.
   */
  channelByAddr32: Map<number, ZbusChannelInfo>
  observerByAddr32: Map<number, ZbusObserverInfo>
  /** An async listener's work item → the listener, for `zbus_async_listener_*` events. */
  observerByWork32: Map<number, ZbusObserverInfo>
}

const addr32 = (addr: number) => addr >>> 0

/** Little- or big-endian unsigned read of 1, 2, 4 or 8 bytes. */
function readUint(bytes: Uint8Array, off: number, size: number, little: boolean): number | null {
  if (off < 0 || off + size > bytes.length) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (size) {
    case 1:
      return dv.getUint8(off)
    case 2:
      return dv.getUint16(off, little)
    case 4:
      return dv.getUint32(off, little)
    case 8: {
      const lo = dv.getUint32(off, little)
      const hi = dv.getUint32(off + 4, little)
      return little ? lo + hi * 0x1_0000_0000 : hi + lo * 0x1_0000_0000
    }
    default:
      return null
  }
}

/** Every symbol with a size inside `[start, end)`, ascending: one per section entry. */
function entriesBetween(
  syms: Map<string, ElfTypedSymbol>,
  start: number,
  end: number,
): ElfTypedSymbol[] {
  const seen = new Map<number, ElfTypedSymbol>()
  for (const sym of syms.values()) {
    if (sym.size === 0 || sym.addr < start || sym.addr >= end) continue
    // Linker bounds share addresses with entries; keep the sized symbol.
    if (!seen.has(sym.addr)) seen.set(sym.addr, sym)
  }
  return [...seen.values()].sort((a, b) => a.addr - b.addr)
}

/**
 * Member offsets for the fields this reads. The DWARF layout when the image has
 * one; otherwise counted from the end of the struct, which works because the
 * fields Kconfig can remove (`name`, `id`) are the first ones in both structs.
 */
function channelLayout(elf: Uint8Array, size: number, ptr: number) {
  const dwarf = dwarfStruct(elf, 'zbus_channel')?.members ?? {}
  return {
    messageSize: dwarf.message_size ?? size - 4 * ptr,
    validator: dwarf.validator ?? size - 2 * ptr,
  }
}

function observerLayout(elf: Uint8Array, size: number, ptr: number) {
  const dwarf = dwarfStruct(elf, 'zbus_observer')?.members ?? {}
  // The union of queue / callback / FIFO / work pointer has no name, so DWARF
  // lists no offset for it; it is the member after `data`, and the last one.
  const data = dwarf.data ?? size - 2 * ptr
  return { type: dwarf.type ?? size - 3 * ptr, target: data + ptr }
}

/**
 * The image's zbus channels and observers, or null when it has no zbus (no
 * `zbus_channel` section bounds).
 */
export function readElfZbus(elf: Uint8Array): ZbusTopology | null {
  if (elf.length < 64 || elf[0] !== 0x7f || elf[1] !== 0x45) return null
  const little = elf[5] === 1
  const ptr = elf[4] === 2 ? 8 : 4
  const syms = buildElfDataSymbols(elf)
  const bound = (name: string) => syms.get(name)?.addr ?? null

  const chanStart = bound('_zbus_channel_list_start')
  const chanEnd = bound('_zbus_channel_list_end')
  if (chanStart === null || chanEnd === null || chanEnd < chanStart) return null

  const byAddr = new Map<number, ElfTypedSymbol>()
  for (const sym of syms.values()) if (sym.size > 0 && !byAddr.has(sym.addr)) byAddr.set(sym.addr, sym)
  const functions = buildSymbolIndex(elf)
  const read = (addr: number, size: number) => readElfVirtual(elf, addr, size)

  const observers: ZbusObserverInfo[] = []
  const observerByAddr32 = new Map<number, ZbusObserverInfo>()
  const observerByWork32 = new Map<number, ZbusObserverInfo>()
  const obsStart = bound('_zbus_observer_list_start')
  const obsEnd = bound('_zbus_observer_list_end')
  if (obsStart !== null && obsEnd !== null) {
    for (const sym of entriesBetween(syms, obsStart, obsEnd)) {
      const bytes = read(sym.addr, sym.size)
      const layout = observerLayout(elf, sym.size, ptr)
      const typeByte = bytes ? readUint(bytes, layout.type, 1, little) : null
      const kind = typeByte !== null ? (OBSERVER_KINDS[typeByte] ?? null) : null
      const target = bytes ? readUint(bytes, layout.target, ptr, little) : null
      let targetName: string | null = null
      if (target) {
        targetName =
          kind === 'listener'
            ? (resolveSymbol(functions, target)?.name ?? null)
            : (byAddr.get(target)?.name ?? null)
      }
      const info: ZbusObserverInfo = { addr: sym.addr, name: sym.name, kind, target, targetName }
      observers.push(info)
      observerByAddr32.set(addr32(sym.addr), info)
      if (kind === 'async_listener' && target) observerByWork32.set(addr32(target), info)
    }
  }

  const channels: ZbusChannelInfo[] = []
  const channelByAddr32 = new Map<number, ZbusChannelInfo>()
  for (const sym of entriesBetween(syms, chanStart, chanEnd)) {
    const bytes = read(sym.addr, sym.size)
    const layout = channelLayout(elf, sym.size, ptr)
    const validator = bytes ? readUint(bytes, layout.validator, ptr, little) : null
    const info: ZbusChannelInfo = {
      addr: sym.addr,
      name: sym.name,
      messageSize: bytes ? readUint(bytes, layout.messageSize, ptr, little) : null,
      validator: validator ? (resolveSymbol(functions, validator)?.name ?? null) : null,
      observers: [],
    }
    channels.push(info)
    channelByAddr32.set(addr32(sym.addr), info)
  }

  const pairStart = bound('_zbus_channel_observation_list_start')
  const pairEnd = bound('_zbus_channel_observation_list_end')
  if (pairStart !== null && pairEnd !== null) {
    // Two pointers per entry, `{ chan, obs }`, whatever Kconfig says.
    for (let at = pairStart; at + 2 * ptr <= pairEnd; at += 2 * ptr) {
      const bytes = read(at, 2 * ptr)
      if (!bytes) break
      const chan = readUint(bytes, 0, ptr, little)
      const obs = readUint(bytes, ptr, ptr, little)
      if (chan === null || obs === null) continue
      const channel = channelByAddr32.get(addr32(chan))
      const observer = observerByAddr32.get(addr32(obs))
      if (channel && observer) channel.observers.push(observer)
    }
  }

  return { channels, observers, channelByAddr32, observerByAddr32, observerByWork32 }
}

/** `listener`, `subscriber`, … as a person would write it. */
export function zbusObserverKindLabel(kind: ZbusObserverKind | null): string {
  switch (kind) {
    case 'listener':
      return 'listener'
    case 'subscriber':
      return 'subscriber'
    case 'msg_subscriber':
      return 'message subscriber'
    case 'async_listener':
      return 'async listener'
    default:
      return 'observer'
  }
}
