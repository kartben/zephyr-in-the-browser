import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import path from 'node:path'
import { COI_HEADERS } from './coiHeaders'

const HOST = '127.0.0.1'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.dts': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.elf': 'application/octet-stream',
  '.rom': 'application/octet-stream',
}

/** A loopback static server for one production build. */
export interface StaticServer {
  /** Origin root, with a trailing slash. */
  url: string
  host: string
  port: number
  close(): Promise<void>
}

/**
 * Serve `root` on 127.0.0.1 with the cross-origin isolation headers QEMU needs.
 *
 * Electron loads this URL. `file://` cannot carry those headers, and the COI
 * service worker does not run there, so a packaged window that opened the
 * files directly would refuse to boot the emulator.
 *
 * The port is chosen by the OS. Each launch is a fresh origin, so a rebuilt
 * `dist/` cannot be shadowed by a cached wasm blob.
 */
export async function startStaticServer(root: string): Promise<StaticServer> {
  const rootResolved = path.resolve(root)
  if (!existsSync(rootResolved)) {
    throw new Error(`Nothing to serve at ${rootResolved}. Run npm run build first.`)
  }

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      writeHead(res, 405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }

    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      writeHead(res, 400)
      res.end()
      return
    }

    const resolved = resolveInside(rootResolved, pathname)
    if (resolved.kind !== 'ok') {
      writeHead(res, resolved.kind === 'forbid' ? 403 : 404)
      res.end()
      return
    }

    const stat = statSync(resolved.file)
    writeHead(res, 200, {
      'Content-Type': contentType(resolved.file),
      'Content-Length': String(stat.size),
    })
    if (method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(resolved.file)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  })

  return new Promise((resolve, reject) => {
    const fail = (err: Error) => {
      server.close()
      reject(err)
    }
    server.once('error', fail)
    server.listen(0, HOST, () => {
      server.off('error', fail)
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        fail(new Error('static server failed to bind'))
        return
      }
      resolve({
        url: `http://${HOST}:${addr.port}/`,
        host: addr.address,
        port: addr.port,
        close: () =>
          new Promise((done, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : done()))
          }),
      })
    })
  })
}

type Resolved = { kind: 'ok'; file: string } | { kind: 'forbid' } | { kind: 'missing' }

/**
 * Map a URL path onto a file inside `root`, or refuse it.
 *
 * The lexical check runs before any filesystem access, so a `..` segment
 * cannot stat outside the tree. `realpath` then runs so a symlink that lives
 * inside the tree but points out of it is refused too.
 */
function resolveInside(root: string, requestPath: string): Resolved {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return { kind: 'forbid' }
  }
  if (decoded.includes('\0')) return { kind: 'forbid' }

  const rel = decoded.replace(/^[/\\]+/, '')
  const candidate = path.resolve(root, rel)
  if (!isInside(root, candidate)) return { kind: 'forbid' }

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(candidate)
  } catch {
    return { kind: 'missing' }
  }

  const file = stat.isDirectory() ? path.join(candidate, 'index.html') : candidate
  if (!isInside(root, file)) return { kind: 'forbid' }

  let realRoot: string
  let realFile: string
  try {
    realRoot = realpathSync(root)
    realFile = realpathSync(file)
  } catch {
    return { kind: 'missing' }
  }
  if (!isInside(realRoot, realFile)) return { kind: 'forbid' }
  return { kind: 'ok', file: realFile }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return !relative.split(path.sep).includes('..')
}

function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function writeHead(res: ServerResponse, status: number, extra?: Record<string, string>): void {
  res.writeHead(status, { ...COI_HEADERS, ...extra })
}
