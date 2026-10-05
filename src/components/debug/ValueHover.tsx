/**
 * VS Code's debug hover, for a source listing: rest the pointer on a name
 * while the guest is stopped and its value appears under it.
 *
 * The listing is highlight.js HTML, one `<code>` per line, with no element per
 * identifier, so the hover works from the text: the caret position under the
 * pointer gives a column, VS Code's expression rule (`hoverExpression`) gives
 * the text around it, and the inspector evaluates that at the stop. The
 * evaluated range is marked with the CSS Custom Highlight API, as VS Code
 * marks it, without touching the highlighted HTML.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ValueTree } from '@/components/debug/ValueTree'
import { hoverExpression } from '@/debug/dwarf/hoverExpr'
import type { ValueView } from '@/debug/dwarf/values'
import { stopInspector } from '@/debug/inspectLive'
import { cn } from '@/lib/utils'

/** VS Code's default `editor.hover.delay`. */
const HOVER_DELAY_MS = 300
/** Time to move from the name into the popup before it closes. */
const HIDE_DELAY_MS = 250
const HIGHLIGHT = 'debug-hover'

interface Shown {
  key: string
  view: ValueView
  rect: DOMRect
}

/**
 * Pointer handlers for the listing's `<pre>`, and the popup to render.
 * `lines` is the listing's source text, line `n` at index `n - 1`; rows carry
 * `data-line`.
 */
export function useValueHover(enabled: boolean, lines: string[] | null) {
  const [shown, setShownState] = useState<Shown | null>(null)
  /** The shown popup's key, for timer callbacks that outlive a render. */
  const shownKey = useRef<string | null>(null)
  const setShown = useCallback((next: Shown | null) => {
    shownKey.current = next?.key ?? null
    setShownState(next)
  }, [])
  const target = useRef<string | null>(null)
  const showTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)

  /**
   * Take the popup down. A hover still waiting to show stays pending: moving
   * from one name to the next hides the first popup while the second one's
   * delay runs.
   */
  const hidePopup = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = null
    setShown(null)
    clearHighlight()
  }, [setShown])

  /** Forget the popup and any hover still waiting to show. */
  const reset = useCallback(() => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current)
    showTimer.current = null
    target.current = null
    hidePopup()
  }, [hidePopup])

  const scheduleHide = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(hidePopup, HIDE_DELAY_MS)
  }
  const cancelHide = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = null
  }

  // The guest ran, or the listing stopped being inspectable: nothing shown is
  // true any more.
  useEffect(() => {
    if (!enabled) reset()
  }, [enabled, reset])

  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') reset()
    }
    const onScroll = (e: Event) => {
      // Scrolling inside the popup is reading it, not leaving it.
      if (e.target instanceof Node && document.getElementById('value-hover')?.contains(e.target)) return
      reset()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [shown, reset])

  useEffect(() => reset, [reset])

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || !lines || e.pointerType === 'touch') return
    const hit = hitTest(e.clientX, e.clientY)
    const expr = hit ? hoverExpression(lines[hit.line - 1] ?? '', hit.column) : null
    if (!hit || !expr) {
      // Off any name: the popup goes unless the pointer is on its way into it.
      if (showTimer.current !== null) window.clearTimeout(showTimer.current)
      showTimer.current = null
      target.current = null
      if (shownKey.current) scheduleHide()
      return
    }
    const key = `${hit.line}:${expr.start}:${expr.end}`
    if (key === target.current) {
      if (shownKey.current === key) cancelHide()
      return
    }
    target.current = key
    if (showTimer.current !== null) window.clearTimeout(showTimer.current)
    if (shownKey.current) scheduleHide()
    const { code } = hit
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null
      const inspector = stopInspector()
      if (!inspector) return
      void inspector
        .evaluate(expr.text)
        // A value that cannot be worked out shows no hover, as in VS Code.
        .catch(() => null)
        .then((view) => {
          if (target.current !== key) return
          if (!view) {
            if (shownKey.current !== key) scheduleHide()
            return
          }
          const range = textRange(code, expr.start, expr.end)
          if (!range) return
          cancelHide()
          setHighlight(range)
          setShown({ key, view, rect: range.getBoundingClientRect() })
        })
    }, HOVER_DELAY_MS)
  }

  const onPointerLeave = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current)
    showTimer.current = null
    target.current = null
    if (shownKey.current) scheduleHide()
  }

  const popup = shown ? (
    <ValuePopover view={shown.view} rect={shown.rect} onEnter={cancelHide} onLeave={scheduleHide} />
  ) : null

  return { onPointerMove, onPointerLeave, popup }
}

