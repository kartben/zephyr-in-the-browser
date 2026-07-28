import { vi } from 'vitest'

/**
 * Minimal IndexedDB stand-in for the guest-image / devicetree handoff store.
 * `result` is set before `onupgradeneeded` fires, matching real IDB.
 */
export function installFakeIndexedDb() {
  const tables = new Map<string, Map<IDBValidKey, unknown>>()

  class FakeRequest<T> {
    result!: T
    error: DOMException | null = null
    onsuccess: ((ev: Event) => void) | null = null
    onerror: ((ev: Event) => void) | null = null
    onupgradeneeded: ((ev: Event) => void) | null = null
    _succeed(value: T) {
      this.result = value
      queueMicrotask(() => this.onsuccess?.(new Event('success')))
    }
  }

  class FakeStore {
    constructor(private readonly name: string) {}
    private table() {
      let t = tables.get(this.name)
      if (!t) {
        t = new Map()
        tables.set(this.name, t)
      }
      return t
    }
    get(key: IDBValidKey) {
      const req = new FakeRequest<unknown>()
      req._succeed(this.table().get(key))
      return req as unknown as IDBRequest
    }
    put(value: unknown, key: IDBValidKey) {
      this.table().set(key, value)
      const req = new FakeRequest<IDBValidKey>()
      req._succeed(key)
      return req as unknown as IDBRequest
    }
    delete(key: IDBValidKey) {
      this.table().delete(key)
      const req = new FakeRequest<undefined>()
      req._succeed(undefined)
      return req as unknown as IDBRequest
    }
  }

  class FakeDb {
    objectStoreNames = {
      contains: (n: string) => tables.has(n),
    }
    createObjectStore(name: string) {
      if (!tables.has(name)) tables.set(name, new Map())
      return new FakeStore(name)
    }
    transaction(storeName: string) {
      return {
        objectStore: () => new FakeStore(storeName) as unknown as IDBObjectStore,
      } as unknown as IDBTransaction
    }
  }

  vi.stubGlobal('indexedDB', {
    open() {
      const req = new FakeRequest<FakeDb>()
      const db = new FakeDb()
      queueMicrotask(() => {
        req.result = db
        req.onupgradeneeded?.(new Event('upgradeneeded'))
        req._succeed(db)
      })
      return req as unknown as IDBOpenDBRequest
    },
  })

  return tables
}
