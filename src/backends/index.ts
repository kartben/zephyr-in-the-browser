import { createMockBackend } from './mock'
import { createQemuBackend } from './qemu'
import type { BackendId, PtyBackend } from './types'

export * from './types'

/** Set by the qemuAssetProbe plugin in vite.config.ts. */
declare const __QEMU_ASSETS_PRESENT__: boolean

export const QEMU_ASSETS_PRESENT = __QEMU_ASSETS_PRESENT__

/**
 * Backend selection, in precedence order:
 *   1. VITE_PTY_BACKEND=mock|qemu
 *   2. qemu when public/qemu/ holds a .wasm, else mock
 * The UI toggle overrides this at runtime.
 */
export function defaultBackendId(): BackendId {
  const env = import.meta.env.VITE_PTY_BACKEND
  if (env === 'mock' || env === 'qemu') return env
  return QEMU_ASSETS_PRESENT ? 'qemu' : 'mock'
}

export function createBackend(id: BackendId): PtyBackend {
  return id === 'qemu' ? createQemuBackend() : createMockBackend()
}
