/**
 * Uber bridge: serial CTF + optional GDB RSP + optional passt networking over
 * one WebSocket for Zephyr in the Browser.
 *
 * Unlike the standalone net gateway, this process is meant to stay up forever:
 * probes and serial ports come and go; clients reconnect; passt runs per client.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import {
  CH_CTF,
  CH_CTRL,
  CH_GDB,
  CH_NET,
  CLOSE_BACKEND_DIED,
  CLOSE_FULL,
  CLOSE_GOING_AWAY,
  CLOSE_UNAUTHORIZED,
  decodeCtrl,
  decodeFrame,
  encodeCtrl,
  encodeFrame,
} from './protocol.mjs'
import { listPorts, openSerialStream } from './serial.mjs'
import { openGdbProxy } from './gdbProxy.mjs'
import {
  makeSockDir,
  passtAvailable,
  removeSockDir,
  splitArgs,
  startPasstSession,
} from './net.mjs'

const VERSION = createRequire(import.meta.url)('./package.json').version

const KEEPALIVE_MS = 30_000
const PORT_POLL_MS = 2000
const SHUTDOWN_GRACE_MS = 3000
const DEFAULT_BAUD = 115200
const DEFAULT_GDB_PORT = 3333

export class ConfigError extends Error {}

export function configFromEnv(env = process.env) {
  const port = Number(env.PORT ?? 8740)
  const maxClients = Number(env.MAX_CLIENTS ?? 8)
  const baudRate = Number(env.BAUD ?? DEFAULT_BAUD)
  const gdbPort = env.GDB_PORT ? Number(env.GDB_PORT) : DEFAULT_GDB_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be a port number, got ${env.PORT}`)
  }
  if (!Number.isInteger(maxClients) || maxClients < 1) {
    throw new ConfigError(`MAX_CLIENTS must be a positive integer, got ${env.MAX_CLIENTS}`)
  }
  if (!Number.isInteger(baudRate) || baudRate < 1) {
    throw new ConfigError(`BAUD must be a positive integer, got ${env.BAUD}`)
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    token: env.TOKEN === 'none' ? null : (env.TOKEN ?? randomBytes(16).toString('hex')),
    maxClients,
    baudRate,
    serialPath: env.SERIAL ?? null,
    gdbHost: env.GDB_HOST ?? '127.0.0.1',
    gdbPort: Number.isInteger(gdbPort) ? gdbPort : DEFAULT_GDB_PORT,
    pagesUrl: env.PAGES_URL ?? 'https://kartben.github.io/zephyr-in-the-browser/',
    noTui: env.NO_TUI === '1' || env.NO_TUI === 'true',
    passtBin: env.PASST_BIN ?? 'passt',
    passtDefaultArgs: splitArgs(
      env.PASST_DEFAULT_ARGS ?? '-4 --mtu 1500 --dns-forward 192.0.2.3 --dns 192.0.2.3',
    ),
    passtExtraArgs: splitArgs(env.PASST_ARGS ?? ''),
    enableNet: env.DISABLE_NET !== '1',
    autoSerial: env.AUTO_SERIAL !== '0',
  }
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
 * @param {ReturnType<typeof configFromEnv>} config
 * @param {{
 *   log?: (line: string) => void,
 *   listPortsFn?: typeof listPorts,
 *   openSerialFn?: typeof openSerialStream,
 *   openGdbFn?: typeof openGdbProxy,
 *   passtAvailableFn?: typeof passtAvailable,
 *   startPasstSessionFn?: typeof startPasstSession,
 *   now?: () => number,
 * }} [hooks]
 */
