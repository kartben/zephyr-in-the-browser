import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))
const QEMU_ASSET_DIR = path.join(root, 'public', 'qemu')

/**
 * The main checkout's `public/qemu`, when this root is a linked worktree.
 *
 * The qemu-wasm binaries are large gitignored drop-ins, so a fresh worktree has
 * nothing but the README and the app quietly falls back to the mock backend —
 * which looks like a broken branch rather than a missing download. They do not
 * vary by branch, so dev reads the main checkout's copy instead of asking every
 * worktree to keep its own 33 MB.
 *
 * Found through git's own worktree linkage (`.git` file → `commondir`) rather
 * than a guessed path, and null for an ordinary checkout.
 */
function mainCheckoutQemuDir(): string | null {
  const dotGit = path.join(root, '.git')
  // A linked worktree's .git is a file; a normal checkout's is a directory.
  if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return null
  const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
  if (!link) return null
  const gitDir = path.resolve(root, link[1]!.trim())
  const commonDir = path.join(gitDir, 'commondir')
  if (!existsSync(commonDir)) return null
  // commondir points at the main .git; its parent is the main working tree.
  const main = path.dirname(path.resolve(gitDir, readFileSync(commonDir, 'utf8').trim()))
  const dir = path.join(main, 'public', 'qemu')
  return dir !== QEMU_ASSET_DIR && existsSync(dir) ? dir : null
}

const SHARED_QEMU_DIR = mainCheckoutQemuDir()

const hasEmulator = (dir: string | null) =>
  Boolean(dir) && existsSync(dir!) && readdirSync(dir!).some((f) => f.endsWith('.wasm'))

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
 *
 * In dev the worktree fallback counts too — those files are reachable. A build
 * only ships what is in this root, so it must not.
 */
function qemuAssetProbe(): Plugin {
  return {
    name: 'zephyr-qemu-asset-probe',
    config: (_config, { command }) => ({
      define: {
        __QEMU_ASSETS_PRESENT__: JSON.stringify(
          hasEmulator(QEMU_ASSET_DIR) || (command === 'serve' && hasEmulator(SHARED_QEMU_DIR)),
        ),
      },
    }),
  }
}

const QEMU_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.overlay': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

/**
 * Serves `/qemu/*` out of {@link mainCheckoutQemuDir} for anything this worktree
 * does not have itself.
 *
 * Dev only, and this root always wins: an image just written here by
 * `build-zephyr-image.sh` is the one under test and must never be masked by the
 * main checkout's. Registered ahead of {@link tours} so a shipped source file
 * beats the Zephyr-workspace shim, the same precedence tours applies locally.
 */
function qemuWorktreeAssets(): Plugin {
  return {
    name: 'zephyr-qemu-worktree-assets',
    apply: 'serve',
    configureServer(server) {
      const shared = SHARED_QEMU_DIR
      if (!shared) return
      server.config.logger.info(`  qemu assets: ${shared} (worktree fallback)`)

      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        const url = decodeURIComponent((req.url ?? '').split('?')[0]!)
        const rel = url.split('/qemu/')[1]
        if (!rel || existsSync(path.join(QEMU_ASSET_DIR, rel))) return next()

        const file = path.join(shared, rel)
        if (!file.startsWith(shared + path.sep)) return next()
        if (!existsSync(file) || !statSync(file).isFile()) return next()

        const size = statSync(file).size
        res.setHeader('Content-Type', QEMU_MIME[path.extname(file)] ?? 'application/octet-stream')
        res.setHeader('Accept-Ranges', 'bytes')
        // The binaries change under a running server whenever the emulator is
        // rebuilt; a stale cached .wasm is a very confusing way to find out.
        res.setHeader('Cache-Control', 'no-cache')

        // Emscripten range-requests the larger blobs rather than buffering them.
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
        const start = range?.[1] ? Number(range[1]) : 0
        const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        if (range && (start >= size || end < start)) {
          res.statusCode = 416
          res.setHeader('Content-Range', `bytes */${size}`)
          return res.end()
        }
        if (range) {
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        }
        res.setHeader('Content-Length', String(end - start + 1))
        if (req.method === 'HEAD') return res.end()
        createReadStream(file, { start, end }).pipe(res)
      })
    },
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
    qemuWorktreeAssets(),
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
