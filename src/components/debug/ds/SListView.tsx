import { FieldRow, PtrChip, StructCard } from '@/components/debug/ds/DsChrome'
import type { SListWalk } from '@/debug/ds'
import { compactHex } from '@/debug/hexFormat'

const BOX_W = 56
const BOX_H = 28
const GAP = 28
const HEAD_SHOW = 5
const TAIL_SHOW = 4

export function SListView({
  walk,
  onPeek,
}: {
  walk: SListWalk
  onPeek?: (addrHex: string) => void
}) {
  const nodes = walk.nodes
  const needFold = nodes.length > HEAD_SHOW + TAIL_SHOW + 1
  const hidden = needFold ? nodes.length - HEAD_SHOW - TAIL_SHOW : 0
  const visible = needFold
    ? [...nodes.slice(0, HEAD_SHOW), null, ...nodes.slice(nodes.length - TAIL_SHOW)]
    : nodes

  const width = Math.max(200, visible.length * (BOX_W + GAP) + 24)
  const height = 72

  return (
    <div className="space-y-2">
      <StructCard
        typeName="sys_slist_t"
        meta={
          walk.error
            ? walk.error
            : `${nodes.length} nodes` +
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

      <div className="overflow-auto rounded-md border border-border bg-[#10131a]">
        {nodes.length === 0 ? (
          <p className="px-2 py-4 font-mono text-[10px] text-muted-foreground">Empty list</p>
        ) : (
          <svg viewBox={`0 0 ${width} ${height}`} className="block min-h-[4.5rem] w-full">
            {visible.map((addr, i) => {
              const x = 12 + i * (BOX_W + GAP) + BOX_W / 2
              const y = height / 2
              if (addr === null) {
                return (
                  <g key={`fold-${i}`}>
                    {i > 0 ? (
                      <line
                        x1={x - BOX_W / 2 - GAP + 4}
                        y1={y}
                        x2={x - BOX_W / 2}
                        y2={y}
                        stroke="#3a4558"
                        strokeWidth={1.25}
                        markerEnd="url(#slist-arrow)"
                      />
                    ) : null}
                    <rect
                      x={x - BOX_W / 2}
                      y={y - BOX_H / 2}
                      width={BOX_W}
                      height={BOX_H}
                      rx={5}
                      fill="#151922"
                      stroke="#6b6e78"
                      strokeDasharray="3 2"
                    />
                    <text
                      x={x}
                      y={y + 3}
                      textAnchor="middle"
                      fill="#9a9aa3"
                      fontSize={10}
                      fontFamily="ui-monospace, monospace"
                    >
                      … +{hidden}
                    </text>
                  </g>
                )
              }
              const isHead = addr === walk.header.head
              const isTail = addr === walk.header.tail
              return (
                <g
                  key={addr}
                  className="cursor-pointer"
                  onClick={() => onPeek?.(compactHex(addr.toString(16)))}
                >
                  {i > 0 ? (
                    <line
                      x1={x - BOX_W / 2 - GAP + 4}
                      y1={y}
                      x2={x - BOX_W / 2}
                      y2={y}
                      stroke="#3a4558"
                      strokeWidth={1.25}
                    />
                  ) : null}
                  <rect
                    x={x - BOX_W / 2}
                    y={y - BOX_H / 2}
                    width={BOX_W}
                    height={BOX_H}
                    rx={5}
                    fill="#1c2230"
                    stroke={isHead || isTail ? '#c4a574' : '#8b93a7'}
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
                    {compactHex(addr.toString(16)).slice(-4)}
                  </text>
                  <text
                    x={x}
                    y={y + 10}
                    textAnchor="middle"
                    fill="#6b6e78"
                    fontSize={8}
                    fontFamily="ui-monospace, monospace"
                  >
                    {isHead && isTail ? 'head/tail' : isHead ? 'head' : isTail ? 'tail' : 'next→'}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}
