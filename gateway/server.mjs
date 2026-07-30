/**
 * The uplink gateway: terminates the browser's WebSocket and gives the guest
 * a real network through passt (https://passt.top).
 *
 * The wire contract (docs/net-gateway.md): the WebSocket carries QEMU's
 * stream-netdev framing — every Ethernet frame prefixed with a u32
 * big-endian length — as a byte stream. passt speaks exactly that framing on
 * its UNIX socket, so this proxy never parses a frame: it authenticates,
 * spawns one passt per connection, and pipes bytes.
 *
 * One passt per WebSocket is load-bearing, not a convenience: every
 * zephyr-in-the-browser guest ships the same hardcoded MAC
 * (02:00:00:00:00:01), so clients must never share an L2 segment. passt's
 * --one-off flag makes the child exit with its connection, which is the
 * whole process-supervision story.
 *
 * `--mtu 1500` in the default passt flags is equally load-bearing: the
 * browser-side netdev ring drops frames over 1522 bytes, and passt's default
 * 65520-byte MTU would stall every large TCP transfer.
 */

import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, createWebSocketStream } from 'ws'

const VERSION = createRequire(import.meta.url)('./package.json').version

const PASST_SOCKET_RETRY_MS = 50
const PASST_SOCKET_TIMEOUT_MS = 3000
const CHILD_KILL_GRACE_MS = 2000
const KEEPALIVE_MS = 30_000
const SHUTDOWN_GRACE_MS = 3000

/* Close codes are part of the wire contract — the web app renders them. */
const CLOSE_UNAUTHORIZED = 4001
const CLOSE_FULL = 4002
const CLOSE_BACKEND_FAILED = 4003
const CLOSE_BACKEND_DIED = 1011
const CLOSE_GOING_AWAY = 1001

export function configFromEnv(env = process.env) {
  const port = Number(env.PORT ?? 8737)
  const maxClients = Number(env.MAX_CLIENTS ?? 8)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be a port number, got ${env.PORT}`)
  }
  if (!Number.isInteger(maxClients) || maxClients < 1) {
    throw new ConfigError(`MAX_CLIENTS must be a positive integer, got ${env.MAX_CLIENTS}`)
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    token: env.TOKEN === 'none' ? null : (env.TOKEN ?? randomBytes(16).toString('hex')),
    maxClients,
    passtBin: env.PASST_BIN ?? 'passt',
    // DNS by way of passt itself: --dns-forward makes passt answer queries at
    // 192.0.2.3 (the sandbox's DNS address, kept off the gateway address),
    // and --dns advertises that same address in DHCP leases instead of
    // copying the container's resolv.conf. The trap: --dns also REPLACES the
    // upstream list --dns-host defaults from, so without an explicit
    // --dns-host passt forwards queries to itself and every lookup times
    // out. The upstream differs per host, so it is derived from
    // /etc/resolv.conf at startup (see dnsHostArgs) rather than hardcoded.
    passtDefaultArgs: splitArgs(
      env.PASST_DEFAULT_ARGS ?? '-4 --mtu 1500 --dns-forward 192.0.2.3 --dns 192.0.2.3',
    ),
    passtExtraArgs: splitArgs(env.PASST_ARGS ?? ''),
    tunnel: env.TUNNEL === 'quick',
    pagesUrl: env.PAGES_URL ?? 'https://kartben.github.io/zephyr-in-the-browser/',
  }
}

export class ConfigError extends Error {}

/** Naive whitespace split — passt flags never need quoting. */
function splitArgs(raw) {
  return raw.split(/\s+/).filter(Boolean)
}

/** First nameserver from resolv.conf, or null when unreadable/absent. */
export function firstNameserver(path = '/etc/resolv.conf') {
  try {
    const match = readFileSync(path, 'utf8').match(/^\s*nameserver\s+(\S+)/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * The explicit upstream for --dns-forward. Required whenever --dns is in the
 * flags (it clobbers the implicit default and passt would forward to
 * itself); skipped when the user already chose a --dns-host.
 */
function dnsHostArgs(cfg) {
  const args = [...cfg.passtDefaultArgs, ...cfg.passtExtraArgs]
  if (args.includes('--dns-host')) return []
  const upstream = firstNameserver()
  return upstream ? ['--dns-host', upstream] : []
}

function tokenMatches(expected, offered) {
  if (expected === null) return true
  if (typeof offered !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(offered)
  return a.length === b.length && timingSafeEqual(a, b)
}

function fmtBytes(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`
  return `${n} B`
}

