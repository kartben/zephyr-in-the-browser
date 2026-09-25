import { FieldRow, PtrChip, StructCard } from '@/components/debug/ds/DsChrome'
import type { DListWalk } from '@/debug/ds'
import { compactHex } from '@/debug/hexFormat'

const BOX_W = 52
const BOX_H = 28

export function DListView({
  walk,
  onPeek,
}: {
  walk: DListWalk
  onPeek?: (addrHex: string) => void
}) {
  // Sentinel + nodes in ring order
  const items: { addr: number; kind: 'list' | 'node' }[] = [
    { addr: walk.header.addr, kind: 'list' },
    ...walk.nodes.map((addr) => ({ addr, kind: 'node' as const })),
  ]
  const needFold = items.length > 10
  const head = needFold ? items.slice(0, 4) : items
  const tail = needFold ? items.slice(-3) : []
  const hidden = needFold ? items.length - 7 : 0
  const visible: ({ addr: number; kind: 'list' | 'node' } | null)[] = needFold
    ? [...head, null, ...tail]
    : items

  const n = Math.max(visible.length, 1)
  const cx = 140
  const cy = 100
  const R = 70

  return (
    <div className="space-y-2">
      <StructCard
        typeName="sys_dlist_t"
        meta={
          walk.error
            ? walk.error
            : walk.header.empty
              ? 'empty · head/tail → self'
              : `${walk.nodes.length} nodes` +
                (walk.truncated ? ' · truncated' : '') +
                (needFold ? ` · ${hidden} folded` : '')
        }
      >
        <FieldRow label="@">
          <PtrChip addr={walk.header.addr} onPeek={onPeek} />
        </FieldRow>
        <FieldRow label="head">
          <PtrChip addr={walk.header.head} onPeek={onPeek} />
        </FieldRow>
        <FieldRow label="tail">
          <PtrChip addr={walk.header.tail} onPeek={onPeek} />
        </FieldRow>
      </StructCard>

      <div className="overflow-hidden rounded-md border border-border bg-[#10131a]">
        <svg viewBox="0 0 280 200" className="block w-full">
          {walk.header.empty ? (
            <g>
              <circle cx={cx} cy={cy} r={36} fill="none" stroke="#3a4558" strokeWidth={1.25} />
              <rect
                x={cx - BOX_W / 2}
                y={cy - BOX_H / 2}
                width={BOX_W}
                height={BOX_H}
                rx={5}
                fill="#1c2230"
                stroke="#c4a574"
              />
              <text
                x={cx}
                y={cy + 3}
                textAnchor="middle"
                fill="#e8e6e1"
                fontSize={9}
                fontFamily="ui-monospace, monospace"
              >
                list
              </text>
              <text
                x={cx}
                y={cy + 52}
                textAnchor="middle"
                fill="#6b6e78"
                fontSize={9}
                fontFamily="ui-monospace, monospace"
              >
                empty ring
              </text>
            </g>
          ) : (
            visible.map((item, i) => {
              const a = -Math.PI / 2 + (i / n) * Math.PI * 2
              const x = cx + Math.cos(a) * R
              const y = cy + Math.sin(a) * R
              const nextI = (i + 1) % n
              const a2 = -Math.PI / 2 + (nextI / n) * Math.PI * 2
              const x2 = cx + Math.cos(a2) * R
              const y2 = cy + Math.sin(a2) * R
              if (item === null) {
                return (
                  <g key={`fold-${i}`}>
                    <path
                      d={`M${x},${y} Q${cx},${cy} ${x2},${y2}`}
                      fill="none"
                      stroke="#3a4558"
                      strokeWidth={1}
                      strokeDasharray="3 2"
                    />
                    <text
                      x={x}
                      y={y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#9a9aa3"
                      fontSize={10}
                      fontFamily="ui-monospace, monospace"
                    >
                      …+{hidden}
                    </text>
                  </g>
                )
              }
              const isList = item.kind === 'list'
              return (
                <g
                  key={`${item.kind}-${item.addr}`}
                  className="cursor-pointer"
                  onClick={() => onPeek?.(compactHex(item.addr.toString(16)))}
                >
                  <path
                    d={`M${x},${y} Q${(x + x2) / 2 + (cy - (y + y2) / 2) * 0.15},${(y + y2) / 2 + ((x2 - x) / 2) * 0.15} ${x2},${y2}`}
                    fill="none"
                    stroke="#3a4558"
                    strokeWidth={1.15}
                  />
                  <rect
                    x={x - BOX_W / 2}
                    y={y - BOX_H / 2}
                    width={BOX_W}
                    height={BOX_H}
                    rx={5}
                    fill={isList ? '#2a2418' : '#1c2230'}
                    stroke={isList ? '#c4a574' : '#8b93a7'}
                    strokeWidth={1.25}
                  />
                  <text
                    x={x}
                    y={y - 2}
                    textAnchor="middle"
                    fill="#e8e6e1"
                    fontSize={9}
                    fontFamily="ui-monospace, monospace"
                  >
                    {isList ? 'list' : compactHex(item.addr.toString(16)).slice(-4)}
                  </text>
                  <text
                    x={x}
                    y={y + 10}
                    textAnchor="middle"
                    fill="#6b6e78"
                    fontSize={8}
                    fontFamily="ui-monospace, monospace"
                  >
                    {isList ? 'sentinel' : 'node'}
                  </text>
                </g>
              )
            })
          )}
        </svg>
      </div>
      <p className="font-mono text-[9px] text-muted-foreground">
        List struct sits in the ring — empty means both pointers equal @list.
      </p>
    </div>
  )
}
