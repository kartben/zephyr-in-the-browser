/**
 * Live SVD-style register map for any {@link RegisterMapSource}.
 *
 * Sensor cards, RTC cards, and future register-file parts share this panel —
 * the kind-specific UI stays a slider / clock / … surface; this is the
 * fine-grained view. Collapsed by default: the card only shows a small
 * "Registers" affordance until you open it. The panel is non-modal so you
 * can keep poking the rest of the simulator while it stays open.
 */

import { useEffect, useReducer, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  decodeFieldLabel,
  extractField,
  formatBitRange,
  formatRegHex,
} from '@/virtio/devices/registers/fields'
import {
  formatRegisterMapLocator,
  hasRegisterMap,
  type FieldDecl,
  type RegisterDecl,
  type RegisterMapSource,
} from '@/virtio/devices/registers/types'

/** ~20 Hz is plenty for a register readout. */
const REGMAP_UI_MS = 50

function useRegisterMap(chip: RegisterMapSource) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      const now = performance.now()
      const wait = REGMAP_UI_MS - (now - last)
      if (wait <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        refresh()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, wait)
    })
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
}

export function RegisterMapButton({
  chip,
  label,
}: {
  chip: RegisterMapSource
  /** Override the default "Registers (N)" affordance text. */
  label?: string
}) {
  const [open, setOpen] = useState(false)
  if (!hasRegisterMap(chip)) return null
  const count = chip.registers.length

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {label ?? `Registers (${count})`}
      </button>
      <RegisterMapDialog chip={chip} open={open} onOpenChange={setOpen} />
    </>
  )
}

function RegisterMapDialog({
  chip,
  open,
  onOpenChange,
}: {
  chip: RegisterMapSource
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  useRegisterMap(chip)
  const locator = formatRegisterMapLocator(chip)
  const named = chip.registers.filter((r) => r.name).length

  return (
    // Non-modal: keep the map open while poking the rest of the simulator.
    // Outside clicks must not dismiss it — only Escape / the close button.
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        className="max-w-2xl"
        showOverlay={false}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-baseline gap-2 pr-8">
            <span className="shrink-0 font-mono text-primary">{locator}</span>
            <span className="min-w-0 truncate">{chip.name}</span>
          </DialogTitle>
          <DialogDescription>
            {named > 0
              ? `${chip.registers.length} registers, ${named} named`
              : `${chip.registers.length} registers`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto border-t border-border px-3 py-2">
          <div className="space-y-0.5">
            {chip.registers.map((reg) => (
              <RegisterRow key={reg.addr} chip={chip} reg={reg} />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RegisterRow({ chip, reg }: { chip: RegisterMapSource; reg: RegisterDecl }) {
  const [open, setOpen] = useState(false)
  const word = chip.peek(reg.addr)
  const pointed = chip.getPointer() === reg.addr
  const title = reg.name ?? `REG_${formatRegHex(reg.addr, 1).slice(2)}`
  const hasFields = (reg.fields?.length ?? 0) > 0

  return (
    <div className={cn('rounded-md', open && 'bg-secondary/40')}>
      <button
        type="button"
        aria-expanded={hasFields ? open : undefined}
        title={reg.description}
        onClick={() => hasFields && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
          hasFields && 'hover:bg-secondary/60',
          pointed && 'ring-1 ring-inset ring-primary/40',
        )}
      >
        {hasFields ? (
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3 shrink-0 text-muted-foreground/70 transition-transform',
              open && 'rotate-90',
            )}
          />
        ) : (
          <span className="size-3 shrink-0" aria-hidden />
        )}

        <span className="w-10 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {formatRegHex(reg.addr, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        <AccessBadge access={reg.access} />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground">
          {formatRegHex(word, reg.bytes)}
        </span>
      </button>

      {open && hasFields && (
        <div className="space-y-0.5 pb-2 pl-5 pr-2">
          {reg.description && (
            <p className="px-2 pb-1 text-[10px] leading-relaxed text-muted-foreground">
              {reg.description}
            </p>
          )}
          {reg.fields!.map((field) => (
            <FieldRow key={`${field.name}-${field.lsb}`} chip={chip} reg={reg} field={field} word={word} />
          ))}
        </div>
      )}
    </div>
  )
}

function FieldRow({
  chip,
  reg,
  field,
  word,
}: {
  chip: RegisterMapSource
  reg: RegisterDecl
  field: FieldDecl
  word: number
}) {
  const value = extractField(word, field)
  const label = decodeFieldLabel(field, value)
  const editable = reg.access === 'rw'
  const width = field.msb - field.lsb + 1
  const max = (1 << width) - 1

  return (
    <div
      title={field.description}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded px-2 py-1 text-[11px]"
    >
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {formatBitRange(field.lsb, field.msb)}
      </span>
      <span className="min-w-0 truncate font-medium">{field.name}</span>

      {editable && field.values && field.values.length > 0 ? (
        <select
          aria-label={field.name}
          value={value}
          onChange={(e) => chip.setField(reg.addr, field, Number(e.target.value))}
          className="max-w-[11rem] rounded border border-input bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none"
        >
          {!field.values.some((entry) => entry.value === value) && (
            <option value={value}>{formatRegHex(value, 1)}</option>
          )}
          {field.values.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.name}
            </option>
          ))}
        </select>
      ) : editable && width === 1 ? (
        <label className="inline-flex items-center gap-1.5 justify-self-end text-muted-foreground">
          <input
            type="checkbox"
            checked={value !== 0}
            aria-label={field.name}
            onChange={(e) => chip.setField(reg.addr, field, e.target.checked ? 1 : 0)}
            className="accent-[var(--color-primary)]"
          />
          <span className="font-mono text-[10px] tabular-nums">{value}</span>
        </label>
      ) : editable ? (
        <input
          type="number"
          aria-label={field.name}
          min={0}
          max={max}
          value={value}
          onChange={(e) => chip.setField(reg.addr, field, Number(e.target.value))}
          className="w-16 justify-self-end rounded border border-input bg-background px-1.5 py-0.5 text-right font-mono text-[10px] tabular-nums outline-none"
        />
      ) : (
        <span className="justify-self-end font-mono text-[10px] tabular-nums text-muted-foreground">
          {label ? (
            <>
              <span className="text-foreground">{label}</span>
              <span className="ml-1 opacity-70">{formatRegHex(value, 1)}</span>
            </>
          ) : (
            formatRegHex(value, 1)
          )}
        </span>
      )}
    </div>
  )
}

function AccessBadge({ access }: { access: 'rw' | 'ro' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide',
        access === 'rw'
          ? 'bg-secondary text-muted-foreground'
          : 'bg-secondary/60 text-muted-foreground/80',
      )}
    >
      {access}
    </span>
  )
}
