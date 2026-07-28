import { describe, expect, it } from 'vitest'
import { createLoopback } from '../testing/loopback'
import { loadGuestBrowserPage } from './guestBrowser'

describe('guestBrowser', () => {
  it('materializes HTML with proxied same-host assets and absolute links', async () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    lb.guest.serveHttpRoutes(8080, {
      '/': {
        body:
          '<!doctype html><html><head><link rel="stylesheet" href="style.css">' +
          '<script src="main.js"></script></head>' +
          '<body><h1 class="t">Hi</h1><a href="/about">About</a></body></html>',
        contentType: 'text/html',
      },
      '/style.css': {
        body: '.t{color:green}',
        contentType: 'text/css',
      },
      '/main.js': {
        body: 'fetch("/uptime")',
        contentType: 'text/javascript',
      },
      '/about': {
        body: '<!doctype html><html><body>About page</body></html>',
        contentType: 'text/html',
      },
    })

    const page = await loadGuestBrowserPage(lb.stack, 'http://192.0.2.1:8080/')
    expect(page.status).toBe(200)
    expect(page.srcdoc).toContain('guest-browser-navigate')
    expect(page.srcdoc).toContain('guest-browser-fetch')
    expect(page.srcdoc).toContain('guest-browser-fetch-response')
    expect(page.srcdoc).toContain('window.fetch=async function')
    expect(page.srcdoc).toContain('blob:')
    expect(page.blobUrls.length).toBe(1)
    expect(page.srcdoc).toContain('<script>fetch("/uptime")</script>')
    expect(page.srcdoc).not.toMatch(/<script[^>]+src=["']blob:/)
    expect(page.srcdoc).toContain('href="http://192.0.2.1:8080/about"')
    expect(page.srcdoc).toContain('<base href="http://192.0.2.1:8080/">')

    for (const u of page.blobUrls) URL.revokeObjectURL(u)
  })

  it('wraps non-HTML responses in a readable shell', async () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    lb.guest.serveHttpRoutes(8080, {
      '/data.json': { body: '{"ok":true}', contentType: 'application/json' },
    })

    const page = await loadGuestBrowserPage(lb.stack, 'http://192.0.2.1:8080/data.json')
    expect(page.contentType).toBe('application/json')
    expect(page.srcdoc).toContain('{"ok":true}')
    expect(page.srcdoc).toContain('HTTP 200')
    expect(page.blobUrls).toEqual([])
  })
})
