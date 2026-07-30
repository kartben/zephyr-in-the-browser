/**
 * `struct device *` → device name, read out of the ELF with no live target.
 *
 * The PM device CTF events identify a device by pointer and nothing else, so a
 * trace on its own shows `0x4000c1d0` where a reader wants `pm_demo_radio`. The
 * pointer is enough, because `name` is the *first* member of `struct device`:
 *
 *     struct device {
 *             const char *name;
 *             const void *config;
 *             ...
 *
 * so the name pointer sits at offset 0, and both it and the string it points at
 * are `const` — they live in .rodata, which is present in the ELF at the same
 * addresses the guest sees. Two reads and no debugger: no gdb attach, no halting
 * the machine, and it works before the guest has even booted.
 *
 * Every device also has an `__device_dts_ord_<n>` (or `__device_<name>`) symbol,
 * which is how the table is enumerated. That symbol name alone would be a poor
 * label — `__device_dts_ord_17` names a devicetree ordinal, not a device — which
 * is why the name string is followed rather than the symbol reused.
 */

import { buildElfDataSymbols, readElfCString, readElfVirtual } from './elfSymbols'

/** Longest device name worth reading; Zephyr's are node paths at worst. */
const MAX_NAME = 48

/** Printable ASCII, no control characters — what a device name always is. */
function isPlausibleDeviceName(name: string): boolean {
  return /^[\x20-\x7e]+$/.test(name)
}

/**
 * Map of device address → name for every `__device_*` symbol in the image.
 *
 * Keyed by the low 32 bits, because that is what the guest emits: the CTF
 * backend casts `const struct device *` through `(uint32_t)(uintptr_t)`. On these
 * boards RAM starts at 0x40000000 and spans at most 128 MB, so the truncation is
 * lossless and the key is the pointer — but keying on the truncation rather than
 * the full value means a 64-bit image with high addresses degrades to a wrong
 * name rather than no name, so the full address is kept too.
 */
export interface ElfDeviceNames {
  /** Low 32 bits of the device address → name. */
  byAddr32: Map<number, string>
  /** Full address → name, for callers that have the untruncated pointer. */
  byAddr: Map<number, string>
}

export function readElfDeviceNames(elf: Uint8Array): ElfDeviceNames {
  const byAddr32 = new Map<number, string>()
  const byAddr = new Map<number, string>()
  const little = elf[5] === 1
  const elfclass = elf[4] as 1 | 2
  const ptrSize = elfclass === 2 ? 8 : 4

  for (const [symbol, sym] of buildElfDataSymbols(elf)) {
    if (!symbol.startsWith('__device_')) continue
    /*
     * `__device_dts_ord_<n>` and `__device_<dev_id>` are the struct itself. The
     * prefix is also used for linker section bounds — `__device_deps_start`,
     * `__device_states_end` — which are addresses in a different section
     * entirely, so reading offset 0 there yields whatever happens to be first
     * in it. Dropping the `_start`/`_end` suffixes covers every such pair in the
     * tree today, and the printability check below covers the ones that get
     * added later.
     */
    if (/_(start|end)$/.test(symbol)) continue

    const head = readElfVirtual(elf, sym.addr, ptrSize)
    if (!head || head.length < ptrSize) continue
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
    const namePtr =
      ptrSize === 8
        ? little
          ? dv.getUint32(0, true) + dv.getUint32(4, true) * 0x1_0000_0000
          : dv.getUint32(4, false) + dv.getUint32(0, false) * 0x1_0000_0000
        : dv.getUint32(0, little)
    if (namePtr === 0) continue

    const name = readElfCString(elf, namePtr, MAX_NAME)
    // A symbol that is not really a struct device still decodes to *something*;
    // requiring printable ASCII is what keeps that out of the UI as a label.
    if (!name || !isPlausibleDeviceName(name)) continue
    byAddr.set(sym.addr, name)
    // First wins: a duplicate truncation would be an aliasing bug, and silently
    // overwriting would make which name you get depend on symbol order.
    const key = sym.addr >>> 0
    if (!byAddr32.has(key)) byAddr32.set(key, name)
  }

  return { byAddr32, byAddr }
}

/** Name for a device pointer as the guest reported it, else a short hex label. */
export function deviceLabel(names: ElfDeviceNames | null, dev: number): string {
  const found = names?.byAddr.get(dev) ?? names?.byAddr32.get(dev >>> 0)
  return found ?? `0x${(dev >>> 0).toString(16)}`
}
