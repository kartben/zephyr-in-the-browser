/**
 * Shared drain/feed for QEMU's browser chardev rings (monitor or gdb).
 *
 * Both channels export the same six symbols with a different prefix. The page
 * never holds a Chardev pointer — only these free-running ring indices.
 */

export interface ChardevExports {
  feed?: (value: number) => number
  ring?: () => number
  ringSize?: () => number
  readIndex?: () => number
  writeIndex?: () => number
  setReadIndex?: (value: number) => void
  HEAPU8?: Uint8Array
}

export type ChardevSlot = 'monitor' | 'gdb' | 'hci'

/** Bind the six exports for a named slot from an Emscripten Module. */
export function bindChardev(mod: Record<string, unknown>, slot: ChardevSlot): ChardevExports {
  const prefix =
    slot === 'monitor'
      ? '_qemu_browser_monitor_'
      : slot === 'gdb'
        ? '_qemu_browser_gdb_'
        : '_qemu_browser_hci_'
  return {
    feed: mod[`${prefix}feed`] as ChardevExports['feed'],
    ring: mod[`${prefix}ring`] as ChardevExports['ring'],
    // Emscripten keeps the C snake_case: ring_size, not ringSize.
    ringSize: mod[`${prefix}ring_size`] as ChardevExports['ringSize'],
    readIndex: mod[`${prefix}read_index`] as ChardevExports['readIndex'],
    writeIndex: mod[`${prefix}write_index`] as ChardevExports['writeIndex'],
    setReadIndex: mod[`${prefix}set_read_index`] as ChardevExports['setReadIndex'],
    HEAPU8: mod.HEAPU8 as Uint8Array | undefined,
  }
}

export function chardevAvailable(ch: ChardevExports): boolean {
  return typeof ch.feed === 'function' && typeof ch.ring === 'function'
}

/** Write raw bytes into the page→QEMU ring. */
export function feedBytes(ch: ChardevExports, bytes: Uint8Array | string): boolean {
  const feed = ch.feed
  if (!feed) return false
  if (typeof bytes === 'string') {
    for (let i = 0; i < bytes.length; i++) {
      if (feed(bytes.charCodeAt(i) & 0xff) < 0) return false
    }
    return true
  }
  for (let i = 0; i < bytes.length; i++) {
    if (feed(bytes[i]!) < 0) return false
  }
  return true
}

/** Drain newly written bytes from the QEMU→page ring. */
export function drainBytes(ch: ChardevExports): Uint8Array {
  const heap = ch.HEAPU8
  const readIdx = ch.readIndex
  const writeIdx = ch.writeIndex
  const setRead = ch.setReadIndex
  const ring = ch.ring
  const sizeFn = ch.ringSize
  if (!heap || !readIdx || !writeIdx || !setRead || !ring || !sizeFn) return new Uint8Array()

  const size = sizeFn()
  if (size <= 0) return new Uint8Array()
  const base = ring()
  let read = readIdx()
  const write = writeIdx()
  if (read === write) return new Uint8Array()

  const out = new Uint8Array((write - read) >>> 0)
  let i = 0
  while (read !== write) {
    out[i++] = heap[base + (read % size)]!
    read = (read + 1) >>> 0
  }
  setRead(read)
  return out
}
