import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
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

/**
 * Serves a toured sample's sources in dev.
 *
 * The tours themselves need nothing from here — they are bundled with the page
 * (src/tours/catalog.ts). Their *sources* are another matter: a tour points at
 * stock Zephyr samples, whose code lives in the Zephyr workspace rather than in
 * this repo, and normally arrives with the guest images. When a workspace is at
 * hand (ZEPHYR_WS, default ~/zephyrproject) the excerpts and pattern anchors
 * work in dev too; when it is not, the tour still reads.
 *
 * Dev only. A deployment has real images, and this must never mask them.
 */
function tours(): Plugin {
  const zephyrWs = process.env.ZEPHYR_WS ?? path.join(os.homedir(), 'zephyrproject')

  /** app id → Zephyr sample path, straight out of the packaging manifest. */
  const sampleForApp = (app: string): string | null => {
    const manifest = path.join(root, 'tools', 'samples.manifest')
    if (!existsSync(manifest)) return null
    for (const line of readFileSync(manifest, 'utf8').split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue
      const [, id, sample] = line.split(':')
      if (id === app && sample) return sample.trim()
    }
    return null
  }

  return {
    name: 'zephyr-tours',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // `/qemu/zephyr/<board>/src/<app>/<file>` — board is irrelevant here,
        // since a sample's sources do not vary by machine.
        const url = (req.url ?? '').split('?')[0]
        const source = /\/qemu\/zephyr\/[^/]+\/src\/([^/]+)\/([^/]+)$/.exec(url)
        if (!source) return next()
        // A real build's artifacts win: only answer for what it has not shipped.
        if (existsSync(path.join(QEMU_ASSET_DIR, url.split('/qemu/')[1] ?? ''))) return next()

        const sample = sampleForApp(source[1]!)
        if (!sample) return next()
        const base = sample.startsWith('zephyr-module/')
          ? path.join(root, sample)
          : path.join(zephyrWs, 'zephyr', sample)
        const file = path.join(base, 'src', source[2]!)
        if (!existsSync(file)) return next()

        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(readFileSync(file))
      })
    },
  }
}

export default defineConfig({
  /*
   * GitHub Pages serves project sites from /<repo>/, so the deploy workflow
   * sets BASE_PATH. Everything that resolves an asset at runtime goes through
   * import.meta.env.BASE_URL, so this is the only place the prefix is named.
   */
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    react(),
    tailwindcss(),
    crossOriginIsolation(),
    qemuAssetProbe(),
    tours(),
  ],
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  server: {
    // Emscripten .data blobs are large; don't let Vite try to inline or watch them.
    watch: { ignored: ['**/public/qemu/**'] },
  },
})