function ValuePopover({
  view,
  rect,
  onEnter,
  onLeave,
}: {
  view: ValueView
  rect: DOMRect
  onEnter: () => void
  onLeave: () => void
}) {
  const [children, setChildren] = useState<ValueView[] | null>(null)
  useEffect(() => {
    let live = true
    setChildren(null)
    if (view.expandable) {
      void view.children().then((kids) => {
        if (live) setChildren(kids)
      })
    }
    return () => {
      live = false
    }
  }, [view])

  // Under the name, or over it when the listing sits low in the window.
  const below = rect.bottom + 4
  const roomBelow = window.innerHeight - below
  const style: CSSProperties = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 8 - 448)),
    ...(roomBelow >= 160 ? { top: below } : { bottom: window.innerHeight - rect.top + 4 }),
  }

  return createPortal(
    <div
      id="value-hover"
      role="tooltip"
      className="fixed z-40 max-h-72 w-max min-w-40 max-w-md overflow-auto rounded-md border border-border bg-card/95 px-2 py-1.5 shadow-xl backdrop-blur"
      style={style}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <p
        className={cn(
          'whitespace-nowrap font-mono text-[11px]',
          view.unavailable ? 'italic text-muted-foreground' : 'text-foreground',
        )}
        title={view.typeName || undefined}
      >
        {view.text}
      </p>
      {view.expandable &&
        (children ? (
          <div className="mt-1 border-t border-border/60 pt-1">
            <ValueTree views={children} />
          </div>
        ) : (
          <p className="font-mono text-[11px] text-muted-foreground/70">…</p>
        ))}
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ *
 * Hit testing the highlighted listing
 * ------------------------------------------------------------------ */

interface Hit {
  line: number
  /** 0-based character offset in the line. */
  column: number
  code: HTMLElement
}

function hitTest(x: number, y: number): Hit | null {
  const caret = caretAt(x, y)
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null
  const code = caret.node.parentElement?.closest('code')
  const row = code?.closest<HTMLElement>('[data-line]')
  if (!code || !row) return null
  const line = Number(row.dataset.line)
  const at = textOffset(code, caret.node as Text) + caret.offset
  // The caret is between characters; the character under the pointer is the
  // one after it or the one before it, whichever box holds the point.
  for (const column of [at, at - 1]) {
    const range = textRange(code, column, column + 1)
    const box = range?.getBoundingClientRect()
    if (box && x >= box.left && x < box.right && y >= box.top && y <= box.bottom) {
      return { line, column, code }
    }
  }
  return null
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y)
    return position ? { node: position.offsetNode, offset: position.offset } : null
  }
  const range = doc.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** Characters before `node` in `root`'s text. */
function textOffset(root: HTMLElement, node: Text): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return offset
    offset += n.textContent?.length ?? 0
  }
  return offset
}

/** A DOM range over characters `[start, end)` of `root`'s text. */
function textRange(root: HTMLElement, start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let started = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const length = n.textContent?.length ?? 0
    if (!started && start < offset + length) {
      range.setStart(n, start - offset)
      started = true
    }
    if (started && end <= offset + length) {
      range.setEnd(n, end - offset)
      return range
    }
    offset += length
  }
  return null
}

function setHighlight(range: Range): void {
  const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (registry && Highlight) registry.set(HIGHLIGHT, new Highlight(range))
}

function clearHighlight(): void {
  ;(globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights?.delete(HIGHLIGHT)
}