/**
 * Start the gateway. Everything is injectable for tests; `main()` below just
 * feeds it configFromEnv(). Resolves once listening, with the bound port.
 */
export async function startGateway(config, { log = (line) => console.log(line) } = {}) {
  const cfg = { ...configFromEnv({}), token: null, ...config }
  const stamp = () => new Date().toISOString()
  const say = (line) => log(`${stamp()} ${line}`)

  // One private directory per gateway process; unlinked wholesale on exit.
  const sockDir = mkdtempSync(join(tmpdir(), 'zitb-gw-'))

  let nextId = 1
  const clients = new Set()

  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ ok: true, clients: clients.size, max: cfg.maxClients, version: VERSION }),
      )
      return
    }
    if (req.url === '/' || req.url?.startsWith('/?')) {
      // Lets a pasted tunnel URL be sanity-checked in a plain browser tab.
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(
        `zephyr-in-the-browser gateway v${VERSION} — ${clients.size}/${cfg.maxClients} clients.\n` +
          'Connect a WebSocket here from the app’s Network panel.\n',
      )
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  })

  const wss = new WebSocketServer({
    server,
    path: '/',
    perMessageDeflate: false, // Ethernet frames are small and often ciphertext
    maxPayload: 1 << 20,
  })

  wss.on('connection', (ws, req) => {
    const id = nextId++
    const peer = req.socket.remoteAddress ?? '?'
    const offered = new URL(req.url ?? '/', 'http://x').searchParams.get('token')

    if (!tokenMatches(cfg.token, offered)) {
      // Complete the handshake, then close with a code: a rejected upgrade
      // would surface in the browser as an undiagnosable generic failure.
      say(`[gw] #${id} reject ${peer}: bad token`)
      ws.close(CLOSE_UNAUTHORIZED, 'unauthorized')
      return
    }
    if (clients.size >= cfg.maxClients) {
      say(`[gw] #${id} reject ${peer}: server full (${clients.size}/${cfg.maxClients})`)
      ws.close(CLOSE_FULL, 'server full')
      return
    }

    const client = connectClient({ id, peer, ws, cfg, sockDir, clients, say })
    clients.add(client)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, cfg.host, () => resolve())
  })
  const port = server.address().port
  const tunnel = cfg.tunnel ? startTunnel(port, say) : null

  const banner = () => {
    const auth = cfg.token ? `?token=${cfg.token}` : ''
    const wsUrl = `ws://localhost:${port}/${auth}`
    say(`[gw] listening on ${cfg.host}:${port} (auth: ${cfg.token ? 'token' : 'DISABLED'})`)
    say(`[gw]   WebSocket : ${wsUrl}`)
    say(`[gw]   Health    : http://localhost:${port}/healthz`)
    say(`[gw]   Open the app with it: ${cfg.pagesUrl}?net=${encodeURIComponent(wsUrl)}`)
  }
  banner()
  tunnel?.onUrl((base) => {
    const wssUrl = `${base.replace(/^https:/, 'wss:')}/${cfg.token ? `?token=${cfg.token}` : ''}`
    say(`[gw]   Tunnel    : ${wssUrl}`)
    say(`[gw]   Open the app with it: ${cfg.pagesUrl}?net=${encodeURIComponent(wssUrl)}`)
  })

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const client of [...clients]) client.teardown(CLOSE_GOING_AWAY, 'shutting down')
    tunnel?.stop()
    await new Promise((resolve) => {
      wss.close(() => server.close(() => resolve()))
      setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()
    })
    rmSync(sockDir, { recursive: true, force: true })
  }

  return { port, close, clientCount: () => clients.size }
}

