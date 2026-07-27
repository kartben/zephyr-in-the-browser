/**
 * Dock body for `gpio-7-segment`: multiplexed LED digit modules with
 * persistence-of-vision latching (see hostSevenSeg.ts).
 */

import { useSyncExternalStore, type CSSProperties } from 'react'
import { getSnapshot, subscribe, type SegmentMask } from '@/hostSevenSeg'
import { cn } from '@/lib/utils'

const SEG_PATHS: Record<string, string> = {
  // Classic 7-segment layout in a 20×36 viewBox (DP sits outside to the right).
  A: 'M5 3 H15 L17 5 L15 7 H5 L3 5 Z',
  B: 'M17 6 L19 8 V16 L17 18 L15 16 V8 Z',
  C: 'M17 20 L19 22 V30 L17 32 L15 30 V22 Z',
  D: 'M5 33 H15 L17 35 L15 37 H5 L3 35 Z',
  E: 'M3 20 L5 22 V30 L3 32 L1 30 V22 Z',
  F: 'M3 6 L5 8 V16 L3 18 L1 16 V8 Z',
  G: 'M5 18 H15 L17 20 L15 22 H5 L3 20 Z',
}

const SEG_BITS: Array<{ key: keyof typeof SEG_PATHS; bit: number }> = [
  { key: 'A', bit: 0 },
  { key: 'B', bit: 1 },
  { key: 'C', bit: 2 },
  { key: 'D', bit: 3 },
  { key: 'E', bit: 4 },
  { key: 'F', bit: 5 },
  { key: 'G', bit: 6 },
]

function DigitGlyph({
  mask,
  scanning,
}: {
  mask: SegmentMask
  scanning: boolean
}) {
  const dpOn = (mask & (1 << 7)) !== 0
  return (
    <svg
      viewBox="0 0 24 40"
      className={cn('h-16 w-10 shrink-0 sm:h-20 sm:w-12', scanning && 'sevenseg-scan')}
      aria-hidden
    >
      <defs>
        <filter id="sevenseg-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Digits sit in a smoked bay */}
      <rect x="0.5" y="0.5" width="23" height="39" rx="2" className="fill-[var(--sevenseg-bay)] stroke-[var(--sevenseg-bay-edge)]" />
      {SEG_BITS.map(({ key, bit }) => {
        const on = (mask & (1 << bit)) !== 0
        return (
          <path
            key={key}
            d={SEG_PATHS[key]}
            className={on ? 'fill-[var(--sevenseg-on)]' : 'fill-[var(--sevenseg-off)]'}
            style={on ? { filter: 'url(#sevenseg-glow)' } : undefined}
          />
        )
      })}
      <circle
        cx="21"
        cy="35"
        r="1.6"
        className={dpOn ? 'fill-[var(--sevenseg-on)]' : 'fill-[var(--sevenseg-off)]'}
        style={dpOn ? { filter: 'url(#sevenseg-glow)' } : undefined}
      />
    </svg>
  )
}

export function SevenSegBody() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (snap.displays.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No <code className="font-mono text-foreground">gpio-7-segment</code> in
        this build&apos;s devicetree.
      </div>
    )
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {snap.displays.map((disp) => (
        <div key={disp.id} className="space-y-2">
          <div
            className="sevenseg-panel rounded-lg border border-border px-3 py-3"
            style={
              {
                '--sevenseg-bay': '#0c1014',
                '--sevenseg-bay-edge': '#1a222c',
                '--sevenseg-on': '#ff6a2a',
                '--sevenseg-off': '#2a1510',
              } as CSSProperties
            }
          >
            <div className="flex flex-wrap items-end justify-center gap-1.5 sm:gap-2">
              {disp.digits.map((mask, i) => (
                <DigitGlyph key={i} mask={mask} scanning={disp.active[i] === true} />
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{disp.label}</span>
            <span className="font-mono tabular-nums">
              {disp.columns}-digit · gpio-7-segment
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
