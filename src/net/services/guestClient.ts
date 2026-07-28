/**
 * The panel's tools: the page acting as a *client* dialing into servers the
 * guest runs — an HTTP GET against dumb_http_server, a TCP/UDP echo against
 * echo_server. All plumbing rides the same TcpEngine/stack as everything
 * else, so the traffic shows up in the capture like any other flow.
 *
 * Response bodies honor Content-Encoding (gzip/deflate/br) and chunked
 * Transfer-Encoding so Zephyr samples that ship precompressed static files
 * still render in the panel GET and the guest browser.
 */

import { ipFromString, ipToString } from '../bytes'
import { NetStack } from '../stack'
import { decodeHttpEntity } from './httpDecode'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** Default body cap for the panel GET tool (first ~64 KB on the wire). */
export const HTTP_GET_BODY_CAP = 64 * 1024
/** Larger wire cap for the mini-browser (sample pages + a few assets). */
export const HTTP_BROWSER_BODY_CAP = 256 * 1024

export interface HttpGetResult {
  status: number
  statusText: string
  /** Lower-cased header names (Content-Encoding stripped after decode). */
  headers: Map<string, string>
  /** Response body after transfer/content decoding (capped). */
  body: Uint8Array
  /** Decoded body as UTF-8 text. */
  text: string
}

export async function httpGetFromHost(
  stack: NetStack,
  url: string,
  timeoutMs = 8000,
  bodyCap = HTTP_GET_BODY_CAP,
): Promise<HttpGetResult> {
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
                `Host: ${parsed.hostname}\r\n` +
                `Connection: close\r\n` +
                `Accept: */*\r\n` +
                `Accept-Encoding: gzip, deflate, br\r\n\r\n`,
            ),
          )
        },
        onData: (s, data) => {
          chunks.push(data)
          if (chunks.reduce((n, c) => n + c.length, 0) > bodyCap) {
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

  return finalizeHttpResponse(parseHttpResponse(concatChunks(chunks)))
}

export function parseHttpResponse(raw: Uint8Array): HttpGetResult {
  const headEnd = indexOfSeq(raw, '\r\n\r\n')
  const headBytes = headEnd >= 0 ? raw.subarray(0, headEnd) : raw
  const body = headEnd >= 0 ? raw.subarray(headEnd + 4) : new Uint8Array(0)
  const head = decoder.decode(headBytes)
  const statusMatch = /^HTTP\/1\.[01] (\d{3})\s*(.*)/.exec(head)
  const headers = new Map<string, string>()
  if (statusMatch) {
    for (const line of head.split('\r\n').slice(1)) {
      const colon = line.indexOf(':')
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }
  }
  if (!statusMatch) {
    return {
      status: 0,
      statusText: 'malformed response',
      headers,
      body: raw,
      text: decoder.decode(raw),
    }
  }
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] || '',
    headers,
    body,
    text: decoder.decode(body),
  }
}

/** Apply chunked / Content-Encoding decoding; updates body, text, headers. */
export async function finalizeHttpResponse(res: HttpGetResult): Promise<HttpGetResult> {
  if (res.status === 0) return res
  try {
    const decoded = await decodeHttpEntity(res.body, res.headers)
    return {
      ...res,
      headers: decoded.headers,
      body: decoded.body,
      text: decoder.decode(decoded.body),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not decode HTTP body: ${reason}`)
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

function indexOfSeq(hay: Uint8Array, needle: string): number {
  const n = encoder.encode(needle)
  outer: for (let i = 0; i <= hay.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (hay[i + j] !== n[j]) continue outer
    }
    return i
  }
  return -1
}