/** One WebSocket ⇄ one passt. Returns a handle with an idempotent teardown. */
function connectClient({ id, peer, ws, cfg, sockDir, clients, say }) {
  const sockPath = join(sockDir, `passt-${id}.sock`)
  const started = Date.now()
  let rx = 0 // browser → passt
  let tx = 0 // passt → browser
  let sock = null
  let done = false
  let missedPongs = 0

  say(`[gw] #${id} connect ${peer} (${clients.size + 1}/${cfg.maxClients} active)`)

  const passt = spawn(
    cfg.passtBin,
    [
      ...cfg.passtDefaultArgs,
      ...cfg.passtExtraArgs,
      ...dnsHostArgs(cfg),
      '--foreground',
      '--one-off',
      '--socket',
      sockPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  passt.stderr.setEncoding('utf8')
  passt.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) say(`[passt#${id}] ${line.trim()}`)
  })

  // Created before the passt dial: frames arriving while passt is still
  // starting buffer inside the stream — without a consumer, ws would drop
  // them, eating the guest's first DHCP Discover.
  const wsStream = createWebSocketStream(ws)

  const client = {
    teardown(code, reason) {
      if (done) return
      done = true
      clients.delete(client)
      clearInterval(keepalive)
      clearTimeout(dialTimer)
      // No wsStream.destroy(): that terminates the TCP socket before the
      // close frame leaves, and the browser would see 1006 instead of `code`.
      // ws.close() below runs the closing handshake; the stream follows it.
      sock?.destroy()
      if (passt.exitCode === null && passt.signalCode === null) {
        passt.kill('SIGTERM')
        setTimeout(() => passt.kill('SIGKILL'), CHILD_KILL_GRACE_MS).unref()
      }
      try {
        ws.close(code, reason)
      } catch {
        /* already closed */
      }
      const dur = Math.round((Date.now() - started) / 1000)
      say(
        `[gw] #${id} close code=${code} rx=${fmtBytes(rx)} tx=${fmtBytes(tx)} dur=${dur}s ` +
          `(${clients.size}/${cfg.maxClients} active)`,
      )
    },
  }

  passt.on('error', (error) => {
    say(`[gw] #${id} passt spawn failed: ${error.message}`)
    client.teardown(CLOSE_BACKEND_FAILED, 'backend failed')
  })
  passt.on('exit', (exitCode, signal) => {
    if (done) return
    say(`[gw] #${id} passt exited (${signal ?? exitCode})`)
    client.teardown(sock ? CLOSE_BACKEND_DIED : CLOSE_BACKEND_FAILED, `passt exited (${signal ?? exitCode})`)
  })

  // passt binds its socket asynchronously after spawn — dial until it's there.
  const dialDeadline = Date.now() + PASST_SOCKET_TIMEOUT_MS
  let dialTimer
  const dial = () => {
    if (done) return
    const attempt = connect(sockPath)
    attempt.on('connect', () => {
      if (done) {
        attempt.destroy()
        return
      }
      sock = attempt
      say(`[gw] #${id} passt pid ${passt.pid} up, sock ${sockPath}`)
      pipe()
    })
    attempt.on('error', () => {
      attempt.destroy()
      if (done) return
      if (Date.now() > dialDeadline) {
        say(`[gw] #${id} passt socket never appeared`)
        client.teardown(CLOSE_BACKEND_FAILED, 'backend failed')
        return
      }
      dialTimer = setTimeout(dial, PASST_SOCKET_RETRY_MS)
    })
  }
  dial()

  wsStream.on('error', () => client.teardown(1000, ''))

  const pipe = () => {
    // Frames are already length-prefixed by both ends — pure byte piping,
    // with stream backpressure in both directions. The 'data' listeners ride
    // alongside pipe(): every chunk goes to both.
    wsStream.on('data', (chunk) => {
      rx += chunk.length
    })
    sock.on('data', (chunk) => {
      tx += chunk.length
    })
    sock.on('error', () => client.teardown(CLOSE_BACKEND_DIED, 'backend socket error'))
    sock.on('close', () => client.teardown(CLOSE_BACKEND_DIED, 'backend closed'))
    wsStream.pipe(sock)
    sock.pipe(wsStream)
  }

  ws.on('close', () => client.teardown(1000, ''))
  ws.on('pong', () => {
    missedPongs = 0
  })
  // Reap dead tunnel peers, whose passt would otherwise linger for hours.
  const keepalive = setInterval(() => {
    if (missedPongs >= 2) {
      say(`[gw] #${id} keepalive timeout`)
      client.teardown(1000, 'keepalive timeout')
      return
    }
    missedPongs += 1
    try {
      ws.ping()
    } catch {
      /* socket already gone; the close handler will fire */
    }
  }, KEEPALIVE_MS)

  return client
}

