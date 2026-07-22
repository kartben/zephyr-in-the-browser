import { createMockBackend } from './mock'
import { createQemuBackend } from './qemu'
import type { BackendId, PtyBackend } from './types'

export * from './types'

/** Set by the qemuAssetProbe plugin in vite.config.ts. */
declare const __QEMU_ASSETS_PRESENT__: boolean

export const QEMU_ASSETS_PRESENT = __QEMU_ASSETS_PRESENT__

/**
 * Result of the startup probe, which supersedes QEMU_ASSETS_PRESENT.
 *
 * The build-time flag is computed when Vite starts, so it goes stale the moment
 * the artifacts are built under a server that was already running — leaving you
 * defaulted to the mock with the emulator sitting right there. Asking the server
 * cannot go stale.
 */
let detected: boolean | null = null

export async function detectQemuAssets(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}qemu/out.js`, { method: 'HEAD' })
    // A 200 proves nothing on its own: unknown paths get the SPA index.html.
    detected = res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')
  } catch {
    detected = false
  }
}

/**
 * Backend selection, in precedence order:
 *   1. VITE_PTY_BACKEND=mock|qemu
 *   2. qemu when the emulator is actually being served, else mock
 *
 * The real emulator is the point of this project, so it wins whenever it is
 * available; the mock is the fallback, not the preference. The UI toggle
 * overrides either at runtime.
 */
export function defaultBackendId(): BackendId {
  const env = import.meta.env.VITE_PTY_BACKEND
  if (env === 'mock' || env === 'qemu') return env
  return (detected ?? QEMU_ASSETS_PRESENT) ? 'qemu' : 'mock'
}

export function createBackend(id: BackendId): PtyBackend {
  return id === 'qemu' ? createQemuBackend() : createMockBackend()
}
