import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Globe, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  GUEST_BROWSER_FETCH_RESPONSE_MESSAGE,
  isGuestBrowserFetchMessage,
  isGuestBrowserNavigateMessage,
} from '@/net/services/guestBrowser'
import { httpRequestFromHost, loadGuestBrowserPage } from '@/hostNet'

/**
 * Popup that renders pages served by the guest over the in-page LAN.
 * Assets and link clicks are proxied through NetStack in JavaScript — the
 * real browser never dials 192.0.2.1 itself.
 */
export function GuestBrowserDialog({
  open,
  onOpenChange,
  initialUrl,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialUrl: string
}) {
  const [address, setAddress] = useState(initialUrl)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [history, setHistory] = useState<string[]>([])
  const [srcdoc, setSrcdoc] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const blobUrlsRef = useRef<string[]>([])
  const currentUrlRef = useRef(currentUrl)
  currentUrlRef.current = currentUrl

  const revokeBlobs = () => {
    for (const u of blobUrlsRef.current) URL.revokeObjectURL(u)
    blobUrlsRef.current = []
  }

  const navigateRef = useRef(async (_url: string, _opts: { pushHistory: boolean }) => {})
  navigateRef.current = async (url: string, opts: { pushHistory: boolean }) => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const page = await loadGuestBrowserPage(url)
      revokeBlobs()
      blobUrlsRef.current = page.blobUrls
      if (opts.pushHistory && currentUrlRef.current && currentUrlRef.current !== page.url) {
        setHistory((h) => [...h, currentUrlRef.current])
      }
      setCurrentUrl(page.url)
      setAddress(page.url)
      setSrcdoc(page.srcdoc)
      setStatus(`HTTP ${page.status} ${page.statusText}`.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSrcdoc('')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open) {
      revokeBlobs()
      setSrcdoc('')
      setError(null)
      setStatus(null)
      setHistory([])
      return
    }
    setAddress(initialUrl)
    setCurrentUrl(initialUrl)
    setHistory([])
    void navigateRef.current(initialUrl, { pushHistory: false })
  }, [open, initialUrl])

  useEffect(() => {
    if (!open) return
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow
      if (!frame || event.source !== frame) return
      if (isGuestBrowserNavigateMessage(event.data)) {
        void navigateRef.current(event.data.href, { pushHistory: true })
        return
      }
      if (!isGuestBrowserFetchMessage(event.data)) return

      const request = event.data
      void (async () => {
        try {
          const page = new URL(currentUrlRef.current)
          const target = new URL(request.url, page)
          if (target.protocol !== 'http:' || target.host !== page.host) {
            throw new Error('Guest pages may only fetch from their own host')
          }
          const response = await httpRequestFromHost(target.href, {
            method: request.method,
            headers: request.headers,
            body: new Uint8Array(request.body),
          })
          frame.postMessage(
            {
              type: GUEST_BROWSER_FETCH_RESPONSE_MESSAGE,
              id: request.id,
              status: response.status,
              statusText: response.statusText,
              headers: Array.from(response.headers.entries()),
              body: Array.from(response.body),
            },
            '*',
          )
        } catch (error) {
          frame.postMessage(
            {
              type: GUEST_BROWSER_FETCH_RESPONSE_MESSAGE,
              id: request.id,
              error: error instanceof Error ? error.message : String(error),
            },
            '*',
          )
        }
      })()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open])

  useEffect(() => () => revokeBlobs(), [])

  const goBack = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    void navigateRef.current(prev, { pushHistory: false })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        data-guest-browser
        showOverlay={false}
        className="h-[min(90vh,44rem)] max-w-4xl gap-0 p-0"
        // Keep this as a floating browser rather than a light-dismiss popover:
        // the simulator remains interactive behind it, and only its close
        // button or Escape while focus is inside the browser closes it.
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          const active = document.activeElement
          if (!(active instanceof Element) || !active.closest('[data-guest-browser]')) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader className="border-b border-border px-4 pb-3 pr-12 pt-4">
          <DialogTitle className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" aria-hidden />
            Guest browser
          </DialogTitle>
          <DialogDescription>
            Pages from the guest, fetched over the in-page LAN. Link clicks and same-host assets
            are proxied in JavaScript.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Back"
            disabled={busy || history.length === 0}
            onClick={goBack}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Reload"
            disabled={busy || !currentUrl}
            onClick={() => void navigateRef.current(currentUrl, { pushHistory: false })}
          >
            <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
          </Button>
          <input
            type="text"
            aria-label="Guest URL"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && address.trim()) {
                void navigateRef.current(address.trim(), { pushHistory: true })
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            disabled={busy || !address.trim()}
            onClick={() => void navigateRef.current(address.trim(), { pushHistory: true })}
          >
            Go
          </Button>
        </div>

        {(status || error) && (
          <p
            className={cn(
              'truncate border-b border-border px-3 py-1 font-mono text-[10px]',
              error ? 'text-destructive' : 'text-muted-foreground',
            )}
            title={error ?? status ?? undefined}
          >
            {error ?? status}
          </p>
        )}

        <div className="min-h-0 flex-1 bg-background">
          {srcdoc ? (
            <iframe
              ref={iframeRef}
              title="Guest page"
              sandbox="allow-scripts"
              srcDoc={srcdoc}
              className="size-full min-h-[20rem] border-0 bg-white"
            />
          ) : (
            <div className="flex h-full min-h-[20rem] items-center justify-center text-xs text-muted-foreground">
              {busy ? 'Loading…' : error ? 'Could not load this URL.' : 'No page loaded.'}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
