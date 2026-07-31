/**
 * The ELF a Live board session takes its debug symbols from — the firmware
 * the user actually flashed. Deliberately separate from guestImage: that one
 * boots in QEMU, and board firmware must never boot in the emulator after a
 * switch back to Simulator. Persists in the shared handoff store under its
 * own key so a refresh keeps the symbols; only an explicit clear drops them.
 */

import { handoffTx, type GuestImage } from '@/guestImage'

const KEY = 'live-symbol-elf'

export type LiveImage = GuestImage

let current: LiveImage | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The symbol ELF for this Live board session, or null. */
export function get(): LiveImage | null {
  return current
}

export function set(image: LiveImage): void {
  current = image
  notify()
  void handoffTx('readwrite', (s) =>
    s.put({ name: image.name, buffer: image.bytes.slice().buffer }, KEY),
  ).catch(() => {
    /* private mode, blocked storage — memory still holds this document's copy */
  })
}

/** Reads the persisted ELF into this document, leaving the stored copy in place. */
export async function claimStashed(): Promise<LiveImage | null> {
  let record: { name: string; buffer: ArrayBuffer } | undefined
  try {
    record = await handoffTx('readonly', (s) => s.get(KEY))
  } catch {
    return null
  }
  if (!record) return null
  current = { name: record.name, bytes: new Uint8Array(record.buffer) }
  notify()
  return current
}

export async function clear(): Promise<void> {
  current = null
  notify()
  try {
    await handoffTx('readwrite', (s) => s.delete(KEY))
  } catch {
    /* same storage failure claimStashed tolerates */
  }
}
