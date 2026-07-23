import { cn } from '@/lib/utils'

/**
 * Tiny inline area chart for rolling histories, shared by the Simulation and
 * Network panels. Scales to the max of the series, strokes in `currentColor`
 * so the wrapper's text class picks the hue.
 */
export function Sparkline({
  values,
  width = 268,
  height = 40,
  className,
  ariaLabel = 'Recent history',
}: {
  values: readonly number[]
  width?: number
  height?: number
  className?: string
  ariaLabel?: string
}) {
  if (values.length < 2) {
    // Reserve the height so the panel does not resize as history fills in.
    return <div className={className} style={{ height }} aria-hidden />
  }

  const max = Math.max(...values, 1e-6)
  const step = width / (values.length - 1)
  const point = (v: number, i: number) => {
    const x = i * step
    const y = height - 1 - (v / max) * (height - 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }
  const line = values.map(point).join(' ')
  const area = `0,${height} ${line} ${width},${height}`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('w-full', className)}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <polygon points={area} fill="currentColor" opacity={0.1} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
