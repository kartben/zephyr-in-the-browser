import { gzipSync, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeHttpEntity, dechunk } from './httpDecode'
import { createLoopback } from '../testing/loopback'
import { httpGetFromHost } from './guestClient'
import { loadGuestBrowserPage } from './guestBrowser'

describe('httpDecode', () => {
  it('dechunks a transfer-encoded body', () => {
    const raw = new TextEncoder().encode('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n')
    expect(new TextDecoder().decode(dechunk(raw))).toBe('hello world')
  })

  it('inflates gzip Content-Encoding', async () => {
    const plain = '<h1>gzipped</h1>'
    const compressed = gzipSync(plain)
    const headers = new Map([
      ['content-type', 'text/html'],
      ['content-encoding', 'gzip'],
      ['content-length', String(compressed.length)],
    ])
    const out = await decodeHttpEntity(compressed, headers)
    expect(new TextDecoder().decode(out.body)).toBe(plain)
    expect(out.headers.has('content-encoding')).toBe(false)
    expect(out.headers.get('content-type')).toBe('text/html')
  })

  it('inflates deflate Content-Encoding', async () => {
    const plain = 'deflated payload'
    const compressed = deflateSync(plain)
    const out = await decodeHttpEntity(
      compressed,
      new Map([
        ['content-type', 'text/plain'],
        ['content-encoding', 'deflate'],
      ]),
    )
    expect(new TextDecoder().decode(out.body)).toBe(plain)
  })

  it('rejects unknown encodings', async () => {
    await expect(
      decodeHttpEntity(new Uint8Array([1, 2, 3]), new Map([['content-encoding', 'lzma']])),
    ).rejects.toThrow(/Unsupported Content-Encoding/)
  })
})

describe('httpGetFromHost content-encoding', () => {
  it('returns decompressed text for gzip guest responses', async () => {
    const html = '<!doctype html><html><body><h1>Zephyr</h1></body></html>'
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    lb.guest.serveHttpRoutes(8080, {
      '/': {
        body: gzipSync(html),
        contentType: 'text/html',
        contentEncoding: 'gzip',
      },
    })

    const res = await httpGetFromHost(lb.stack, 'http://192.0.2.1:8080/')
    expect(res.status).toBe(200)
    expect(res.text).toBe(html)
    expect(res.headers.has('content-encoding')).toBe(false)
  })
})

describe('guestBrowser gzip', () => {
  it('renders gzip-encoded HTML from the guest', async () => {
    const html =
      '<!doctype html><html><head></head><body><p id="ok">hello gzip</p></body></html>'
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    lb.guest.serveHttpRoutes(8080, {
      '/': {
        body: gzipSync(html),
        contentType: 'text/html',
        contentEncoding: 'gzip',
      },
    })

    const page = await loadGuestBrowserPage(lb.stack, 'http://192.0.2.1:8080/')
    expect(page.srcdoc).toContain('hello gzip')
    expect(page.srcdoc).not.toMatch(/^\x1f\x8b/)
  })
})
