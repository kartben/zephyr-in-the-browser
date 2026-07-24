import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { compatibles, isEffectivelyOkay, isOkay, parseDts, stringProp } from '@/dts'
import type { DtsDocument, DtsNode, DtsProperty } from '@/dts'

/**
 * The devicetree, explorable: collapsible nodes with their properties as
 * key–value rows, plus a raw-source tab with the file exactly as the build
 * wrote it. Parsing happens here (not via the devicetree store) because the
 * viewer also opens trees that are not running — any sample's, from the
 * gallery. A tree that fails to parse still shows its source.
 */

interface DtsViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Resolves the devicetree source, or null when none is shipped. */
  load: () => Promise<string | null>
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'ready'; text: string; doc: DtsDocument | null }

export function DtsViewer({ open, onOpenChange, title, load }: DtsViewerProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [tab, setTab] = useState<'tree' | 'source'>('tree')

  useEffect(() => {
    if (!open) return
    let stale = false
    setState({ kind: 'loading' })
    setTab('tree')
    void load().then((text) => {
      if (stale) return
      if (text === null) {
        setState({ kind: 'absent' })
        return
      }
      let doc: DtsDocument | null = null
      try {
        doc = parseDts(text)
      } catch {
        // Raw source still has value; the tree tab explains itself.
      }
      setState({ kind: 'ready', text, doc })
    })
    return () => {
      stale = true
    }
  }, [open, load])

  const summary = useMemo(
    () => (state.kind === 'ready' && state.doc ? summarize(state.doc) : null),
    [state],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {state.kind === 'loading' && 'Loading devicetree…'}
            {state.kind === 'absent' &&
              'No devicetree is shipped for this image — likely an older build of the sample assets.'}
            {state.kind === 'ready' && (summary ?? 'Devicetree source (could not be parsed as a tree).')}
          </DialogDescription>
        </DialogHeader>

        {state.kind === 'ready' && (
          <>
            <div className="flex shrink-0 gap-1 px-5 pb-2">
              <TabButton active={tab === 'tree'} onClick={() => setTab('tree')} disabled={!state.doc}>
                Tree
              </TabButton>
              <TabButton active={tab === 'source'} onClick={() => setTab('source')}>
                Source
              </TabButton>
            </div>

            <div className="min-h-0 flex-1 overflow-auto border-t border-border px-5 py-3 font-mono text-[11px] leading-relaxed">
              {tab === 'tree' && state.doc ? (
                <NodeRow node={state.doc.root} depth={0} />
              ) : (
                <pre className="whitespace-pre">{state.text}</pre>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function summarize(doc: DtsDocument): string {
  const model = stringProp(doc.root, 'model')
  let devices = 0
  const walk = (node: DtsNode) => {
    if (compatibles(node).length > 0 && isEffectivelyOkay(node)) devices++
    node.children.forEach(walk)
  }
  walk(doc.root)
  return [model, `${devices} enabled devices`].filter(Boolean).join(' — ')
}

function TabButton({
  active,
  ...props
}: { active: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-40',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
      {...props}
    />
  )
}

function NodeRow({ node, depth }: { node: DtsNode; depth: number }) {
  // Roots and buses matter immediately; the deep leaves are a click away.
  const [open, setOpen] = useState(depth < 2)
  const disabled = !isOkay(node)
  const hasBody = node.children.length > 0 || node.properties.length > 0

  return (
    <div className={cn(disabled && 'opacity-50')}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-1 rounded px-1 text-left hover:bg-secondary/60"
        aria-expanded={open}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
            !hasBody && 'invisible',
          )}
        />
        {node.labels.map((label) => (
          <span key={label} className="text-primary">
            {label}:
          </span>
        ))}
        <span className="font-semibold text-foreground">{node.name}</span>
        <span className="text-muted-foreground">{'{'}</span>
        {!open && (
          <span className="text-[10px] text-muted-foreground">
            …{'}'} {node.children.length > 0 && `${node.children.length} nodes, `}
            {node.properties.length} props
          </span>
        )}
        {disabled && (
          <span className="ml-1 rounded bg-secondary px-1 text-[10px] text-muted-foreground">
            disabled
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="border-l border-border/60 pl-4" style={{ marginLeft: '0.3rem' }}>
            {node.properties.map((property) => (
              <PropertyRow key={property.name} property={property} />
            ))}
            {node.children.map((child) => (
              <NodeRow key={child.name} node={child} depth={depth + 1} />
            ))}
          </div>
          <span className="px-1 text-muted-foreground">{'};'}</span>
        </>
      )}
    </div>
  )
}

function PropertyRow({ property }: { property: DtsProperty }) {
  return (
    <div className="px-1">
      <span className="text-muted-foreground">{property.name}</span>
      {property.raw !== '' && (
        <>
          <span className="text-muted-foreground"> = </span>
          <HighlightedValue raw={property.raw} />
        </>
      )}
      <span className="text-muted-foreground">;</span>
    </div>
  )
}

/**
 * Light syntax tinting over the verbatim value text: strings, &references and
 * numbers each get a color, everything else stays muted. Token-ish regex, not
 * a grammar — the value is already known to be valid DTS.
 */
function HighlightedValue({ raw }: { raw: string }) {
  const parts = raw.split(/("(?:[^"\\]|\\.)*"|&[A-Za-z0-9_,.+?#{}/@-]+|\b0x[0-9a-fA-F]+\b|\b\d+\b)/g)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('"') ? (
          <span key={i} className="text-emerald-400">
            {part}
          </span>
        ) : part.startsWith('&') ? (
          <span key={i} className="text-primary">
            {part}
          </span>
        ) : /^(0x[0-9a-fA-F]+|\d+)$/.test(part) ? (
          <span key={i} className="text-sky-400">
            {part}
          </span>
        ) : (
          <span key={i} className="text-muted-foreground">
            {part}
          </span>
        ),
      )}
    </>
  )
}
