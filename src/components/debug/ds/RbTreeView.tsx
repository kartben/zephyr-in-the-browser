import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FieldRow, PtrChip, StructCard } from '@/components/debug/ds/DsChrome'
import type { RbTreeWalk } from '@/debug/ds'
import { compactHex } from '@/debug/hexFormat'

const BOX_W = 52
const BOX_H = 30
const MAX_SHOW = 20

type LayoutNode = {
  id: string
  addr: number
  color: 'red' | 'black' | 'ellipsis'
  label: string
  sub: string
  foldRoot?: number
  x: number
  y: number
  children: LayoutNode[]
}

function layoutTree(
  walk: RbTreeWalk,
  folded: Set<number>,
): { root: LayoutNode | null; width: number; height: number; shown: number; folds: number } {
  const { nodes, header } = walk
  if (!header.root || !nodes.has(header.root)) {
    return { root: null, width: 0, height: 0, shown: 0, folds: 0 }
  }

  let folds = 0
  let shown = 0

  function countDesc(addr: number): number {
    const n = nodes.get(addr)
    if (!n) return 0
    let c = 0
    const walk = (a: number) => {
      const node = nodes.get(a)
      if (!node) return
      c++
      if (node.left) walk(node.left)
      if (node.right) walk(node.right)
    }
    walk(addr)
    return Math.max(0, c - 1)
  }

  function build(addr: number): LayoutNode | null {
    const n = nodes.get(addr)
    if (!n) return null
    shown++
    const kids: LayoutNode[] = []
    if (folded.has(addr) && (n.left || n.right)) {
      folds++
      shown++
      kids.push({
        id: `${addr}:…`,
        addr,
        color: 'ellipsis',
        label: '…',
        sub: `+${countDesc(addr)}`,
        foldRoot: addr,
        x: 0,
        y: 0,
        children: [],
      })
    } else {
      if (n.left) {
        const L = build(n.left)
        if (L) kids.push(L)
      }
      if (n.right) {
        const R = build(n.right)
        if (R) kids.push(R)
      }
    }
    return {
      id: String(addr),
      addr,
      color: n.color,
      label: compactHex(addr.toString(16)).slice(-4),
      sub: '',
      x: 0,
      y: 0,
      children: kids,
    }
  }

  const root = build(header.root)
  if (!root) return { root: null, width: 0, height: 0, shown: 0, folds: 0 }

  // Reingold–Tilford-ish: assign x by inorder leaf slots
  let nextX = 0
  function place(node: LayoutNode, depth: number) {
    node.y = depth
    if (!node.children.length) {
      node.x = nextX++
      return
    }
    for (const c of node.children) place(c, depth + 1)
    node.x = (node.children[0]!.x + node.children[node.children.length - 1]!.x) / 2
  }
  place(root, 0)

  let maxX = 0
  let maxY = 0
  ;(function extent(n: LayoutNode) {
    maxX = Math.max(maxX, n.x)
    maxY = Math.max(maxY, n.y)
    for (const c of n.children) extent(c)
  })(root)

  const gapX = BOX_W + 12
  const gapY = BOX_H + 22
  ;(function scale(n: LayoutNode) {
    n.x = n.x * gapX + BOX_W / 2 + 8
    n.y = n.y * gapY + BOX_H / 2 + 8
    for (const c of n.children) scale(c)
  })(root)

  return {
    root,
    width: maxX * gapX + BOX_W + 24,
    height: maxY * gapY + BOX_H + 24,
    shown,
    folds,
  }
}

