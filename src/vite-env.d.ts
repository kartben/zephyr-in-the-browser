/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Force a backend regardless of whether public/qemu/ is populated. */
  readonly VITE_PTY_BACKEND?: 'mock' | 'qemu'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected by the qemuAssetProbe plugin in vite.config.ts. */
declare const __QEMU_ASSETS_PRESENT__: boolean
