import { createMockBackend } from './mock'
import { createQemuBackend } from './qemu'
import type { BackendId, PtyBackend } from './types'
import { BOARDS } from '@/boards'

export * from './types'

/** Set by the qemuAssetProbe plugin in vite.config.ts. */
declare const __QEMU_ASSETS_PRESENT__: boolean

export const QEMU_ASSETS_PRESENT = __QEMU_ASSETS_PRESENT__

// Runtime probe result; the Vite-time flag goes stale when artifacts appear after server start.
let detected: boolean | null = null

export async function detectQemuAssets(): Promise<void> {
  try {
    const binaries = [...new Set(BOARDS.map((board) => board.qemuBinary))]
    const responses = await Promise.all(
      binaries.map((binary) =>
        fetch(`${import.meta.env.BASE_URL}qemu/${binary}.js`, { method: 'HEAD' }),
      ),
    )
    // A 200 can still be the SPA index.html for an unknown path.
    detected = responses.some(
      (res) => res.ok && !(res.headers.get('content-type') ?? '').includes('text/html'),
    )
  } catch {
    detected = false
  }
}

export function defaultBackendId(): BackendId {
  const env = import.meta.env.VITE_PTY_BACKEND
  if (env === 'mock' || env === 'qemu') return env
  return (detected ?? QEMU_ASSETS_PRESENT) ? 'qemu' : 'mock'
}

export function createBackend(id: BackendId): PtyBackend {
  return id === 'qemu' ? createQemuBackend() : createMockBackend()
}
