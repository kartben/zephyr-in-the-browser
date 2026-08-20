import { useMemo, useState } from 'react'
import { FieldRow, PtrChip, StructCard } from '@/components/debug/ds/DsChrome'
import type { RingBuf } from '@/debug/ds'
import { compactHex } from '@/debug/hexFormat'

export function RingBufView({
  ring,
  onPeek,
}: {
  ring: RingBuf
  onPeek?: (addrHex: string) => void
}) {
  const [sel, setSel] = useState<string | null>(null)
  const large = ring.size > 512
  const getIdx = ring.get.tail % Math.max(ring.size, 1)
  const putIdx = ring.put.tail % Math.max(ring.size, 1)

  const { W, H, cx, cy, R, r } = useMemo(() => {
    const W = 280
    const H = large ? 220 : 200
    return { W, H, cx: W / 2, cy: 88, R: 64, r: 48 }
  }, [large])

  const tau = Math.PI * 2
  const aGet = -Math.PI / 2 + (getIdx / ring.size) * tau
  const aPut = -Math.PI / 2 + (putIdx / ring.size) * tau

  function polar(a: number, rad: number): [number, number] {
    return [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]
  }

  function donut(start: number, end: number): string {
    let e = end
    if (e <= start) e += tau
    const largeArc = e - start > Math.PI ? 1 : 0
    const [x0, y0] = polar(start, R)
    const [x1, y1] = polar(e, R)
    const [x2, y2] = polar(e, r)
    const [x3, y3] = polar(start, r)
    return `M${x0},${y0} A${R},${R} 0 ${largeArc} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${largeArc} 0 ${x3},${y3} Z`
  }

  const stripY = 170
  const stripW = W - 32

  return (
    <div className="space-y-2">
      <StructCard
        typeName="struct ring_buf"
        meta={`byte mode · idx ${ring.indexWidth * 8}-bit`}
      >
        <FieldRow label="@">
          <PtrChip addr={ring.addr} onPeek={onPeek} />
        </FieldRow>
        <FieldRow label="buffer">
          <PtrChip addr={ring.buffer} onPeek={onPeek} />
        </FieldRow>
        <FieldRow label="size">{ring.size}</FieldRow>
        <FieldRow label="put.tail">{ring.put.tail}</FieldRow>
        <FieldRow label="get.tail">{ring.get.tail}</FieldRow>
        <FieldRow label="used">
          {ring.used} / {ring.size}
        </FieldRow>
      </StructCard>

      <div className="flex flex-wrap gap-2 font-mono text-[9px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2.5 rounded-sm bg-sky-500/80" />
          used
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2.5 rounded-sm bg-slate-700" />
          free
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2.5 rounded-sm bg-emerald-400" />
          put
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2.5 rounded-sm bg-amber-400" />
          get
        </span>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-[#10131a]">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
          <circle
            cx={cx}
            cy={cy}
            r={(R + r) / 2}
            fill="none"
            stroke="#2a3140"
            strokeWidth={R - r}
          />
          {ring.used > 0 ? (
            <path
              d={donut(aGet, aPut)}
              fill="#5b9fd4"
              fillOpacity={0.85}
              className="cursor-pointer"
              onClick={() => setSel('used band')}
            />
          ) : null}
          {([
            [aGet, '#f0b429', 'get'] as const,
            [aPut, '#34d399', 'put'] as const,
          ]).map(([a, color, label]) => {
            const [x, y] = polar(a, R + 10)
            const [ix, iy] = polar(a, r - 4)
            return (
              <g key={label} className="cursor-pointer" onClick={() => setSel(label)}>
                <line x1={ix} y1={iy} x2={x} y2={y} stroke={color} strokeWidth={2} />
                <circle cx={x} cy={y} r={4.5} fill={color} />
                <text
                  x={x}
                  y={y - 10}
                  textAnchor="middle"
                  fill={color}
                  fontSize={9}
                  fontFamily="ui-monospace, monospace"
                >
                  {label}
                </text>
              </g>
            )
          })}
          <text
            x={cx}
            y={cy - 2}
            textAnchor="middle"
            fill="#e8e6e1"
            fontSize={12}
            fontWeight={600}
            fontFamily="ui-monospace, monospace"
          >
            {ring.used}
          </text>
          <text
            x={cx}
            y={cy + 12}
            textAnchor="middle"
            fill="#6b6e78"
            fontSize={9}
            fontFamily="ui-monospace, monospace"
          >
            / {ring.size} B
          </text>

          {/* linear unwrap */}
          <g transform={`translate(16,${stripY})`}>
            {!large ? (
              <>
                <rect width={stripW} height={22} rx={5} fill="#2a3140" stroke="#2e3340" />
                {ring.put.tail >= ring.get.tail ? (
                  <rect
                    x={(getIdx / ring.size) * stripW}
                    width={Math.max(2, ((putIdx - getIdx) / ring.size) * stripW)}
                    height={22}
                    fill="#5b9fd4"
                    fillOpacity={0.9}
                  />
                ) : (
                  <>
                    <rect
                      x={(getIdx / ring.size) * stripW}
                      width={stripW - (getIdx / ring.size) * stripW}
                      height={22}
                      fill="#5b9fd4"
                      fillOpacity={0.9}
                    />
                    <rect
                      x={0}
                      width={(putIdx / ring.size) * stripW}
                      height={22}
                      fill="#5b9fd4"
                      fillOpacity={0.9}
                    />
                  </>
                )}
                <line
                  x1={(getIdx / ring.size) * stripW}
                  x2={(getIdx / ring.size) * stripW}
                  y1={-4}
                  y2={24}
                  stroke="#f0b429"
                  strokeWidth={1.5}
                />
                <line
                  x1={(putIdx / ring.size) * stripW}
                  x2={(putIdx / ring.size) * stripW}
                  y1={-4}
                  y2={24}
                  stroke="#34d399"
                  strokeWidth={1.5}
                />
              </>
            ) : (
              <>
                {/* get-window ··· put-window */}
                <rect width={stripW * 0.38} height={22} rx={5} fill="#2a3140" stroke="#2e3340" />
                <rect
                  x={stripW * 0.38 * 0.35}
                  width={stripW * 0.38 * 0.65}
                  height={22}
                  fill="#5b9fd4"
                  fillOpacity={0.9}
                />
                <text
                  x={stripW / 2}
                  y={16}
                  textAnchor="middle"
                  fill="#6b6e78"
                  fontSize={14}
                  fontFamily="ui-monospace, monospace"
                >
                  ···
                </text>
                <rect
                  x={stripW * 0.62}
                  width={stripW * 0.38}
                  height={22}
                  rx={5}
                  fill="#2a3140"
                  stroke="#2e3340"
                />
                <rect
                  x={stripW * 0.62}
                  width={stripW * 0.38 * 0.45}
                  height={22}
                  fill="#5b9fd4"
                  fillOpacity={0.9}
                />
              </>
            )}
          </g>
        </svg>
      </div>

      <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
        {sel ? (
          <>
            <span className="text-foreground">{sel}</span>
            {ring.buffer ? (
              <>
                {' '}
                · buffer @{' '}
                <PtrChip
                  addr={(ring.buffer + getIdx) >>> 0}
                  onPeek={onPeek}
                />
              </>
            ) : null}
            {large ? (
              <>
                <br />
                <span>large buffer — strip shows get-window · ··· · put-window</span>
              </>
            ) : null}
          </>
        ) : (
          <span>
            Click put/get — buffer base {ring.buffer ? compactHex(ring.buffer.toString(16)) : 'NULL'}
          </span>
        )}
      </div>
    </div>
  )
}
