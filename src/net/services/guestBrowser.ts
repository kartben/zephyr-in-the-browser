/**
 * In-tab "mini browser" for pages the guest serves.
 *
 * The real browser cannot reach 192.0.2.1 — that address only exists on the
 * in-page LAN — so we GET through NetStack, rewrite same-origin asset URLs
 * into blob: URLs (fetched the same way), and inject a tiny click bridge so
 * link navigations come back to the React popup for another proxied GET.
 */

import { HTTP_BROWSER_BODY_CAP, httpGetFromHost, type HttpGetResult } from './guestClient'
import { NetStack } from '../stack'

const NAV_MESSAGE = 'guest-browser-navigate'
const MAX_ASSETS = 24

export interface GuestBrowserPage {
  url: string
  status: number
  statusText: string
  contentType: string
  /** HTML suitable for iframe srcdoc (or a text fallback wrapper). */
  srcdoc: string
  /** blob: URLs created for rewritten assets — revoke when leaving the page. */
  blobUrls: string[]
}

export function isGuestBrowserNavigateMessage(
  data: unknown,
): data is { type: typeof NAV_MESSAGE; href: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === NAV_MESSAGE &&
    typeof (data as { href?: unknown }).href === 'string'
  )
}

export async function loadGuestBrowserPage(
  stack: NetStack,
  url: string,
  timeoutMs = 8000,
): Promise<GuestBrowserPage> {
  const res = await httpGetFromHost(stack, url, timeoutMs, HTTP_BROWSER_BODY_CAP)
  const contentType = (res.headers.get('content-type') ?? sniffContentType(res)).split(';')[0].trim().toLowerCase()

  if (isHtml(contentType, res.text)) {
    return materializeHtml(stack, url, res, contentType, timeoutMs)
  }

  // Non-HTML: show as plain text / hex-ish preview inside a tiny HTML shell.
  const escaped = escapeHtml(res.text.slice(0, 100_000) || `(${res.body.length} byte body)`)
  const srcdoc =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(url)}</title>` +
    `<pre style="white-space:pre-wrap;word-break:break-all;font:12px/1.4 ui-monospace,monospace;margin:1rem">` +
    `HTTP ${res.status} ${escapeHtml(res.statusText)}\n` +
    `Content-Type: ${escapeHtml(contentType || '(none)')}\n\n${escaped}</pre>`

  return {
    url,
    status: res.status,
    statusText: res.statusText,
    contentType,
    srcdoc,
    blobUrls: [],
  }
}

async function materializeHtml(
  stack: NetStack,
  pageUrl: string,
  res: HttpGetResult,
  contentType: string,
  timeoutMs: number,
): Promise<GuestBrowserPage> {
  const base = new URL(pageUrl)
  const blobUrls: string[] = []
  const cache = new Map<string, string>()
  let html = res.text

  // Absolute-ize same-document links first so the click bridge can pass a
  // real guest URL even when the iframe has no meaningful base URL.
  html = rewriteAttrUrls(html, ['href'], (raw) => {
    const abs = resolveGuestUrl(base, raw)
    return abs ?? raw
  })

  const assetAttrs = ['src', 'href'] as const
  const needed = new Set<string>()
  rewriteAttrUrls(html, assetAttrs, (raw, attr) => {
    // Stylesheets use href; skip navigational <a href> (already absolute http).
    if (attr === 'href' && !looksLikeAssetHref(raw)) return raw
    const abs = resolveGuestUrl(base, raw)
    if (abs) needed.add(abs)
    return raw
  })

  let fetched = 0
  for (const assetUrl of needed) {
    if (fetched >= MAX_ASSETS) break
    if (cache.has(assetUrl)) continue
    fetched += 1
    try {
      const asset = await httpGetFromHost(stack, assetUrl, timeoutMs, HTTP_BROWSER_BODY_CAP)
      const mime =
        (asset.headers.get('content-type') ?? guessMime(assetUrl, asset)).split(';')[0].trim() ||
        'application/octet-stream'
      // Copy off any SAB-backed view before handing to Blob.
      const copy = new Uint8Array(asset.body)
      const blobUrl = URL.createObjectURL(
        new Blob([copy.buffer as ArrayBuffer], { type: mime }),
      )
      blobUrls.push(blobUrl)
      cache.set(assetUrl, blobUrl)
    } catch {
      // Leave the original URL; the iframe simply won't load that asset.
    }
  }

  html = rewriteAttrUrls(html, assetAttrs, (raw, attr) => {
    if (attr === 'href' && !looksLikeAssetHref(raw) && !cache.has(raw)) return raw
    const abs = resolveGuestUrl(base, raw) ?? (raw.startsWith('http://') ? raw : null)
    if (!abs) return raw
    return cache.get(abs) ?? raw
  })

  const bridge =
    `<script>(function(){document.addEventListener('click',function(e){` +
    `var a=e.target&&e.target.closest&&e.target.closest('a[href]');` +
    `if(!a)return;var href=a.getAttribute('href');` +
    `if(!href||href.charAt(0)==='#'||/^(mailto|javascript):/i.test(href))return;` +
    `e.preventDefault();e.stopPropagation();` +
    `parent.postMessage({type:${JSON.stringify(NAV_MESSAGE)},href:href},'*');` +
    `},true);})();</script>`

  html = stripDangerousBase(html)
  const baseTag = `<base href="${escapeAttr(pageUrl)}">`
  let srcdoc: string
  if (/<html[\s>]/i.test(html) || /<!doctype\s+html/i.test(html)) {
    if (/<head[\s>]/i.test(html)) {
      srcdoc = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    } else {
      srcdoc = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`)
    }
    if (/<\/body>/i.test(srcdoc)) srcdoc = srcdoc.replace(/<\/body>/i, `${bridge}</body>`)
    else srcdoc += bridge
  } else {
    srcdoc =
      `<!doctype html><html><head><meta charset="utf-8">${baseTag}</head>` +
      `<body>${html}${bridge}</body></html>`
  }

  return {
    url: pageUrl,
    status: res.status,
    statusText: res.statusText,
    contentType,
    srcdoc,
    blobUrls,
  }
}

