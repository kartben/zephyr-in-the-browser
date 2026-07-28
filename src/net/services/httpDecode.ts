/**
 * Decode HTTP response bodies the guest may send compressed (Zephyr's
 * http_server sample ships static HTML/JS as gzip). Uses the platform
 * DecompressionStream — same path in the browser and in vitest/Node 22+.
 */

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** Cap on bytes after decompression (compressed wire bodies stay bodyCap-sized). */
export const HTTP_DECODE_BODY_CAP = 1024 * 1024

const SUPPORTED = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'identity'])

export async function decodeHttpEntity(
  body: Uint8Array,
  headers: Map<string, string>,
  decompressCap = HTTP_DECODE_BODY_CAP,
): Promise<{ body: Uint8Array; headers: Map<string, string> }> {
  const next = new Map(headers)
  let bytes = body

  const transfer = (headers.get('transfer-encoding') ?? '').toLowerCase()
  if (transfer.split(',').some((t) => t.trim() === 'chunked')) {
    bytes = dechunk(bytes)
    next.delete('transfer-encoding')
    next.delete('content-length')
  }

  const encoding = (headers.get('content-encoding') ?? '').trim()
  if (!encoding || encoding.toLowerCase() === 'identity') {
    return { body: bytes, headers: next }
  }

  const layers = encoding
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .reverse()

  for (const layer of layers) {
    if (layer === 'identity') continue
    if (!SUPPORTED.has(layer)) {
      throw new Error(`Unsupported Content-Encoding: ${encoding}`)
    }
    if (layer === 'gzip' || layer === 'x-gzip') {
      bytes = await inflate(bytes, 'gzip', decompressCap)
    } else if (layer === 'deflate') {
      // Some stacks send raw DEFLATE, others zlib-wrapped; try zlib first.
      try {
        bytes = await inflate(bytes, 'deflate', decompressCap)
      } catch {
        bytes = await inflate(bytes, 'deflate-raw', decompressCap)
      }
    } else if (layer === 'br') {
      bytes = await inflate(bytes, 'br', decompressCap)
    }
  }

  next.delete('content-encoding')
  next.delete('content-length')
  return { body: bytes, headers: next }
}

export function dechunk(body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = []
  let offset = 0
  while (offset < body.length) {
    const lineEnd = indexOfSeq(body, offset, '\r\n')
    if (lineEnd < 0) throw new Error('Truncated chunked body (size line)')
    const sizeLine = decoder.decode(body.subarray(offset, lineEnd)).split(';', 1)[0].trim()
    const size = Number.parseInt(sizeLine, 16)
    if (!Number.isFinite(size) || size < 0) throw new Error(`Bad chunk size: ${sizeLine}`)
    offset = lineEnd + 2
    if (size === 0) break
    if (offset + size > body.length) throw new Error('Truncated chunked body (data)')
    parts.push(body.subarray(offset, offset + size))
    offset += size
    if (body[offset] === 0x0d && body[offset + 1] === 0x0a) offset += 2
    else throw new Error('Truncated chunked body (CRLF)')
  }
  return concat(parts)
}

async function inflate(
  input: Uint8Array,
  format: CompressionFormat | 'br',
  cap: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(`DecompressionStream unavailable; cannot decode ${format}`)
  }
  // Copy off SAB-backed views — streams reject SharedArrayBuffer.
  // 'br' is widely supported at runtime but missing from older CompressionFormat unions.
  const copy = new Uint8Array(input)
  const stream = new Blob([copy.buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream(format as CompressionFormat))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      throw new Error(`Decompressed body exceeds ${cap} bytes`)
    }
    chunks.push(value)
  }
  return concat(chunks)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function indexOfSeq(hay: Uint8Array, from: number, needle: string): number {
  const n = encoder.encode(needle)
  outer: for (let i = from; i <= hay.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (hay[i + j] !== n[j]) continue outer
    }
    return i
  }
  return -1
}
