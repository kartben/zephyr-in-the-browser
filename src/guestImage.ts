/**
 * A user-supplied guest image, replacing the board's stock one.
 *
 * The awkward part is the reload. An Emscripten module is single-shot per
 * document, so booting a different image after QEMU is already running means
 * navigating — and the dropped bytes have to survive that. They are handed off
 * through IndexedDB and deleted on the way out, so this is a one-shot buffer
 * rather than persistence: nothing outlives the boot it was dropped for.
 */

const DB_NAME = 'zephyr-in-the-browser'
const STORE = 'handoff'
const KEY = 'pending-guest-image'

export interface GuestImage {
  name: string
  bytes: Uint8Array
}

let current: GuestImage | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The image this session booted with, or null for the board's stock one. */
export function get(): GuestImage | null {
  return current
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }),
  )
}

/** Stash bytes for the next document to pick up, then reload into them. */
export async function stash(image: GuestImage): Promise<void> {
  // Store a plain ArrayBuffer: structured clone handles it everywhere, and a
  // detached view would not survive.
  await tx('readwrite', (s) =>
    s.put({ name: image.name, buffer: image.bytes.slice().buffer }, KEY),
  )
}

/**
 * Reads and clears the stashed image. Called once at startup, before any
 * backend runs, so a failed boot does not trap the page in a reload loop.
 */
export async function claimStashed(): Promise<GuestImage | null> {
  let record: { name: string; buffer: ArrayBuffer } | undefined
  try {
    record = await tx('readonly', (s) => s.get(KEY))
    if (record) await tx('readwrite', (s) => s.delete(KEY))
  } catch {
    return null // private mode, blocked storage — fall back to the stock image
  }
  if (!record) return null
  current = { name: record.name, bytes: new Uint8Array(record.buffer) }
  notify()
  return current
}

/**
 * Use this image for the next boot in *this* document. Only valid before QEMU
 * has committed; afterwards the caller must stash() and reload instead.
 */
export function set(image: GuestImage) {
  current = image
  notify()
}

/** Forget the custom image; the next boot uses the board's stock one. */
export function clear() {
  current = null
  notify()
}

/**
 * ELF magic check. Cheap, and it turns "dropped the wrong file" into a clear
 * message instead of a guest that silently never boots.
 */
export function looksLikeElf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
}

export async function readFile(file: File): Promise<GuestImage> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!looksLikeElf(bytes)) {
    throw new Error(`${file.name} is not an ELF file (bad magic).`)
  }
  return { name: file.name, bytes }
}
