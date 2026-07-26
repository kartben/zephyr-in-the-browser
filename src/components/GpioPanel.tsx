/** Dock bodies for GPIO controller, keys, and LED rows. */

import { useCallback, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { formatGpioFlags } from '@/lib/gpioFlags'
import { revealDockRow } from '@/lib/dockReveal'
import {
  claimedPinsToken,
  getButtons,
  getClaimedPins,
  getLeds,
  getNgpios,
  isInputHigh,
  isOutputHigh,
  setInput,
  subscribe,
  type ClaimedPin,
  type Pin,
  type PinConsumerKind,
} from '@/hostGpio'

/**
 * GPIO bridge surfaces: keys and leds are their own dock rows; the controller
 * card is a claimed-pin table (docs/gpio-controller.md Proposal B).
 */

const CONSUMER_ROW: Record<PinConsumerKind, { key: string; deviceClass: 'keys' | 'led' | 'buzzer'; kind: string }> =
  {
    keys: { key: 'gpio-keys', deviceClass: 'keys', kind: 'keys' },
    leds: { key: 'gpio-leds', deviceClass: 'led', kind: 'leds' },
    buzzer: { key: 'buzzer', deviceClass: 'buzzer', kind: 'buzzer' },
  }

/** Buttons without the frame — `gpio-keys` dock body. */
export function GpioKeysBody() {
  const buttons = useSyncExternalStore(subscribe, getButtons, () => [])

  if (buttons.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
        No <code className="font-mono text-foreground">gpio-keys</code> in this
        build.
      </div>
    )
  }

  return (
    <div className="px-3 py-3">
      <div className="grid grid-cols-4 gap-1.5">
        {buttons.map((pin) => (
          <ButtonPin key={pin.id} pin={pin} />
        ))}
      </div>
    </div>
  )
}

/** LED strip — `gpio-leds` dock body. */
export function GpioLedsBody() {
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
    <div className="px-3 py-3">
      <div className="grid grid-cols-4 gap-1.5">
        {leds.map((pin) => (
          <LedPin key={pin.id} pin={pin} />
        ))}
      </div>
    </div>
  )
}

/** Claimed-pin table for the bridged GPIO controller. */
export function GpioBody() {
  useSyncExternalStore(subscribe, claimedPinsToken, () => '')
  const pins = getClaimedPins()
  const ngpios = getNgpios()

  if (pins.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
        No claimed pins on this controller yet.
      </div>
    )
  }

  return (
    <div className="px-3 py-2">
      <table className="w-full border-collapse text-[11px] tabular-nums">
        <thead>
          <tr className="text-left text-[10px] font-medium text-muted-foreground">
            <th className="pb-1 pr-2 font-medium">#</th>
            <th className="pb-1 pr-2 font-medium">dir</th>
            <th className="pb-1 pr-2 font-medium" aria-label="Level" />
            <th className="pb-1 pr-2 font-medium">flags</th>
            <th className="pb-1 font-medium">used by</th>
          </tr>
        </thead>
        <tbody>
          {pins.map((pin) => (
            <ClaimedPinRow key={pin.id} pin={pin} />
          ))}
        </tbody>
      </table>
      <p className="sr-only">
        {pins.length} claimed of {ngpios} pins
      </p>
    </div>
  )
}

function ClaimedPinRow({ pin }: { pin: ClaimedPin }) {
  const pressable = pin.direction === 'in' && pin.consumer?.kind === 'keys'
  const high =
    pin.direction === 'in'
      ? isInputHigh(pin.id)
      : pin.direction === 'out'
        ? isOutputHigh(pin.id)
        : false

  const press = (down: boolean) => {
    if (pressable) setInput(pin.id, down)
  }

  return (
    <tr className="border-b border-border/40 last:border-b-0">
      <td className="py-0.5 pr-2 font-mono text-muted-foreground">{pin.id}</td>
      <td
        className={cn(
          'py-0.5 pr-2 font-mono text-[10px] tracking-wide',
          pin.direction === 'in' && 'text-foreground',
          pin.direction === 'out' && 'text-primary',
          pin.direction === 'none' && 'text-muted-foreground/50',
        )}
      >
        {pin.direction === 'in' ? 'IN' : pin.direction === 'out' ? 'OUT' : '—'}
      </td>
      <td className="py-0.5 pr-2">
        {pressable ? (
          <button
            type="button"
            aria-label={`Drive pin ${pin.id} (${pin.consumer?.label ?? 'input'})`}
            aria-pressed={high}
            className="touch-none rounded p-0.5"
            onPointerDown={(e) => {
              press(true)
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* ignore */
              }
            }}
            onPointerUp={() => press(false)}
            onPointerCancel={() => press(false)}
            onLostPointerCapture={() => press(false)}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault()
                press(true)
              }
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                press(false)
              }
            }}
          >
            <LevelDot high={high} />
          </button>
        ) : (
          <LevelDot high={pin.direction !== 'none' && high} />
        )}
      </td>
      <td className="py-0.5 pr-2 font-mono text-[10px] text-muted-foreground">
        {pin.flags !== undefined ? formatGpioFlags(pin.flags) : '—'}
      </td>
      <td className="max-w-[9rem] py-0.5">
        {pin.consumer ? (
          <UsedByButton consumer={pin.consumer} />
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  )
}

function LevelDot({ high }: { high: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-[7px] rounded-full align-middle',
        high ? 'bg-primary shadow-[0_0_5px_var(--color-primary)]' : 'bg-border',
      )}
    />
  )
}

function UsedByButton({
  consumer,
}: {
  consumer: NonNullable<ClaimedPin['consumer']>
}) {
  const target = CONSUMER_ROW[consumer.kind]
  return (
    <button
      type="button"
      aria-label={`Reveal ${target.kind} ${consumer.label}`}
      title={`Reveal ${consumer.label}`}
      onClick={() => revealDockRow(target.key, target.deviceClass)}
      className="flex max-w-full items-center gap-1 truncate text-left font-mono text-[10px] text-muted-foreground hover:text-foreground"
    >
      <span className="truncate font-medium text-foreground">{consumer.label}</span>
      <span className="shrink-0 opacity-80">· {target.kind}</span>
    </button>
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
      onPointerDown={(e) => {
        setInput(pin.id, true)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
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
