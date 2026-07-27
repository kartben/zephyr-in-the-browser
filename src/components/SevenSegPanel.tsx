/**
 * Dock body for `gpio-7-segment`: multiplexed LED digit modules with
 * persistence-of-vision latching (see hostSevenSeg.ts).
 *
 * Digit geometry follows Brandon White’s sevenSeg.js (MIT) — viewBox 57×80,
 * shared h-seg / v-seg polylines with mirror transforms — rendered as plain
 * SVG so we stay off jQuery. https://brandonlwhite.github.io/sevenSeg.js/
 */

import { useId, useSyncExternalStore, type CSSProperties } from 'react'
import { getSnapshot, subscribe, type SegmentMask } from '@/hostSevenSeg'
import { cn } from '@/lib/utils'

/** Horizontal segment polyline from sevenSeg.js (`#h-seg`). */
const H_SEG = 'M11 0 L37 0 L42 5 L37 10 L11 10 L6 5 Z'
/** Vertical segment polyline from sevenSeg.js (`#v-seg`). */
const V_SEG = 'M0 11 L5 6 L10 11 L10 34 L5 39 L0 39 Z'

/**
 * sevenSeg.js places each segment with `<use>` + scale mirrors. Expanded to
 * absolute paths so React can toggle fill without xlink.
 *
 *   A: h-seg @ (0,0)
 *   B: v-seg, translate(-48,0) then scale(-1,1)  → right-top
 *   C: v-seg, translate(-48,-80) then scale(-1,-1) → right-bottom
 *   D: h-seg @ (0,70)
 *   E: v-seg, translate(0,-80) then scale(1,-1) → left-bottom
 *   F: v-seg @ (0,0)
 *   G: h-seg @ (0,35)
 */
const SEG_PATHS: string[] = [
  /* A */ H_SEG,
  /* B */ 'M48 11 L43 6 L38 11 L38 34 L43 39 L48 39 Z',
  /* C */ 'M48 69 L43 74 L38 69 L38 46 L43 41 L48 41 Z',
  /* D */ 'M11 70 L37 70 L42 75 L37 80 L11 80 L6 75 Z',
  /* E */ 'M0 69 L5 74 L10 69 L10 46 L5 41 L0 41 Z',
  /* F */ V_SEG,
  /* G */ 'M11 35 L37 35 L42 40 L37 45 L11 45 L6 40 Z',
]

function DigitGlyph({
  mask,
  scanning,
}: {
  mask: SegmentMask
  scanning: boolean
}) {
  const reactId = useId().replace(/:/g, '')
  const glowId = `sevenseg-glow-${reactId}`
  const dpOn = (mask & (1 << 7)) !== 0

  return (
    <svg
      // Vertical viewBox pad keeps skew + glow off the panel edge. Keep the
      // horizontal crop near the glyph bounds (incl. DP) so digits abut —
      // no flex gap and no negative margins that smash segment bodies together.
      viewBox="-2 -12 61 108"
      className={cn(
        'h-[4.75rem] w-[2.7rem] shrink-0 overflow-visible sm:h-[6.25rem] sm:w-[3.55rem]',
        scanning && 'sevenseg-scan',
      )}
      aria-hidden
    >
      <defs>
        <filter id={glowId} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Slight classic LED slant (sevenSeg `slant: 8`). */}
      <g transform="translate(2,10) skewX(-8)">
        {SEG_PATHS.map((d, bit) => {
          const on = (mask & (1 << bit)) !== 0
          return (
            <path
              key={bit}
              d={d}
              fill={on ? 'var(--sevenseg-on)' : 'var(--sevenseg-off)'}
              style={on ? { filter: `url(#${glowId})` } : undefined}
            />
          )
        })}
        <circle
          cx="52"
          cy="75"
          r="5"
          fill={dpOn ? 'var(--sevenseg-on)' : 'var(--sevenseg-off)'}
          style={dpOn ? { filter: `url(#${glowId})` } : undefined}
        />
      </g>
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
            className="sevenseg-panel overflow-visible rounded-md px-6 py-6"
            style={
              {
                // sevenSeg.js defaults: Red on / #320000 off / Black bay —
                // punched up slightly so lit digits read on the dark dock.
                '--sevenseg-on': '#ff2a2a',
                '--sevenseg-off': '#3a0a0a',
              } as CSSProperties
            }
          >
            <div className="flex flex-wrap items-end justify-center">
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