function rewriteAttrUrls(
  html: string,
  attrs: readonly string[],
  replace: (value: string, attr: string) => string,
): string {
  let out = html
  for (const attr of attrs) {
    const re = new RegExp(`(\\s${attr}\\s*=\\s*)([\"'])([^\"']*)\\2`, 'gi')
    out = out.replace(re, (_m, prefix: string, quote: string, value: string) => {
      if (/^(data:|blob:|https?:|mailto:|javascript:|#)/i.test(value)) {
        if (/^http:\/\//i.test(value)) {
          const next = replace(value, attr)
          return `${prefix}${quote}${next}${quote}`
        }
        return `${prefix}${quote}${value}${quote}`
      }
      const next = replace(value, attr)
      return `${prefix}${quote}${next}${quote}`
    })
  }
  return out
}

function resolveGuestUrl(base: URL, raw: string): string | null {
  try {
    const abs = new URL(raw, base)
    if (abs.protocol !== 'http:') return null
    // Stay on the guest host:port the page came from.
    if (abs.hostname !== base.hostname || abs.port !== base.port) return null
    return abs.href
  } catch {
    return null
  }
}

function looksLikeAssetHref(href: string): boolean {
  return /\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|#|$)/i.test(href)
}

function isHtml(contentType: string, text: string): boolean {
  if (contentType.includes('html')) return true
  if (contentType && contentType !== 'application/octet-stream') return false
  const head = text.trimStart().slice(0, 256).toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<html')
}

function sniffContentType(res: HttpGetResult): string {
  if (res.body.length >= 4) {
    // PNG / JPEG / GIF / gzip
    if (res.body[0] === 0x89 && res.body[1] === 0x50) return 'image/png'
    if (res.body[0] === 0xff && res.body[1] === 0xd8) return 'image/jpeg'
    if (res.body[0] === 0x47 && res.body[1] === 0x49) return 'image/gif'
  }
  return 'text/plain'
}

function guessMime(url: string, res: HttpGetResult): string {
  const path = new URL(url).pathname.toLowerCase()
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.ico')) return 'image/x-icon'
  if (path.endsWith('.woff2')) return 'font/woff2'
  if (path.endsWith('.woff')) return 'font/woff'
  return sniffContentType(res)
}

function stripDangerousBase(html: string): string {
  return html.replace(/<base\b[^>]*>/gi, '')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
