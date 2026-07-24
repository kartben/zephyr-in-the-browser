import { useCallback, useSyncExternalStore } from 'react'
import { CircuitBoard } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { cn } from '@/lib/utils'
import {
  available,
  controllerNode,
  getButtons,
  getLeds,
  isInputHigh,
  isOutputHigh,
  setInput,
  subscribe,
  type Pin,
} from '@/hostGpio'

/**
 * Floating control for the GPIO bridge — the Cortex-M3's qemu,host-gpio or the
 * Cortex-A53's VIRTIO GPIO, which src/hostGpio.ts presents identically.
 *
 * Hidden entirely when the running emulator has no GPIO device, so a stock
 * qemu-wasm build shows no dead UI. Buttons are momentary — they drive their
 * input pin high only while held, like a real push button — and the LED row
 * reflects the output pins the guest drives. Reach them from the shell with
 * `gpio get <controller> <pin>` and `gpio set <controller> <pin> <0|1>`, where
 * the controller is whichever device is bound — the hint below names it.
 */
export function GpioPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const isAvailable = useSyncExternalStore(subscribe, available, () => false)
  const node = useSyncExternalStore(subscribe, controllerNode, () => 'host_gpio')
  // Devicetree-derived when a zephyr.dts is loaded (with the wiring's own pin
  // labels), the bridge's full fan-out otherwise. A section with no declared
  // pins disappears rather than showing an empty grid.
  const buttons = useSyncExternalStore(subscribe, getButtons, () => [])
  const leds = useSyncExternalStore(subscribe, getLeds, () => [])

  if (!isAvailable) return null

  return (
    <PanelFrame id="gpio" title="Host GPIO" icon={CircuitBoard} defaultExpanded={defaultExpanded}>
      <div className="space-y-3 px-3 py-3">
        {buttons.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Inputs — buttons
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {buttons.map((pin) => (
                <ButtonPin key={pin.id} pin={pin} />
              ))}
            </div>
          </div>
        )}

        {leds.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Outputs — LEDs
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {leds.map((pin) => (
                <LedPin key={pin.id} pin={pin} />
              ))}
            </div>
          </div>
        )}

        <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
          In the guest:{' '}
          <code className="font-mono text-foreground">gpio get {node} 0</code> reads
          a button,{' '}
          <code className="font-mono text-foreground">gpio set {node} 4 1</code>{' '}
          lights an LED.
        </p>
      </div>
    </PanelFrame>
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
      // Momentary, not latching: the pin stays high only while the control is
      // held. Pointer capture keeps the release (pointerup) on this element
      // even if the cursor slides off it while pressed; the keyboard handlers
      // give Space/Enter the same press-and-hold behaviour.
      onPointerDown={(e) => {
        setInput(pin.id, true)
        // Capture so the release lands here even if the cursor slides off; a
        // press must never latch just because capture was refused.
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* no active pointer to capture — onPointerUp still releases */
        }
      }}
      onPointerUp={() => setInput(pin.id, false)}
      onPointerCancel={() => setInput(pin.id, false)}
      onLostPointerCapture={() => setInput(pin.id, false)}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault()
          setInput(pin.id, true)
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          setInput(pin.id, false)
        }
      }}
      className={cn(
        'flex touch-none select-none flex-col items-center gap-0.5 rounded-md border py-1.5 text-[11px] font-medium transition-colors',
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
