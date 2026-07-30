/**
 * The dot a line's level wears anywhere in the UI: lit while the line is
 * driven, dark while it rests.
 *
 * Shared on purpose. A SPI chip select is a GPIO the controller drives low, so
 * the CS indicator on a chip card and the level column on the GPIO controller
 * are the same fact and have to look the same.
 */

import { cn } from '@/lib/utils'

export function LevelDot({ high, className }: { high: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full align-middle',
        high ? 'bg-primary shadow-[0_0_5px_var(--color-primary)]' : 'bg-border',
        className,
      )}
    />
  )
}
