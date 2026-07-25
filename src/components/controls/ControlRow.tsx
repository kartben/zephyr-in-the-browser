/**
 * The dock's control vocabulary: label · control · live value on one grid
 * line. The old bodies spent three stacked lines per control (label row,
 * control row, follow row); at dock width a single 24px line reads better and
 * triples what fits on screen. Every body generates these from its declarative
 * table (SensorDecl channels/attributes, GNSS FIELDS, impairments) — adding a
 * device stays a declaration, not new layout.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function ControlRow({
  label,
  value,
  title,
  children,
}: {
  label: string
  /** Right-aligned mono readout ('21.00 °C'); omit for full-width controls. */
  value?: ReactNode
  title?: string
  children: ReactNode
}) {
  return (
    <label
      title={title}
      className="grid grid-cols-[minmax(60px,auto)_1fr_auto] items-center gap-x-2 py-0.5"
    >
      <span className="truncate text-xs">{label}</span>
      {children}
      {value !== undefined && (
        <span className="min-w-[64px] text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {value}
        </span>
      )}
    </label>
  )
}

export function SliderControl({
  label,
  value,
  unit,
  min,
  max,
  step,
  disabled = false,
  onChange,
  format = (v) => v.toFixed(2),
}: {
  label: string
  value: number
  unit: string
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (value: number) => void
  format?: (value: number) => string
}) {
  return (
    <ControlRow label={label} value={`${format(value)}${unit ? ` ${unit}` : ''}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      />
    </ControlRow>
  )
}

export function NumberControl({
  label,
  unit,
  value,
  min,
  max,
  step,
  disabled = false,
  onChange,
}: {
  label: string
  unit: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (value: number) => void
}) {
  return (
    <ControlRow label={label}>
      <span className="col-span-2 flex items-center rounded-md border border-input bg-background px-2">
        <input
          type="number"
          aria-label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="min-w-0 flex-1 bg-transparent py-1 text-right font-mono text-xs tabular-nums text-foreground outline-none disabled:opacity-50"
        />
        {unit && <span className="ml-1 text-[11px] text-muted-foreground">{unit}</span>}
      </span>
    </ControlRow>
  )
}

/** Compact checkbox chip; lay several in a `flex flex-wrap gap-1.5` row. */
export function CheckControl({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px]',
        checked ? 'border-primary/60 text-foreground' : 'border-border text-muted-foreground',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--color-primary)]"
      />
      {label}
    </label>
  )
}

export function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: number
  options: Array<{ label: string; value: number }>
  onChange: (value: number) => void
}) {
  return (
    <ControlRow label={label}>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="col-span-2 rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </ControlRow>
  )
}
