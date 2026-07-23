/**
 * The panel's tools: the page acting as a *client* dialing into servers the
 * guest runs — an HTTP GET against dumb_http_server, a TCP/UDP echo against
 * echo_server. All plumbing rides the same TcpEngine/stack as everything
 * else, so the traffic shows up in the capture like any other flow.
 */

import { ipFromString, ipToString } from '../bytes'
import { NetStack } from '../stack'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export interface HttpGetResult {
  status: number
  statusText: string
  /** Response body as text (first 64 KB). */
  text: string
}

export async function httpGetFromHost(stack: NetStack, url: string, timeoutMs = 8000): Promise<HttpGetResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:') throw new Error('Only http:// URLs reach the guest')

  const ip = ipFromString(parsed.hostname) ?? stack.ipForName(parsed.hostname) ?? stack.guestIp
  if (ip === null) throw new Error('Guest IP unknown — has the sample brought its interface up?')
  const port = parsed.port ? Number(parsed.port) : 80

  const chunks: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.abort()
      reject(new Error(`No response from ${ipToString(ip)}:${port} after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const socket = stack.tcp.connect(
      { ip: stack.gwIp, port: stack.allocEphemeralPort() },
      { ip, port },
      {
        onOpen: (s) => {
          s.send(
            encoder.encode(
              `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n` +
                `Host: ${parsed.hostname}\r\nConnection: close\r\nAccept: */*\r\n\r\n`,
            ),
          )
        },
        onData: (s, data) => {
          chunks.push(data)
          if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
            s.close()
            done()
          }
        },
        onRemoteClose: (s) => {
          s.close()
          done()
        },
        onClose: done,
        onReset: () => {
          clearTimeout(timer)
          if (chunks.length === 0) reject(new Error(`Connection refused by ${ipToString(ip)}:${port}`))
          else resolve()
        },
      },
    )
  })

  const raw = decoder.decode(concatChunks(chunks))
  const headEnd = raw.indexOf('\r\n\r\n')
  const statusMatch = /^HTTP\/1\.[01] (\d{3})\s*(.*)/.exec(raw)
  if (!statusMatch) return { status: 0, statusText: 'malformed response', text: raw }
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] || '',
    text: headEnd >= 0 ? raw.slice(headEnd + 4) : '',
  }
}

export async function echoToGuest(
  stack: NetStack,
  payload: string,
  proto: 'tcp' | 'udp',
  port = 4242,
  timeoutMs = 5000,
): Promise<string> {
  const guestIp = stack.guestIp
  if (guestIp === null) throw new Error('Guest IP unknown — has the sample brought its interface up?')
  const bytes = encoder.encode(payload)

  if (proto === 'udp') {
    const localPort = stack.allocEphemeralPort()
    return new Promise<string>((resolve, reject) => {
      const unlisten = stack.udpListen({ port: localPort, ip: stack.gwIp }, ({ payload: reply }) => {
        clearTimeout(timer)
        unlisten()
        resolve(decoder.decode(reply))
      })
      const timer = setTimeout(() => {
        unlisten()
        reject(new Error(`No UDP echo from ${ipToString(guestIp)}:${port} after ${timeoutMs / 1000}s`))
      }, timeoutMs)
      stack.sendUdpToGuest(stack.gwIp, localPort, guestIp, port, bytes)
    })
  }

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.abort()
      reject(new Error(`No TCP echo from ${ipToString(guestIp)}:${port} after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    const socket = stack.tcp.connect(
      { ip: stack.gwIp, port: stack.allocEphemeralPort() },
      { ip: guestIp, port },
      {
        onOpen: (s) => s.send(bytes),
        onData: (s, reply) => {
          clearTimeout(timer)
          resolve(decoder.decode(reply))
          s.close()
        },
        onReset: () => {
          clearTimeout(timer)
          reject(new Error(`Connection refused by ${ipToString(guestIp)}:${port}`))
        },
      },
    )
  })
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
