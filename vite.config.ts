import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
 * Serves annotation artifacts for the repo's own guided samples in dev.
 *
 * tools/build-zephyr-image.sh emits `<app>.annotations.json` and the stripped
 * sources next to each ELF, but that needs a containerised Zephyr build. A
 * checkout with no images still lands on the mock backend, and the mock can
 * replay a walkthrough — so run the extractor on demand and answer the same
 * asset URLs from its output.
 *
 * Dev only. A deployment has real images, and this must never mask them.
 */
function guidedAnnotations(): Plugin {
  const APPS = [{ id: 'guided', dir: path.join(root, 'zephyr-module', 'apps', 'guided_blinky') }]
  const out = path.join(root, 'node_modules', '.zephyr-annotations')

  const generate = (app: (typeof APPS)[number]) => {
    const sources = readdirSync(path.join(app.dir, 'src'))
      .filter((f) => f.endsWith('.c'))
      .flatMap((f) => ['--source', path.join(app.dir, 'src', f)])
    const dest = path.join(out, app.id)
    const result = spawnSync(
      'python3',
      [
        path.join(root, 'tools', 'extract-annotations.py'),
        '--app', app.id,
        '--source-root', app.dir,
        ...sources,
        '--out-header', path.join(dest, 'generated.h'),
        '--out-json', path.join(dest, 'annotations.json'),
        '--out-src-dir', path.join(dest, 'display'),
      ],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) {
      // Not fatal: without this the walkthrough simply does not appear in dev.
      console.warn(`[annotations] ${app.id}: ${result.stderr?.trim() || 'extractor failed'}`)
    }
  }

  return {
    name: 'zephyr-guided-annotations',
    apply: 'serve',
    configureServer(server) {
      for (const app of APPS) generate(app)

      // Regenerate when a guided sample is edited, so a reload shows the change.
      server.watcher.on('change', (file) => {
        const app = APPS.find((a) => file.startsWith(a.dir))
        if (app) generate(app)
      })

      server.middlewares.use((req, res, next) => {
        // `/qemu/zephyr/<board>/<app>.annotations.json` and
        // `/qemu/zephyr/<board>/src/<app>/<file>` — board is irrelevant here,
        // since an in-repo sample's annotations do not vary by machine.
        const url = (req.url ?? '').split('?')[0]
        const json = /\/qemu\/zephyr\/[^/]+\/([^/]+)\.annotations\.json$/.exec(url)
        const source = /\/qemu\/zephyr\/[^/]+\/src\/([^/]+)\/(.+)$/.exec(url)
        const app = APPS.find((a) => a.id === (json?.[1] ?? source?.[1]))
        if (!app) return next()

        const file = json
          ? path.join(out, app.id, 'annotations.json')
          : path.join(out, app.id, 'display', source![2])
        // A real build's artifacts win: only answer for what it has not shipped.
        if (existsSync(path.join(QEMU_ASSET_DIR, url.split('/qemu/')[1] ?? '')) || !existsSync(file)) {
          return next()
        }
        res.setHeader('Content-Type', json ? 'application/json' : 'text/plain; charset=utf-8')
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
    guidedAnnotations(),
  ],
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  server: {
    // Emscripten .data blobs are large; don't let Vite try to inline or watch them.
    watch: { ignored: ['**/public/qemu/**'] },
  },
})
