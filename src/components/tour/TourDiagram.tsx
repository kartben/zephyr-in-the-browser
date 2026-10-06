/**
 * A ```mermaid block in a tour body, drawn as a diagram (src/tours/diagram.ts).
 *
 * Mermaid is large, so it is imported the first time a card has a diagram, and
 * a page that shows none never downloads it. The colours come from the page's
 * own tokens, resolved to the hex Mermaid's colour parser needs when the
 * diagram is drawn, and the diagram is drawn again when the system switches
 * between light and dark.
 *
 * Mermaid's output is an SVG string, which makes it the one piece of tour
 * Markdown set as HTML besides highlighted code: Mermaid sanitises its labels
 * itself (`securityLevel: 'strict'`), and tours are this repository's files.
 */

import { useEffect, useState } from 'react'
import {
  dimmedEdges,
  isFlowchart,
  styledDiagramSource,
  type DiagramColors,
  type DiagramEdge,
} from '@/tours/diagram'

type Mermaid = (typeof import('mermaid'))['default']

let mermaidModule: Promise<Mermaid> | null = null

function loadMermaid(): Promise<Mermaid> {
  mermaidModule ??= import('mermaid').then((m) => m.default)
  return mermaidModule
}

/** The page's tokens for each colour; see the `:root` rules in index.css. */
const COLOR_CSS: Record<keyof DiagramColors, string> = {
  focusFill: 'color-mix(in oklch, var(--primary) 12%, var(--background))',
  focusStroke: 'var(--primary)',
  focusText: 'var(--foreground)',
  dimFill: 'var(--muted)',
  dimStroke: 'var(--border)',
  // Dimmed by its fill and outline; the label itself stays readable (5.8:1).
  dimText: 'var(--muted-foreground)',
  line: 'var(--primary)',
  dimLine: 'var(--border)',
}

interface Palette {
  colors: DiagramColors
  text: string
  font: string
}

/**
 * The tokens as `#rrggbb`. The browser computes each one, `oklch()` and
 * `color-mix()` included, and a one-pixel canvas turns it into sRGB.
 */
function resolvePalette(): Palette {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.append(probe)
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const hex = (css: string): string => {
    probe.style.color = css
    const computed = getComputedStyle(probe).color
    if (!ctx) return computed
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = computed
    ctx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  try {
    const colors = Object.fromEntries(
      Object.entries(COLOR_CSS).map(([key, css]) => [key, hex(css)]),
    ) as unknown as DiagramColors
    probe.style.fontFamily = 'var(--font-mono)'
    return { colors, text: hex('var(--foreground)'), font: getComputedStyle(probe).fontFamily }
  } finally {
    probe.remove()
  }
}

/** The parts of Mermaid's flowchart database the edge dimming reads. */
interface FlowDb {
  getEdges(): DiagramEdge[]
  getVertices(): Map<string, { classes: string[] }>
}

function isFlowDb(db: unknown): db is FlowDb {
  const d = db as Partial<FlowDb> | null
  return typeof d?.getEdges === 'function' && typeof d.getVertices === 'function'
}

let drawn = 0

async function draw(source: string): Promise<string> {
  const mermaid = await loadMermaid()
  const { colors, text, font } = resolvePalette()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // A diagram that fails shows its source on the card, not Mermaid's own
    // error graphic somewhere in the page.
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: font,
    themeVariables: {
      fontFamily: font,
      fontSize: '13px',
      background: 'transparent',
      primaryColor: colors.focusFill,
      primaryBorderColor: colors.focusStroke,
      primaryTextColor: colors.focusText,
      lineColor: colors.line,
      textColor: text,
    },
    flowchart: { curve: 'basis', nodeSpacing: 18, rankSpacing: 28, padding: 6 },
  })
  let styled = source
  if (isFlowchart(source)) {
    const { db } = await mermaid.mermaidAPI.getDiagramFromText(source)
    let dimEdges: number[] = []
    if (isFlowDb(db)) {
      const dim = new Set<string>()
      for (const [id, vertex] of db.getVertices()) {
        if (vertex.classes.includes('dim')) dim.add(id)
      }
      dimEdges = dimmedEdges(db.getEdges(), dim)
    }
    styled = styledDiagramSource(source, colors, dimEdges)
  }
  drawn += 1
  const { svg } = await mermaid.render(`tour-diagram-${drawn}`, styled)
  return svg
}

/** One drawing at a time: `initialize()` is global, and each sets its colours. */
let queue: Promise<unknown> = Promise.resolve()

function enqueue(source: string): Promise<string> {
  const job = queue.then(() => draw(source))
  queue = job.catch(() => undefined)
  return job
}

const LIGHT = '(prefers-color-scheme: light)'

/** The page's scheme, which its tokens follow: dark unless the system asks for light. */
function useScheme(): 'light' | 'dark' {
  const [light, setLight] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(LIGHT).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(LIGHT)
    const onChange = () => setLight(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return light ? 'light' : 'dark'
}

type Drawing = { source: string; svg: string } | { source: string; error: string }

export function TourDiagram({ source }: { source: string }) {
  const scheme = useScheme()
  const [drawing, setDrawing] = useState<Drawing | null>(null)

  useEffect(() => {
    let live = true
    enqueue(source).then(
      (svg) => live && setDrawing({ source, svg }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (live) setDrawing({ source, error: message.split('\n')[0] ?? message })
      },
    )
    return () => {
      live = false
    }
  }, [source, scheme])

  // A drawing of another block (the card moved on) is not this one.
  const current = drawing?.source === source ? drawing : null

  if (current && 'error' in current) {
    return (
      <figure data-tour-diagram="error" className="space-y-1">
        <pre className="overflow-x-auto rounded border border-border bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-foreground">
          {source}
        </pre>
        <figcaption className="text-[11px] text-muted-foreground">
          This diagram could not be drawn: {current.error}
        </figcaption>
      </figure>
    )
  }
  if (!current) {
    return (
      <figure
        data-tour-diagram="drawing"
        aria-busy="true"
        className="flex h-24 items-center justify-center text-[11px] text-muted-foreground"
      >
        Drawing the diagram…
      </figure>
    )
  }
  return (
    <figure
      data-tour-diagram="drawn"
      className="[&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: current.svg }}
    />
  )
}
