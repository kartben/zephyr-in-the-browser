/**
 * Per-client passt session: translates CH_NET frames ↔ QEMU stream-netdev
 * framing on passt's unix socket. Optional — when passt is missing, net is
 * advertised as unavailable and CH_NET is ignored.
 */

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASST_SOCKET_RETRY_MS = 50
const PASST_SOCKET_TIMEOUT_MS = 3000
const CHILD_KILL_GRACE_MS = 2000
const WIRE_HDR = 4
const MIN_WIRE_FRAME = 14
const MAX_WIRE_FRAME = 2048

export function splitArgs(raw) {
  return raw.split(/\s+/).filter(Boolean)
}

export function firstNameserver(path = '/etc/resolv.conf') {
  try {
    const match = readFileSync(path, 'utf8').match(/^\s*nameserver\s+(\S+)/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export function dnsHostArgs(passtDefaultArgs, passtExtraArgs) {
  const args = [...passtDefaultArgs, ...passtExtraArgs]
  if (args.includes('--dns-host')) return []
  const upstream = firstNameserver()
  return upstream ? ['--dns-host', upstream] : []
}

/** @returns {Promise<boolean>} */
export function passtAvailable(bin = 'passt') {
  return new Promise((resolve) => {
    const probe = spawn(bin, ['--version'], { stdio: 'ignore' })
    probe.on('error', () => resolve(false))
    probe.on('exit', (code) => resolve(code === 0 || code === null))
  })
}

/**
 * Reassemble length-prefixed Ethernet frames from a byte stream.
 */
export class StreamFramer {
  constructor() {
    this.pending = null
  }

  /** @param {Buffer} chunk @returns {Buffer[]} */
  push(chunk) {
    let buf
    if (!this.pending || this.pending.length === 0) {
      buf = chunk
    } else {
      buf = Buffer.concat([this.pending, chunk])
    }
    const out = []
    let off = 0
    while (buf.length - off >= WIRE_HDR) {
      const len = buf.readUInt32BE(off)
      if (len < MIN_WIRE_FRAME || len > MAX_WIRE_FRAME) {
        this.pending = null
        throw new Error(`bad frame length ${len}`)
      }
      if (buf.length - off - WIRE_HDR < len) break
      out.push(buf.subarray(off + WIRE_HDR, off + WIRE_HDR + len))
      off += WIRE_HDR + len
    }
    this.pending = off < buf.length ? buf.subarray(off) : null
    return out
  }
}

/** @param {Buffer|Uint8Array} frame */
export function encodeWireFrame(frame) {
  const body = Buffer.isBuffer(frame) ? frame : Buffer.from(frame)
  const out = Buffer.allocUnsafe(WIRE_HDR + body.length)
  out.writeUInt32BE(body.length, 0)
  body.copy(out, WIRE_HDR)
  return out
}

/**
 * @param {{
 *   id: number,
 *   sockDir: string,
 *   passtBin: string,
 *   passtDefaultArgs: string[],
 *   passtExtraArgs: string[],
 *   onFrame: (frame: Buffer) => void,
 *   onError: (err: Error) => void,
 *   onClose: () => void,
 *   log: (line: string) => void,
 * }} opts
 */
export function startPasstSession(opts) {
  const {
    id,
    sockDir,
    passtBin,
    passtDefaultArgs,
    passtExtraArgs,
    onFrame,
    onError,
    onClose,
    log,
  } = opts

  const sockPath = join(sockDir, `passt-${id}.sock`)
  let sock = null
  let done = false
  const framer = new StreamFramer()

  const passt = spawn(
    passtBin,
    [
      ...passtDefaultArgs,
      ...passtExtraArgs,
      ...dnsHostArgs(passtDefaultArgs, passtExtraArgs),
      '--foreground',
      '--one-off',
      '--socket',
      sockPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  passt.stderr.setEncoding('utf8')
  passt.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) log(`[passt#${id}] ${line.trim()}`)
  })

  const close = () => {
    if (done) return
    done = true
    clearTimeout(dialTimer)
    sock?.destroy()
    if (passt.exitCode === null && passt.signalCode === null) {
      passt.kill('SIGTERM')
      setTimeout(() => passt.kill('SIGKILL'), CHILD_KILL_GRACE_MS).unref()
    }
  }

  passt.on('error', (error) => {
    onError(error instanceof Error ? error : new Error(String(error)))
    close()
    onClose()
  })
  passt.on('exit', () => {
    if (done) return
    close()
    onClose()
  })

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
      log(`[bridge] #${id} passt pid ${passt.pid} up`)
      sock.on('data', (chunk) => {
        try {
          for (const frame of framer.push(chunk)) onFrame(frame)
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)))
          close()
          onClose()
        }
      })
      sock.on('error', () => {
        close()
        onClose()
      })
      sock.on('close', () => {
        close()
        onClose()
      })
    })
    attempt.on('error', () => {
      attempt.destroy()
      if (done) return
      if (Date.now() > dialDeadline) {
        onError(new Error('passt socket never appeared'))
        close()
        onClose()
        return
      }
      dialTimer = setTimeout(dial, PASST_SOCKET_RETRY_MS)
    })
  }
  dial()

  return {
    /** @param {Buffer|Uint8Array} frame */
    writeFrame(frame) {
      if (done || !sock) return false
      sock.write(encodeWireFrame(frame))
      return true
    },
    close,
  }
}

export function makeSockDir() {
  return mkdtempSync(join(tmpdir(), 'zitb-bridge-'))
}

export function removeSockDir(dir) {
  rmSync(dir, { recursive: true, force: true })
}
