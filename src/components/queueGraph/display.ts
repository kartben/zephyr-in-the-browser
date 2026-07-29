export function capacityFillFraction(depth: number, capacity: number): number {
  if (capacity <= 0) return 0
  return Math.max(0, Math.min(1, depth / capacity))
}

const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const exactFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

/** Keep large bounds readable inside a fixed-size node without hiding exact values in its title. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return '?'
  const rounded = Math.max(0, Math.round(value))
  return rounded < 10_000 ? exactFormatter.format(rounded) : compactFormatter.format(rounded)
}

export function compactCapacity(depth: number, capacity: number | null): string {
  return capacity == null ? compactCount(depth) : `${compactCount(depth)}/${compactCount(capacity)}`
}
