/**
 * Outbound HTTP: the guest dials any host on :80/:8080, the stack terminates
 * TCP and re-issues the request with fetch().
 *
 * Reality checks baked in:
 * - The page is https, so upstream requests are always upgraded to https
 *   (mixed content would be blocked). The guest still speaks plain HTTP.
 * - Reading a cross-origin body requires CORS on the upstream; hosts without
 *   it get a synthesized 502 explaining why. `host.internal` maps to a
 *   same-origin fetch and always works, including offline.
 * - Guest-side TLS (:443) cannot be proxied at all: no raw sockets.
 */

import { ipToString } from '../bytes'
import { NetStack } from '../stack'
import { TcpSocket } from '../tcp'

const BODY_CAP = 64 * 1024 // request bodies (POSTs) beyond this are refused
const BACKPRESSURE_BYTES = 64 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function installHttpProxy(stack: NetStack): void {
  const accept = (socket: TcpSocket) => handleConnection(stack, socket)
  stack.tcp.listen({ port: 80 }, accept)
  stack.tcp.listen({ port: 8080 }, accept)
}

function handleConnection(stack: NetStack, socket: TcpSocket): void {
  let buffer = new Uint8Array(0)
  let handled = false

  socket.handlers = {
    onData: (_s, data) => {
      if (handled) return
      const merged = new Uint8Array(buffer.length + data.length)
      merged.set(buffer)
      merged.set(data, buffer.length)
      buffer = merged
      if (buffer.length > 128 * 1024) {
        socket.abort()
        return
      }
      const req = tryParseRequest(buffer)
      if (req === 'incomplete') return
      handled = true
      if (req === 'malformed') {
        respondError(socket, 400, 'The proxy could not parse this HTTP request.')
        return
      }
      void forward(stack, socket, req)
    },
    onReset: () => {},
  }
}

interface ParsedRequest {
  method: string
  path: string
  host: string
  headers: Map<string, string>
  body: Uint8Array
}

function tryParseRequest(buffer: Uint8Array): ParsedRequest | 'incomplete' | 'malformed' {
  const headEnd = indexOfSeq(buffer, '\r\n\r\n')
  if (headEnd < 0) return 'incomplete'
  const head = decoder.decode(buffer.subarray(0, headEnd))
  const [requestLine, ...headerLines] = head.split('\r\n')
  const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(requestLine)
  if (!m) return 'malformed'

  const headers = new Map<string, string>()
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }

  const contentLength = Number(headers.get('content-length') ?? 0)
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > BODY_CAP) return 'malformed'
  const bodyStart = headEnd + 4
  if (buffer.length < bodyStart + contentLength) return 'incomplete'

  return {
    method: m[1],
    path: m[2],
    host: (headers.get('host') ?? '').replace(/:\d+$/, ''),
    headers,
    body: buffer.subarray(bodyStart, bodyStart + contentLength),
  }
}

async function forward(stack: NetStack, socket: TcpSocket, req: ParsedRequest): Promise<void> {
  const host = req.host || stack.nameForIp(socket.local.ip) || ipToString(socket.local.ip)
  const isInternal = host === 'host.internal' || stack.ipForName(host) === stack.gwIp
  const url = isInternal ? req.path : `https://${host}${req.path}`

  const fetchImpl = stack.hooks.fetchImpl
  if (!fetchImpl) {
    if (isInternal) {
      // Offline/mock mode still serves something friendly for host.internal.
      respondText(socket, 200, 'text/plain', 'Hello from the browser network (offline mode).\n')
    } else {
      respondError(socket, 502, `No upstream connectivity for ${host} in this environment.`)
    }
    return
  }

  try {
    const res = await fetchImpl(url, {
      method: req.method,
      headers: pickRequestHeaders(req.headers),
      // Copy into a fresh ArrayBuffer-backed view: BodyInit rejects
      // SharedArrayBuffer-backed slices (which HEAPU8 subarrays are).
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(req.body).slice(),
      signal: stack.abortSignal,
      redirect: 'follow',
    })

    const headerBlock =
      `HTTP/1.1 ${res.status} ${res.statusText || 'OK'}\r\n` +
      `content-type: ${res.headers.get('content-type') ?? 'application/octet-stream'}\r\n` +
      (res.headers.get('content-length') ? `content-length: ${res.headers.get('content-length')}\r\n` : '') +
      'connection: close\r\n\r\n'
    socket.send(encoder.encode(headerBlock))

    if (req.method !== 'HEAD' && res.body) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        socket.send(value)
        while (socket.bufferedAmount() > BACKPRESSURE_BYTES && socket.state !== 'CLOSED') {
          await sleep(20)
        }
        if (socket.state === 'CLOSED') {
          void reader.cancel()
          return
        }
      }
    }
    socket.close()
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    respondError(
      socket,
      502,
      `The browser-side proxy could not fetch ${url}\n\n${reason}\n\n` +
        'Cross-origin targets need CORS (Access-Control-Allow-Origin) for the\n' +
        'page to read the response; try host.internal, or a CORS-friendly API\n' +
        'such as jsonplaceholder.typicode.com.',
    )
  }
}

/** Forward only headers that are meaningful and CORS-safe. */
function pickRequestHeaders(headers: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['accept', 'content-type']) {
    const value = headers.get(name)
    if (value) out[name] = value
  }
  return out
}

function respondText(socket: TcpSocket, status: number, contentType: string, body: string): void {
  const bytes = encoder.encode(body)
  socket.send(
    encoder.encode(
      `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Bad Gateway'}\r\n` +
        `content-type: ${contentType}\r\ncontent-length: ${bytes.length}\r\nconnection: close\r\n\r\n`,
    ),
  )
  socket.send(bytes)
  socket.close()
}

function respondError(socket: TcpSocket, status: number, message: string): void {
  respondText(socket, status, 'text/plain; charset=utf-8', message + '\n')
}

function indexOfSeq(haystack: Uint8Array, needle: string): number {
  const n = encoder.encode(needle)
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer
    return i
  }
  return -1
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
