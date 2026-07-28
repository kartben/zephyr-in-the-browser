/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Force a backend regardless of whether public/qemu/ is populated. */
  readonly VITE_PTY_BACKEND?: 'mock' | 'qemu'
  /** Override the pinned Pyodide CDN index (Bluetooth / Bumble). */
  readonly VITE_PYODIDE_INDEX_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected by the qemuAssetProbe plugin in vite.config.ts. */
declare const __QEMU_ASSETS_PRESENT__: boolean