export async function startBridge(config, hooks = {}) {
  const cfg = { ...configFromEnv({}), token: null, ...config }
  const listPortsFn = hooks.listPortsFn ?? listPorts
  const openSerialFn = hooks.openSerialFn ?? openSerialStream
  const openGdbFn = hooks.openGdbFn ?? openGdbProxy
  const passtAvailableFn = hooks.passtAvailableFn ?? passtAvailable
  const startPasstSessionFn = hooks.startPasstSessionFn ?? startPasstSession
  const say = hooks.log ?? ((line) => console.log(line))
  const stamp = () => new Date().toISOString()
  const log = (line) => say(`${stamp()} ${line}`)

  let netReady = false
  /** @type {string | null} */
  let sockDir = null
  if (cfg.enableNet) {
    netReady = await passtAvailableFn(cfg.passtBin)
    if (netReady) {
      sockDir = makeSockDir()
      log(`[bridge] passt available — net enabled`)
    } else {
      log(`[bridge] passt not found — net disabled`)
    }
  } else {
    log(`[bridge] net disabled (DISABLE_NET=1)`)
  }

  /** @type {import('./serial.mjs').PortInfo[]} */
  let ports = []
  /** @type {ReturnType<typeof openSerialStream> | null} */
  let serial = null
  /** @type {ReturnType<typeof openGdbProxy> | null} */
  let gdb = null
  let ctfBytes = 0
  let gdbBytes = 0
  let serialPhase = 'idle' // idle | streaming | error
  let serialDetail = ''
  let gdbPhase = 'idle' // idle | connected | error
  let gdbDetail = ''
  let nextId = 1
  const clients = new Set()
  /** @type {Set<(snap: object) => void>} */
  const statusListeners = new Set()

  const snapshot = () => ({
    version: VERSION,
    protocol: 'zitb-bridge',
    features: { ctf: true, gdb: true, net: netReady },
    net: { ready: netReady },
    ports,
    serial: serial
      ? { path: serial.path, baudRate: serial.baudRate, phase: serialPhase, detail: serialDetail }
      : { path: null, baudRate: cfg.baudRate, phase: serialPhase, detail: serialDetail },
    gdb: {
      host: cfg.gdbHost,
      port: cfg.gdbPort,
      phase: gdbPhase,
      detail: gdbDetail,
    },
    clients: clients.size,
    maxClients: cfg.maxClients,
    ctfBytes,
    gdbBytes,
  })

  const notifyStatus = () => {
    const snap = snapshot()
    for (const fn of statusListeners) fn(snap)
  }

  const broadcastCtrl = (obj) => {
    const frame = encodeCtrl(obj)
    for (const c of clients) c.sendRaw(frame)
  }

  const broadcastCtf = (chunk) => {
    ctfBytes += chunk.length
    const frame = encodeFrame(CH_CTF, chunk)
    for (const c of clients) c.sendRaw(frame)
    notifyStatus()
  }

  const broadcastGdb = (chunk) => {
    gdbBytes += chunk.length
    const frame = encodeFrame(CH_GDB, chunk)
    for (const c of clients) c.sendRaw(frame)
    notifyStatus()
  }

  const pushHello = (send) => {
    send(
      encodeCtrl({
        type: 'hello',
        version: 1,
        bridge: VERSION,
        protocol: 'zitb-bridge',
        features: { ctf: true, gdb: true, net: netReady },
        ports,
        serial: snapshot().serial,
        gdb: snapshot().gdb,
      }),
    )
  }

  const refreshPorts = async () => {
    try {
      ports = await listPortsFn()
      broadcastCtrl({ type: 'ports', ports })
      notifyStatus()
      if (cfg.autoSerial && !serial && ports.length === 1) {
        startSerial(ports[0].path)
      }
    } catch (err) {
      log(`[bridge] list ports failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  const stopSerial = (reason = '') => {
    if (serial) {
      serial.close()
      serial = null
    }
    serialPhase = reason ? 'error' : 'idle'
    serialDetail = reason
    broadcastCtrl({ type: 'serial-status', ...snapshot().serial })
    notifyStatus()
  }

  const startSerial = (path, baudRate = cfg.baudRate) => {
    if (!path) return
    stopSerial()
    serialPhase = 'streaming'
    serialDetail = ''
    log(`[bridge] opening ${path} @ ${baudRate}`)
    serial = openSerialFn({
      path,
      baudRate,
      onData: (chunk) => broadcastCtf(chunk),
      onError: (err) => {
        log(`[bridge] serial error: ${err.message}`)
        stopSerial(err.message)
      },
      onClose: () => {
        log(`[bridge] serial closed (${path})`)
        if (serial?.path === path) {
          serial = null
          serialPhase = 'idle'
          serialDetail = 'port closed'
          broadcastCtrl({ type: 'serial-status', ...snapshot().serial })
          notifyStatus()
        }
      },
    })
    broadcastCtrl({ type: 'serial-status', ...snapshot().serial })
    notifyStatus()
  }

  const stopGdb = (reason = '') => {
    if (gdb) {
      gdb.close()
      gdb = null
    }
    gdbPhase = reason ? 'error' : 'idle'
    gdbDetail = reason
    broadcastCtrl({ type: 'gdb-status', ...snapshot().gdb })
    notifyStatus()
  }

  const startGdb = (host = cfg.gdbHost, port = cfg.gdbPort) => {
    stopGdb()
    gdbPhase = 'connected'
    gdbDetail = ''
    cfg.gdbHost = host
    cfg.gdbPort = port
    log(`[bridge] GDB proxy → ${host}:${port}`)
    gdb = openGdbFn({
      host,
      port,
      onData: (chunk) => broadcastGdb(chunk),
      onError: (err) => {
        log(`[bridge] GDB error: ${err.message}`)
        stopGdb(err.message)
      },
      onClose: () => {
        log(`[bridge] GDB closed`)
        if (gdbPhase === 'connected') {
          gdb = null
          gdbPhase = 'idle'
          gdbDetail = 'gdb server closed'
          broadcastCtrl({ type: 'gdb-status', ...snapshot().gdb })
          notifyStatus()
        }
      },
    })
    broadcastCtrl({ type: 'gdb-status', ...snapshot().gdb })
    notifyStatus()
  }

  const handleCtrl = (client, msg) => {
    switch (msg.type) {
      case 'select-serial': {
        const path = typeof msg.path === 'string' ? msg.path : null
        const baud = Number(msg.baudRate ?? cfg.baudRate)
        if (!path) {
          stopSerial()
          return
        }
        startSerial(path, Number.isFinite(baud) ? baud : cfg.baudRate)
        return
      }
      case 'stop-serial':
        stopSerial()
        return
      case 'gdb-attach': {
        const host = typeof msg.host === 'string' ? msg.host : cfg.gdbHost
        const port = Number(msg.port ?? cfg.gdbPort)
        startGdb(host, Number.isInteger(port) ? port : cfg.gdbPort)
        return
      }
      case 'gdb-detach':
        stopGdb()
        return
      case 'list-ports':
        void refreshPorts()
        return
      case 'ping':
        client.sendRaw(encodeCtrl({ type: 'pong', t: msg.t ?? Date.now() }))
        return
      default:
        log(`[bridge] #${client.id} unknown ctrl ${msg.type}`)
    }
  }

  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...snapshot() }))
      return
    }
    if (req.url === '/' || req.url?.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(
        `zephyr-in-the-browser bridge v${VERSION} — ${clients.size}/${cfg.maxClients} clients.\n` +
          'Connect a WebSocket from the app’s Trace panel (Live board).\n',
      )
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  })

  const wss = new WebSocketServer({
    server,
    path: '/',
    perMessageDeflate: false,
    maxPayload: 1 << 20,
  })

  wss.on('connection', (ws, req) => {
    const id = nextId++
    const peer = req.socket.remoteAddress ?? '?'
    const offered = new URL(req.url ?? '/', 'http://x').searchParams.get('token')

    if (!tokenMatches(cfg.token, offered)) {
      log(`[bridge] #${id} reject ${peer}: bad token`)
      ws.close(CLOSE_UNAUTHORIZED, 'unauthorized')
      return
    }
    if (clients.size >= cfg.maxClients) {
      log(`[bridge] #${id} reject ${peer}: server full`)
      ws.close(CLOSE_FULL, 'server full')
      return
    }

    let missedPongs = 0
    let done = false
    const started = Date.now()
    /** @type {ReturnType<typeof startPasstSession> | null} */
    let passt = null
    let netPhase = 'idle' // idle | connected | error
    let netDetail = ''

    const sendNetStatus = () => {
      client.sendRaw(encodeCtrl({ type: 'net-status', phase: netPhase, detail: netDetail }))
    }

    const stopPasst = () => {
      if (passt) {
        passt.close()
        passt = null
      }
    }

    const setNetError = (reason) => {
      netPhase = 'error'
      netDetail = reason
      stopPasst()
      sendNetStatus()
    }

    const client = {
      id,
      sendRaw(buf) {
        if (done || ws.readyState !== ws.OPEN) return
        try {
          ws.send(buf)
        } catch {
          /* closing */
        }
      },
      teardown(code, reason) {
        if (done) return
        done = true
        stopPasst()
        clients.delete(client)
        clearInterval(keepalive)
        try {
          ws.close(code, reason)
        } catch {
          /* already closed */
        }
        const dur = Math.round((Date.now() - started) / 1000)
        log(
          `[bridge] #${id} close code=${code} ctf=${fmtBytes(ctfBytes)} dur=${dur}s ` +
            `(${clients.size}/${cfg.maxClients} active)`,
        )
        notifyStatus()
      },
    }

    clients.add(client)
    log(`[bridge] #${id} connect ${peer} (${clients.size}/${cfg.maxClients} active)`)
    notifyStatus()
    pushHello((frame) => client.sendRaw(frame))

    if (netReady && sockDir) {
      netPhase = 'connected'
      netDetail = ''
      passt = startPasstSessionFn({
        id,
        sockDir,
        passtBin: cfg.passtBin,
        passtDefaultArgs: cfg.passtDefaultArgs,
        passtExtraArgs: cfg.passtExtraArgs,
        onFrame: (frame) => client.sendRaw(encodeFrame(CH_NET, frame)),
        onError: (err) => {
          log(`[bridge] #${id} passt error: ${err.message}`)
          setNetError(err.message)
        },
        onClose: () => {
          if (netPhase === 'connected') {
            log(`[bridge] #${id} passt closed`)
            setNetError('passt closed')
          }
        },
        log,
      })
      sendNetStatus()
    }

    ws.on('message', (data, isBinary) => {
      if (done) return
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data)
      // Accept either framed binary or raw JSON text for simple tools.
      if (!isBinary) {
        try {
          handleCtrl(client, JSON.parse(raw.toString('utf8')))
        } catch (err) {
          log(`[bridge] #${id} bad text ctrl: ${err instanceof Error ? err.message : err}`)
        }
        return
      }
      const frame = decodeFrame(raw)
      if (!frame) return
      if (frame.channel === CH_CTRL) {
        try {
          handleCtrl(client, decodeCtrl(frame.payload))
        } catch (err) {
          log(`[bridge] #${id} bad ctrl: ${err instanceof Error ? err.message : err}`)
        }
        return
      }
      if (frame.channel === CH_GDB) {
        if (!gdb || gdbPhase !== 'connected') return
        gdb.write(frame.payload)
        return
      }
      if (frame.channel === CH_NET) {
        if (!passt || netPhase !== 'connected') return
        passt.writeFrame(frame.payload)
        return
      }
    })

    ws.on('close', () => client.teardown(1000, ''))
    ws.on('error', () => client.teardown(CLOSE_BACKEND_DIED, 'socket error'))
    ws.on('pong', () => {
      missedPongs = 0
    })

    const keepalive = setInterval(() => {
      if (missedPongs >= 2) {
        client.teardown(1000, 'keepalive timeout')
        return
      }
      missedPongs += 1
      try {
        ws.ping()
      } catch {
        /* gone */
      }
    }, KEEPALIVE_MS)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, cfg.host, () => resolve())
  })
  const boundPort = server.address().port

  await refreshPorts()
  if (cfg.serialPath) startSerial(cfg.serialPath, cfg.baudRate)

  const portTimer = setInterval(() => void refreshPorts(), PORT_POLL_MS)
  if (typeof portTimer.unref === 'function') portTimer.unref()

  const auth = cfg.token ? `?token=${cfg.token}` : ''
  const wsUrl = `ws://localhost:${boundPort}/${auth}`
  log(`[bridge] listening on ${cfg.host}:${boundPort} (auth: ${cfg.token ? 'token' : 'DISABLED'})`)
  log(`[bridge]   WebSocket : ${wsUrl}`)
  log(`[bridge]   Health    : http://localhost:${boundPort}/healthz`)
  log(`[bridge]   Open the app with it: ${cfg.pagesUrl}?bridge=${encodeURIComponent(wsUrl)}`)

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    clearInterval(portTimer)
    stopSerial()
    stopGdb()
    for (const c of [...clients]) c.teardown(CLOSE_GOING_AWAY, 'shutting down')
    await new Promise((resolve) => {
      wss.close(() => server.close(() => resolve()))
      setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()
    })
    if (sockDir) removeSockDir(sockDir)
  }

  return {
    port: boundPort,
    wsUrl,
    close,
    snapshot,
    subscribeStatus(fn) {
      statusListeners.add(fn)
      fn(snapshot())
      return () => statusListeners.delete(fn)
    },
    selectSerial: startSerial,
    stopSerial,
    attachGdb: startGdb,
    detachGdb: stopGdb,
    refreshPorts,
    clientCount: () => clients.size,
    /** @deprecated test helper */
    _test: { broadcastCtf, broadcastCtrl },
  }
}

/** @deprecated use startBridge */
export const startProbeBridge = startBridge

export { fmtBytes, VERSION }