/** cloudflared quick tunnel: free, account-less, prints an ephemeral URL. */
function startTunnel(port, say) {
  const urlCallbacks = []
  let announced = null
  const child = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  child.on('error', (error) => {
    say(`[gw] TUNNEL=quick but cloudflared failed to start: ${error.message}`)
    process.exitCode = 1
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const match = chunk.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (match && announced === null) {
      announced = match[0]
      for (const fn of urlCallbacks) fn(announced)
    }
  })
  child.on('exit', (code) => {
    say(
      announced !== null
        ? `[gw] cloudflared exited (${code}) — tunnel is gone, local URL still up`
        : `[gw] cloudflared exited (${code}) before announcing a URL — no tunnel, local URL still up`,
    )
  })
  return {
    onUrl(fn) {
      if (announced !== null) fn(announced)
      else urlCallbacks.push(fn)
    },
    stop() {
      child.kill('SIGTERM')
    },
  }
}

/** Fail fast with a readable message instead of a mid-connection ENOENT. */
function preflight(cfg) {
  return new Promise((resolve, reject) => {
    const probe = spawn(cfg.passtBin, ['--version'], { stdio: 'ignore' })
    probe.on('error', () => {
      reject(
        new ConfigError(
          `${cfg.passtBin} not found. passt is Linux-only — on macOS/Windows run the Docker image instead ` +
            '(docker run --rm --security-opt seccomp=unconfined -p 8737:8737 ghcr.io/kartben/zephyr-in-the-browser/gateway)',
        ),
      )
    })
    probe.on('exit', () => resolve())
  })
}

/**
 * passt refuses to run when it cannot build its own sandbox (user namespace +
 * pivot_root), and Docker's default seccomp profile forbids exactly those
 * syscalls. Probe once at startup so the fix is printed immediately, instead
 * of every connection dying with an opaque 4003.
 */
function sandboxProbe(cfg) {
  return new Promise((resolve, reject) => {
    const sock = join(tmpdir(), `zitb-gw-probe-${process.pid}.sock`)
    rmSync(sock, { force: true })
    const probe = spawn(
      cfg.passtBin,
      [...cfg.passtDefaultArgs, '--foreground', '--one-off', '--socket', sock],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    probe.stderr.setEncoding('utf8')
    probe.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const done = (failure) => {
      clearTimeout(timer)
      probe.kill('SIGTERM')
      rmSync(sock, { force: true })
      if (failure) reject(failure)
      else resolve()
    }
    // Still alive after the grace period = it sandboxed fine.
    const timer = setTimeout(() => done(null), 700)
    probe.on('error', () => done(null)) // ENOENT was the version preflight's job
    probe.on('exit', () => {
      if (/user namespace|sandbox/i.test(stderr)) {
        done(
          new ConfigError(
            'passt cannot create its sandbox here: the container runtime\'s seccomp profile blocks ' +
              'the unshare/pivot_root syscalls it isolates itself with.\n' +
              'Fix: add --security-opt seccomp=unconfined to docker run. passt then applies its own, ' +
              'stricter sandbox (empty filesystem, no capabilities, dedicated seccomp filter).',
          ),
        )
      } else {
        done(null) // died for some other reason — per-connection handling will say so
      }
    })
  })
}

async function main() {
  let cfg
  try {
    cfg = configFromEnv()
    await preflight(cfg)
    await sandboxProbe(cfg)
  } catch (error) {
    console.error(error.message)
    process.exit(error instanceof ConfigError ? 2 : 1)
  }
  let gateway
  try {
    gateway = await startGateway(cfg)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  const shutdown = () => {
    gateway.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
