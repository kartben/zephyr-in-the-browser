import { useCallback, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import {
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
 * Buttons stay here. `gpio-leds` get their own LED-class dock row
 * ({@link GpioLedsBody}) — same split as gpio-buzzer / pwm-leds.
 */

/** Buttons without the frame, shared by the dock row and the window. */
export function GpioBody() {
  const node = useSyncExternalStore(subscribe, controllerNode, () => 'host_gpio')
  // Devicetree-derived when a zephyr.dts is loaded (with the wiring's own pin
  // labels), the bridge's full fan-out otherwise. A section with no declared
  // pins disappears rather than showing an empty grid.
  const buttons = useSyncExternalStore(subscribe, getButtons, () => [])

  return (
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

      <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
        In the guest:{' '}
        <code className="font-mono text-foreground">gpio get {node} 0</code> reads
        a button,{' '}
        <code className="font-mono text-foreground">gpio set {node} 4 1</code>{' '}
        lights an LED.
      </p>
    </div>
  )
}

/**
 * Dock body for a `gpio-leds` group — LED-class sibling of {@link GpioBody}.
 * Same cell chrome as before; levels still come from {@link getLeds}.
 */
export function GpioLedsBody() {
  const node = useSyncExternalStore(subscribe, controllerNode, () => 'host_gpio')
  const leds = useSyncExternalStore(subscribe, getLeds, () => [])

  if (leds.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
        No <code className="font-mono text-foreground">gpio-leds</code> in this
        build.
      </div>
    )
  }

  return (
    <div className="space-y-3 px-3 py-3">
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

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Zephyr&apos;s stock{' '}
        <code className="font-mono text-foreground">gpio-leds</code> —{' '}
        <code className="font-mono text-foreground">gpio set {node} 4 1</code>{' '}
        lights an LED.
      </p>
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
