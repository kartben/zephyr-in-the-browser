import { useCallback, useState, useSyncExternalStore } from 'react'
import { ChevronDown, CircuitBoard, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  BUTTONS,
  LEDS,
  available,
  isInputHigh,
  isOutputHigh,
  subscribe,
  toggleInput,
  type Pin,
} from '@/hostGpio'

/**
 * Floating control for the qemu,host-gpio bridge.
 *
 * Hidden entirely when the running emulator has no GPIO device, so a stock
 * qemu-wasm build shows no dead UI. Buttons drive the guest's input pins;
 * the LED row reflects the output pins the guest drives. Reach them from the
 * shell with `gpio get host_gpio <pin>` and `gpio set host_gpio <pin> <0|1>`.
 */
export function GpioPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const isAvailable = useSyncExternalStore(subscribe, available, () => false)
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)

  if (!isAvailable || dismissed) return null

  return (
    <div className="pointer-events-auto w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          !collapsed && 'border-b border-border',
        )}
      >
        <CircuitBoard className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">Host GPIO</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? 'Expand host GPIO' : 'Collapse host GPIO'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide GPIO panel"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="space-y-3 px-3 py-3">
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Inputs — buttons
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {BUTTONS.map((pin) => (
                <ButtonPin key={pin.id} pin={pin} />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Outputs — LEDs
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {LEDS.map((pin) => (
                <LedPin key={pin.id} pin={pin} />
              ))}
            </div>
          </div>

          <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
            In the guest:{' '}
            <code className="font-mono text-foreground">gpio get host_gpio 0</code> reads
            a button,{' '}
            <code className="font-mono text-foreground">gpio set host_gpio 4 1</code>{' '}
            lights an LED.
          </p>
        </div>
      )}
    </div>
  )
}

function ButtonPin({ pin }: { pin: Pin }) {
  const high = useSyncExternalStore(
    subscribe,
    useCallback(() => isInputHigh(pin.id), [pin.id]),
    () => false,
  )

  return (
    <button
      type="button"
      aria-pressed={high}
      aria-label={`${pin.label} (pin ${pin.id})`}
      onClick={() => toggleInput(pin.id)}
      className={cn(
        'flex flex-col items-center gap-0.5 rounded-md border py-1.5 text-[11px] font-medium transition-colors',
        high
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span>{pin.label}</span>
      <span className="font-mono text-[10px] tabular-nums opacity-80">{high ? '1' : '0'}</span>
    </button>
  )
}

function LedPin({ pin }: { pin: Pin }) {
  const high = useSyncExternalStore(
    subscribe,
    useCallback(() => isOutputHigh(pin.id), [pin.id]),
    () => false,
  )

  return (
    <div
      className="flex flex-col items-center gap-1 rounded-md border border-border bg-secondary py-1.5 text-[11px] text-muted-foreground"
      title={`${pin.label} (pin ${pin.id}) ${high ? 'on' : 'off'}`}
    >
      <span
        aria-hidden
        className={cn(
          'size-3 rounded-full border transition-colors',
          high
            ? 'border-primary bg-primary shadow-[0_0_6px_1px_var(--color-primary)]'
            : 'border-border bg-transparent',
        )}
      />
      <span>{pin.label}</span>
    </div>
  )
}
