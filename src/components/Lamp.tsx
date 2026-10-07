/**
 * An LED as the dock draws it: a lamp. A round light that glows while lit
 * and sits dark inside its outline while not, with the LED's name beside it,
 * and nothing about it that looks pressable. It used to sit in the same grey
 * tile as a key, so on the Button sample the LED read as a second button
 * that did nothing.
 *
 * GPIO LEDs and PWM LEDs both draw it. A `gpio-leds` node carries no colour
 * (Zephyr's binding allows only `label` on its children), so every lamp
 * lights in the accent, the violet of the GPIO table's level dots and the
 * row's collapsed badge: one line, one look, wherever it shows.
 */

import { cn } from '@/lib/utils'

/** The light itself, unlit. Class strings, so PwmLedsPanel can set them per frame. */
export const LAMP_OFF =
  'size-3.5 shrink-0 rounded-full border border-muted-foreground bg-secondary'
/** The light itself, lit. */
export const LAMP_ON =
  'size-3.5 shrink-0 rounded-full border border-primary bg-primary shadow-[0_0_8px_2px_var(--color-primary)]'
/**
 * A lamp and its name, side by side. The name keeps one colour: the light
 * says on or off, and a PWM lamp changes brightness every frame.
 */
export const LAMP_CELL = 'inline-flex min-w-0 items-center gap-1.5 text-[11px] leading-tight'
/** The row of lamps an LED group's body is. */
export const LAMP_ROW = 'flex flex-wrap items-center gap-x-4 gap-y-2'

export function Lamp({
  lit,
  name,
  title,
  className,
}: {
  lit: boolean
  name: string
  /** The tooltip: the devicetree label as written, the pin and the state. */
  title: string
  className?: string
}) {
  return (
    <span className={cn(LAMP_CELL, className)} title={title}>
      <span aria-hidden className={lit ? LAMP_ON : LAMP_OFF} />
      <span className="truncate text-foreground">
        {name}
        <span className="sr-only">{lit ? ', on' : ', off'}</span>
      </span>
    </span>
  )
}
