import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))
const QEMU_ASSET_DIR = path.join(root, 'public', 'qemu')

/**
 * xterm-pty runs the emulator on a Web Worker and performs *blocking* stdin
 * reads via Atomics.wait on a SharedArrayBuffer. SharedArrayBuffer is only
 * exposed to cross-origin-isolated documents, and qemu-wasm is additionally
 * built with `-pthread -sPROXY_TO_PTHREAD=1`, which requires it outright.
 *
 * Without these two headers the terminal mounts and then silently hangs the
 * moment the guest reads from stdin, so we set them on *every* response from
 * both the dev server and `vite preview`.
 *
 * See https://web.dev/coop-coep/ and public/qemu/README.md.
 */
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

function crossOriginIsolation(): Plugin {
  return {
    name: 'zephyr-cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [k, v] of Object.entries(COI_HEADERS)) res.setHeader(k, v)
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [k, v] of Object.entries(COI_HEADERS)) res.setHeader(k, v)
        next()
      })
    },
  }
}

/**
 * Detects whether real qemu-wasm artifacts have been dropped into public/qemu/.
 * The result is inlined as `__QEMU_ASSETS_PRESENT__` so the app can default to
 * the mock backend when the directory holds nothing but its README.
 */
function qemuAssetProbe(): Plugin {
  const present = () => {
    if (!existsSync(QEMU_ASSET_DIR)) return false
    return readdirSync(QEMU_ASSET_DIR).some((f) => f.endsWith('.wasm'))
  }
  return {
    name: 'zephyr-qemu-asset-probe',
    config: () => ({ define: { __QEMU_ASSETS_PRESENT__: JSON.stringify(present()) } }),
  }
}

export default defineConfig({
  /*
   * GitHub Pages serves project sites from /<repo>/, so the deploy workflow
   * sets BASE_PATH. Everything that resolves an asset at runtime goes through
   * import.meta.env.BASE_URL, so this is the only place the prefix is named.
   */
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss(), crossOriginIsolation(), qemuAssetProbe()],
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  server: {
    // Emscripten .data blobs are large; don't let Vite try to inline or watch them.
    watch: { ignored: ['**/public/qemu/**'] },
  },
})
