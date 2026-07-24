import { useCallback, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Cable, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { i2cModel, isBound, subscribeBinds } from '@/virtio'
import type { I2cTransaction } from '@/virtio/devices/i2c'

/**
 * Floating view of the browser's I2C bus.
 *
 * The bus and every chip on it are page-side models (src/virtio/devices/), so
 * unlike the other panels this one is not a control surface onto a QEMU device
 * — it is a window onto the device itself. What it shows is therefore the
 * truth rather than a readback: the chips that are attached, and every message
 * that crossed the bus.
 *
 * The transaction log is the reason this panel earns its space. An I2C bug is
 * almost always "the driver sent something other than what you assumed", and
 * without a trace the only evidence is a return code. Scan NAKs are filtered
 * out by the model, so a 116-address `i2c scan` does not bury the traffic that
 * matters.
 */
export function I2cPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const isAvailable = useSyncExternalStore(
    subscribeBinds,
    useCallback(() => isBound('i2c'), []),
    () => false,
  )
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)

  const chips = useSyncExternalStore(
    i2cModel.subscribe,
    i2cModel.chips,
    useCallback(() => [], []),
  )
  const log = useSyncExternalStore(
    i2cModel.subscribe,
    i2cModel.transactions,
    useCallback(() => [], []),
  )

  if (!isAvailable || dismissed) return null

  // Newest first, and only as many as fit without turning the panel into a
  // wall — the whole log is still there for anyone who wants it.
  const recent = log.slice(-8).reverse()

  return (
    <div className="pointer-events-auto w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          !collapsed && 'border-b border-border',
        )}
      >
        <Cable className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">I2C bus</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {chips.length} {chips.length === 1 ? 'chip' : 'chips'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? 'Expand I2C panel' : 'Collapse I2C panel'}
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
            aria-label="Hide I2C panel"
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
              On the bus
            </span>
            <ul className="space-y-1">
              {chips.map((chip) => (
                <li
                  key={chip.address}
                  className="flex items-baseline gap-2 rounded-md border border-border bg-secondary px-2 py-1"
                >
                  <code className="font-mono text-[11px] text-primary">
                    0x{chip.address.toString(16).padStart(2, '0')}
                  </code>
                  <span className="text-[11px] text-muted-foreground">{chip.name}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                Traffic
              </span>
              {log.length > 0 && (
                <button
                  className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => i2cModel.clearTransactions()}
                >
                  clear
                </button>
              )}
            </div>
            {recent.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Nothing yet — the guest has not touched the bus.
              </p>
            ) : (
              <ul className="space-y-0.5 font-mono text-[10px]">
                {recent.map((entry) => (
                  <TransactionRow key={entry.id} entry={entry} />
                ))}
              </ul>
            )}
          </div>

          <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
            In the guest:{' '}
            <code className="font-mono text-foreground">i2c scan virtio_i2c0</code>{' '}
            finds these chips,{' '}
            <code className="font-mono text-foreground">sensor get tmp112@48</code>{' '}
            reads the temperature slider through Zephyr&apos;s stock driver.
          </p>
        </div>
      )}
    </div>
  )
}

const HEX = (n: number) => n.toString(16).padStart(2, '0')

function TransactionRow({ entry }: { entry: I2cTransaction }) {
  // Long payloads are truncated rather than wrapped: the interesting bytes of
  // an I2C message are almost always the first few.
  const shown = Array.from(entry.bytes.subarray(0, 6)).map(HEX).join(' ')
  const elided = entry.bytes.length > 6 ? ` +${entry.bytes.length - 6}` : ''

  return (
    <li className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={entry.dir === 'read' ? 'text-sky-400' : 'text-amber-400'}>
        {entry.dir === 'read' ? 'R' : 'W'}
      </span>
      <span className="text-primary">0x{HEX(entry.address)}</span>
      <span className={cn('truncate', entry.ok ? 'text-foreground' : 'text-destructive')}>
        {shown || '(none)'}
        {elided}
      </span>
      {!entry.ok && <span className="ml-auto text-destructive">NAK</span>}
    </li>
  )
}
