import { describe, expect, it } from 'vitest'
import { ipFromString, ipToString, viewOf } from '../bytes'
import { createLoopback } from '../testing/loopback'
import { installHttpProxy } from './httpProxy'
import { installEchoHost } from './echoHost'
import { installZperf, ZPERF_PORT } from './zperf'
import { echoToGuest, httpGetFromHost } from './guestClient'

describe('httpProxy', () => {
  it('proxies a guest GET through fetch with an https upgrade', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method })
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const lb = createLoopback({ fetchImpl })
    installHttpProxy(lb.stack)
    lb.guest.configureStatic('192.0.2.1')

    const res = await lb.guest.httpGet('api.example', '/status?q=1')
    // The stack also races a DoH lookup through the same fetch; ignore it.
    const proxied = calls.filter((c) => !c.url.includes('dns.google'))
    expect(proxied).toEqual([{ url: 'https://api.example/status?q=1', method: 'GET' }])
    expect(res.status).toBe(200)
    expect(res.text).toBe('{"ok":true}')
  })

  it('maps host.internal to a same-origin fetch', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return new Response('<html>sim</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }) as typeof fetch

    const lb = createLoopback({ fetchImpl })
    installHttpProxy(lb.stack)
    lb.guest.configureStatic('192.0.2.1')

    const res = await lb.guest.httpGet('host.internal', '/index.html')
    expect(calls).toEqual(['/index.html'])
    expect(res.status).toBe(200)
    expect(res.text).toBe('<html>sim</html>')
  })

  it('synthesizes a 502 when fetch fails (CORS et al.)', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch

    const lb = createLoopback({ fetchImpl })
    installHttpProxy(lb.stack)
    lb.guest.configureStatic('192.0.2.1')

    const res = await lb.guest.httpGet('blocked.example', '/')
    expect(res.status).toBe(502)
    expect(res.text).toContain('Failed to fetch')
    expect(res.text).toContain('CORS')
  })
})

describe('echoHost', () => {
  it('echoes UDP at echo.internal', async () => {
    const lb = createLoopback()
    installEchoHost(lb.stack)
    lb.guest.configureStatic('192.0.2.1')

    const echoed: string[] = []
    lb.guest.udpListen(41000, (_src, payload) => {
      echoed.push(new TextDecoder().decode(payload))
    })
    lb.guest.sendUdp(41000, lb.stack.echoIp, 7, new TextEncoder().encode('marco'))
    expect(echoed).toEqual(['marco'])
  })

  it('echoes TCP at echo.internal', async () => {
    const lb = createLoopback()
    installEchoHost(lb.stack)
    lb.guest.configureStatic('192.0.2.1')

    const got: string[] = []
    await new Promise<void>((resolve) => {
      lb.guest.connectTcp(lb.stack.echoIp, 7, {
        onOpen: (s) => s.send(new TextEncoder().encode('polo')),
        onData: (s, d) => {
          got.push(new TextDecoder().decode(d))
          s.close()
          resolve()
        },
      })
    })
    expect(got).toEqual(['polo'])
  })
})

describe('zperf sink', () => {
  it('counts an upload session and answers the FIN with a server report', () => {
    const lb = createLoopback()
    installZperf(lb.stack)
    lb.guest.configureStatic('192.0.2.1')

    const target = ipFromString('203.0.113.50')!
    const reports: Uint8Array[] = []
    lb.guest.udpListen(42000, (_src, payload) => {
      reports.push(payload)
    })

    // Five 100-byte datagrams: header id 1..5 + padding.
    for (let id = 1; id <= 5; id++) {
      const payload = new Uint8Array(100)
      const view = viewOf(payload)
      view.setInt32(0, id)
      view.setUint32(4, 0) // tv_sec
      view.setUint32(8, 0) // tv_usec
      view.setInt32(12, id) // id2
      lb.guest.sendUdp(42000, target, ZPERF_PORT, payload)
      lb.advance(10)
    }
    // FIN: negative id.
    const fin = new Uint8Array(100)
    viewOf(fin).setInt32(0, -6)
    lb.guest.sendUdp(42000, target, ZPERF_PORT, fin)

    expect(reports.length).toBe(1)
    const report = reports[0]
    expect(report.length).toBe(56)
    const view = viewOf(report)
    expect(view.getInt32(0)).toBe(-6) // echoed datagram header
    expect(view.getUint32(16)).toBe(0x80000000) // VERSION1 flag
    expect(view.getUint32(24)).toBe(500) // total_len2 = 5 × 100 B
    expect(view.getUint32(44)).toBe(5) // datagrams
    expect(view.getUint32(36)).toBe(0) // error_cnt

    // A retransmitted FIN gets the same report again.
    lb.guest.sendUdp(42000, target, ZPERF_PORT, fin)
    expect(reports.length).toBe(2)
    expect([...reports[1]]).toEqual([...report])
  })
})

describe('guestClient', () => {
  it('GETs a page from the guest HTTP server', async () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    lb.guest.serveHttp(8080, '<h1>It works</h1>')

    const res = await httpGetFromHost(lb.stack, 'http://192.0.2.1:8080/')
    expect(res.status).toBe(200)
    expect(res.text).toBe('<h1>It works</h1>')
  })

  it('echoes against the guest echo server over TCP and UDP', async () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    lb.guest.echoServer(4242)

    await expect(echoToGuest(lb.stack, 'tcp says hi', 'tcp')).resolves.toBe('tcp says hi')
    await expect(echoToGuest(lb.stack, 'udp says hi', 'udp')).resolves.toBe('udp says hi')
  })

  it('reports a refused connection', async () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    await expect(httpGetFromHost(lb.stack, 'http://192.0.2.1:8080/', 500)).rejects.toThrow(/refused/)
  })

  it('resolves names the stack has learned', async () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    lb.guest.serveHttp(8080, 'named')
    lb.stack.registerName('guest.internal', ipFromString('192.0.2.1')!)
    const res = await httpGetFromHost(lb.stack, 'http://guest.internal:8080/')
    expect(res.status).toBe(200)
    expect(ipToString(lb.stack.guestIp!)).toBe('192.0.2.1')
  })
})
