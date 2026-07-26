/** User image handoff is one-shot: IndexedDB survives reload, then gets cleared. */

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

/** Shared handoff store for reload survivors. */
export function handoffTx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }),
  )
}

export async function stash(image: GuestImage): Promise<void> {
  // Store a plain ArrayBuffer: structured clone handles it everywhere, and a
  // detached view would not survive.
  await handoffTx('readwrite', (s) =>
    s.put({ name: image.name, buffer: image.bytes.slice().buffer }, KEY),
  )
}

/** Claim once at startup so a failed boot cannot loop forever. */
export async function claimStashed(): Promise<GuestImage | null> {
  let record: { name: string; buffer: ArrayBuffer } | undefined
  try {
    record = await handoffTx('readonly', (s) => s.get(KEY))
    if (record) await handoffTx('readwrite', (s) => s.delete(KEY))
  } catch {
    return null // private mode, blocked storage — fall back to the stock image
  }
  if (!record) return null
  current = { name: record.name, bytes: new Uint8Array(record.buffer) }
  notify()
  return current
}

export function set(image: GuestImage) {
  current = image
  notify()
}

export function clear() {
  current = null
  notify()
}

/** Turn "dropped the wrong file" into a clear error before boot. */
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
