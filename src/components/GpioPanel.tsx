import { useCallback, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Lamp, LAMP_ROW } from '@/components/Lamp'
import { LevelDot } from '@/components/LevelDot'
import { formatGpioFlags, gpioFlagMacros } from '@/lib/gpioFlags'
import { revealDockRow } from '@/lib/dockReveal'
import { pinDisplayName } from '@/lib/pinLabel'
import {
  claimedPinsToken,
  getButtons,
  getClaimedPins,
  getLeds,
  getNgpios,
  isInputHigh,
  isPressed,
  isOutputHigh,
  setPressed,
  subscribe,
  type ClaimedPin,
  type Pin,
  type PinConsumerKind,
} from '@/hostGpio'

/**
 * GPIO bridge surfaces: keys and leds are their own dock rows; the controller
 * card is a claimed-pin table (docs/gpio-controller.md Proposal B).
 */

/**
 * Where a claimed pin's "used by" link goes, and the plain word it says after
 * the pin's label: one button, one LED, as the dock's Buttons and LEDs rows
 * name them.
 */
const CONSUMER_ROW: Record<
  PinConsumerKind,
  { key: string; deviceClass: 'keys' | 'led' | 'buzzer' | 'stepper' | 'auxdisplay'; kind: string }
> = {
  keys: { key: 'gpio-keys', deviceClass: 'keys', kind: 'button' },
  leds: { key: 'gpio-leds', deviceClass: 'led', kind: 'LED' },
  buzzer: { key: 'buzzer', deviceClass: 'buzzer', kind: 'buzzer' },
  stepper: { key: 'stepper', deviceClass: 'stepper', kind: 'stepper' },
  'seven-seg': { key: 'seven-seg', deviceClass: 'auxdisplay', kind: '7-seg' },
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
      <div className="flex flex-wrap gap-2">
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
      <div className={LAMP_ROW}>
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
            <th
              className="pb-1 pr-2 font-medium"
              title="Which level counts as on (pressed, lit), from the pin's devicetree flags"
            >
              active
            </th>
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
      ? // A key reads as lit when it is pressed, which on an active-low pin is
        // the opposite of its electrical level.
        pressable
        ? isPressed(pin.id)
        : isInputHigh(pin.id)
      : pin.direction === 'out'
        ? isOutputHigh(pin.id)
        : false

  const press = (down: boolean) => {
    if (pressable) setPressed(pin.id, down)
  }

  return (
    <tr className="border-b border-border/40 last:border-b-0">
      <td className="py-0.5 pr-2 font-mono text-muted-foreground">{pin.id}</td>
      <td
        className={cn(
          'py-0.5 pr-2 font-mono text-[10px] tracking-wide',
          pin.direction === 'in' && 'text-foreground',
          pin.direction === 'out' && 'text-primary-text',
          pin.direction === 'none' && 'text-muted-foreground/50',
        )}
      >
        {pin.direction === 'in' ? 'IN' : pin.direction === 'out' ? 'OUT' : '—'}
      </td>
      <td className="py-0.5 pr-2">
        {pressable ? (
          <button
            type="button"
            aria-label={`Drive pin ${pin.id} (${pin.consumer ? consumerName(pin.consumer) : 'input'})`}
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
      <td
        className="py-0.5 pr-2 font-mono text-[10px] text-muted-foreground"
        title={pin.flags !== undefined ? gpioFlagMacros(pin.flags) : undefined}
      >
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

/**
 * A key's or an LED's name as the dock's Buttons and LEDs rows show it
 * (SW0, not Host SW0), so the table and the row agree. Other consumers keep
 * their label: it names a part ("7-segment LED DIG1"), not the host.
 */
function consumerName(consumer: NonNullable<ClaimedPin['consumer']>): string {
  return consumer.kind === 'keys' || consumer.kind === 'leds'
    ? pinDisplayName(consumer.label)
    : consumer.label
}

function UsedByButton({
  consumer,
}: {
  consumer: NonNullable<ClaimedPin['consumer']>
}) {
  const target = CONSUMER_ROW[consumer.kind]
  const name = consumerName(consumer)
  return (
    <button
      type="button"
      aria-label={`Reveal ${target.kind} ${name}`}
      title={`Reveal ${consumer.label}`}
      onClick={() => revealDockRow(target.key, target.deviceClass)}
      className="flex max-w-full items-center gap-1 truncate text-left font-mono text-[10px] text-muted-foreground hover:text-foreground"
    >
      <span className="truncate font-medium text-foreground">{name}</span>
      <span className="shrink-0 opacity-80">· {target.kind}</span>
    </button>
  )
}

/**
 * A `gpio-keys` key, drawn as a key: raised on a ledge while it rests, sunk
 * and filled while held, with its name and a quiet "press" under it. It is
 * momentary like the real one, down for as long as the pointer (or Space or
 * Enter) is, so the guest sees a press of whatever length the reader gives
 * it. It used to be the grey tile the LED shares, with a bare 0 or 1 that
 * read as a counter; the state is in `aria-pressed` and the "pressed" hint.
 */
function ButtonPin({ pin }: { pin: Pin }) {
  const high = useSyncExternalStore(
    subscribe,
    useCallback(() => isPressed(pin.id), [pin.id]),
    () => false,
  )
  const name = pinDisplayName(pin.label)

  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={high}
      aria-label={`${name} (pin ${pin.id})`}
      title={`${pin.label} (pin ${pin.id}): press and hold`}
      onPointerDown={(e) => {
        setPressed(pin.id, true)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
      }}
      onPointerUp={() => setPressed(pin.id, false)}
      onPointerCancel={() => setPressed(pin.id, false)}
      onLostPointerCapture={() => setPressed(pin.id, false)}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault()
          setPressed(pin.id, true)
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          setPressed(pin.id, false)
        }
      }}
      className={cn(
        // The ledge is a hard shadow rather than a thicker border, so a press
        // sinks the key onto it without moving anything around it.
        'h-auto min-h-10 min-w-[4.5rem] touch-none select-none flex-col gap-0 px-3 py-1 leading-tight',
        'transition-[translate,box-shadow,background-color,border-color,color] duration-75',
        high
          ? 'translate-y-0.5 border-primary-solid bg-primary-solid text-primary-foreground shadow-none hover:bg-primary-solid'
          : 'border-muted-foreground/50 bg-secondary text-foreground shadow-[0_2px_0_0_color-mix(in_oklab,var(--color-muted-foreground)_55%,transparent)] hover:border-muted-foreground hover:bg-secondary',
      )}
    >
      <span className="text-xs font-medium">{name}</span>
      <span className={cn('text-[11px] font-normal', high ? 'text-primary-foreground' : 'text-muted-foreground')}>
        {high ? 'pressed' : 'press'}
      </span>
    </Button>
  )
}

/** A `gpio-leds` LED, drawn as a lamp (see Lamp). */
function LedPin({ pin }: { pin: Pin }) {
  const high = useSyncExternalStore(
    subscribe,
    useCallback(() => isOutputHigh(pin.id), [pin.id]),
    () => false,
  )

  return (
    <Lamp
      lit={high}
      name={pinDisplayName(pin.label)}
      title={`${pin.label} (pin ${pin.id}) ${high ? 'on' : 'off'}`}
    />
  )
}