export function RbTreeView({
  walk,
  onPeek,
}: {
  walk: RbTreeWalk
  onPeek?: (addrHex: string) => void
}) {
  const [folded, setFolded] = useState<Set<number>>(() => new Set())
  const [selected, setSelected] = useState<number | null>(null)

  // Auto-fold when many nodes
  useEffect(() => {
    if (walk.order.length <= MAX_SHOW) {
      setFolded(new Set())
      return
    }
    // Fold deeper limbs: any node at depth >= 2 with grandchildren
    const next = new Set<number>()
    const depth = new Map<number, number>()
    const root = walk.header.root
    if (!root) return
    const q: number[] = [root]
    depth.set(root, 0)
    while (q.length) {
      const a = q.shift()!
      const n = walk.nodes.get(a)
      if (!n) continue
      const d = depth.get(a) ?? 0
      for (const c of [n.left, n.right]) {
        if (!c || !walk.nodes.has(c)) continue
        depth.set(c, d + 1)
        q.push(c)
        if (d + 1 >= 2) {
          const cn = walk.nodes.get(c)!
          if (cn.left || cn.right) next.add(c)
        }
      }
    }
    setFolded(next)
  }, [walk])

  const layout = useMemo(() => layoutTree(walk, folded), [walk, folded])
  const sel = selected != null ? walk.nodes.get(selected) : null

  const links: { x1: number; y1: number; x2: number; y2: number }[] = []
  if (layout.root) {
    ;(function collect(n: LayoutNode) {
      for (const c of n.children) {
        links.push({
          x1: n.x,
          y1: n.y + BOX_H / 2,
          x2: c.x,
          y2: c.y - BOX_H / 2,
        })
        collect(c)
      }
    })(layout.root)
  }

  const flat: LayoutNode[] = []
  if (layout.root) {
    ;(function collect(n: LayoutNode) {
      flat.push(n)
      for (const c of n.children) collect(c)
    })(layout.root)
  }

  return (
    <div className="space-y-2">
      <StructCard
        typeName="struct rbtree"
        meta={
          walk.error
            ? walk.error
            : `${walk.order.length} nodes · showing ${layout.shown}` +
              (layout.folds ? ` · ${layout.folds} folds` : '') +
              (walk.truncated ? ' · truncated' : '')
        }
      >
        <FieldRow label="@">
          <PtrChip addr={walk.header.addr} onPeek={onPeek} />
        </FieldRow>
        <FieldRow label="root">
          <PtrChip addr={walk.header.root} onPeek={onPeek} />
        </FieldRow>
        <FieldRow label="lessthan_fn">
          <PtrChip addr={walk.header.lessthanFn} onPeek={onPeek} />
        </FieldRow>
        <FieldRow label="max_depth">{walk.header.maxDepth}</FieldRow>
      </StructCard>

      <div className="flex flex-wrap gap-1">
        <Button
          variant="secondary"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() => setFolded(new Set())}
        >
          Expand folds
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() => {
            const next = new Set<number>()
            for (const [a, n] of walk.nodes) {
              if (n.left || n.right) {
                const isRoot = a === walk.header.root
                if (!isRoot) next.add(a)
              }
            }
            // keep root expanded; fold its grandchildren's parents at depth>=1 with kids
            setFolded(new Set([...next].filter((a) => a !== walk.header.root).slice(0, 8)))
          }}
        >
          Collapse
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 font-mono text-[9px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2.5 rounded-sm border border-red-400/80 bg-red-950/80" />
          red
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2.5 rounded-sm border border-slate-400/80 bg-slate-900/80" />
          black
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2.5 rounded-sm border border-dashed border-muted-foreground" />
          folded
        </span>
      </div>

      <div className="overflow-auto rounded-md border border-border bg-[#10131a]">
        {layout.root ? (
          <svg
            width="100%"
            viewBox={`0 0 ${Math.max(layout.width, 200)} ${Math.max(layout.height, 120)}`}
            className="block min-h-[8rem]"
          >
            {links.map((l, i) => (
              <path
                key={i}
                d={`M${l.x1},${l.y1} C${l.x1},${(l.y1 + l.y2) / 2} ${l.x2},${(l.y1 + l.y2) / 2} ${l.x2},${l.y2}`}
                fill="none"
                stroke="#3a4558"
                strokeWidth={1.25}
              />
            ))}
            {flat.map((n) => {
              const isSel = selected === n.addr && n.color !== 'ellipsis'
              const stroke =
                n.color === 'red'
                  ? '#e07a6a'
                  : n.color === 'black'
                    ? '#8b93a7'
                    : '#6b6e78'
              const fill =
                n.color === 'red' ? '#3a2220' : n.color === 'black' ? '#1c2230' : '#151922'
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  onClick={() => {
                    if (n.foldRoot != null) {
                      setFolded((prev) => {
                        const next = new Set(prev)
                        next.delete(n.foldRoot!)
                        return next
                      })
                      setSelected(n.foldRoot)
                      return
                    }
                    setSelected(n.addr)
                  }}
                >
                  <rect
                    x={-BOX_W / 2}
                    y={-BOX_H / 2}
                    width={BOX_W}
                    height={BOX_H}
                    rx={5}
                    fill={fill}
                    stroke={isSel ? '#c4a574' : stroke}
                    strokeWidth={isSel ? 2 : 1.25}
                    strokeDasharray={n.color === 'ellipsis' ? '3 2' : undefined}
                  />
                  <text
                    textAnchor="middle"
                    dy="-0.15em"
                    fill="#e8e6e1"
                    fontSize={9}
                    fontFamily="ui-monospace, monospace"
                  >
                    {n.label}
                  </text>
                  {n.sub ? (
                    <text
                      textAnchor="middle"
                      dy="1.05em"
                      fill="#9a9aa3"
                      fontSize={8}
                      fontFamily="ui-monospace, monospace"
                    >
                      {n.sub}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </svg>
        ) : (
          <p className="px-2 py-4 font-mono text-[10px] text-muted-foreground">Empty tree</p>
        )}
      </div>

      <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
        {sel ? (
          <>
            <span className="text-foreground">rbnode</span> @{' '}
            <PtrChip addr={sel.addr} onPeek={onPeek} /> · {sel.color} (LSB=
            {sel.color === 'black' ? 1 : 0})
            <br />
            children[0] → <PtrChip addr={sel.left} onPeek={onPeek} /> · children[1] →{' '}
            <PtrChip addr={sel.right} onPeek={onPeek} />
          </>
        ) : (
          <span>Click a node — color bit from children[0] LSB.</span>
        )}
      </div>
    </div>
  )
}
