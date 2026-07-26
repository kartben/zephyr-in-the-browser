/** Dock body for attached I2C chips and live transactions. */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import { revealDockRow } from '@/lib/dockReveal'
import { i2cModel } from '@/virtio'
import { CHIP_TYPES, chipType, hasDriver } from '@/virtio/devices/registry'
import type { I2cChip, I2cTransaction } from '@/virtio/devices/i2c'
import { isJhd1313Backlight, isJhd1313Lcd } from '@/virtio/devices/chips/jhd1313'
import { isHt16k33 } from '@/virtio/devices/chips/ht16k33'
import { isLp5562 } from '@/virtio/devices/chips/lp5562'
import { isMemoryChip } from '@/virtio/devices/memory/model'
import { isDacChip } from '@/virtio/devices/dac/model'
import { isFuelGaugeChip } from '@/virtio/devices/fuel-gauge/model'
import { isPwmChip } from '@/virtio/devices/pwm/model'
import { isRtcChip } from '@/virtio/devices/rtc/model'
import { isSensorChip } from '@/virtio/devices/sensors/model'
import type { DeviceClass } from '@/deviceTopology'

export function I2cBody({ busLabel = 'virtio_i2c0' }: { busLabel?: string } = {}) {
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
  // Re-render driver/bus-only tags when the devicetree changes.
  useSyncExternalStore(subscribeDeviceTree, getDeviceTree, () => null)

  const recent = log.slice(-8).reverse()

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="space-y-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">On the bus</span>
        <ul className="space-y-1">
          {chips.length === 0 && (
            <li className="text-[11px] text-muted-foreground">Nothing attached.</li>
          )}
          {chips.map((chip) => (
            <li
              key={chip.address}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2 py-1"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-90"
                title={`Reveal ${chip.name} in the dock`}
                onClick={() =>
                  revealDockRow(
                    `${busLabel}:${chip.address.toString(16).padStart(2, '0')}`,
                    i2cChipClass(chip),
                  )
                }
              >
                <code className="font-mono text-[11px] text-primary">
                  0x{chip.address.toString(16).padStart(2, '0')}
                </code>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {chip.name}
                </span>
                {hasDriver(chip.address) ? (
                  <span className="text-[10px] text-emerald-400" title="The guest devicetree binds a driver here">
                    driver
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground" title="Answers on the bus, but no guest driver binds here">
                    bus only
                  </span>
                )}
              </button>
              <button
                aria-label={`Detach ${chip.name}`}
                title="Detach — the guest driver will start to NAK"
                onClick={() => {
                  for (const addr of detachAddresses(chip, chips)) {
                    i2cModel.detachChip(addr)
                  }
                }}
                className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <AttachRow chips={chips.map((c) => c.address)} />

      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Traffic</span>
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
        In the guest: <code className="font-mono text-foreground">i2c scan {busLabel}</code>{' '}
        finds every attached chip; a driver only binds at the addresses the devicetree
        declares.
      </p>
    </div>
  )
}

function AttachRow({ chips }: { chips: number[] }) {
  const [typeId, setTypeId] = useState(CHIP_TYPES[0].id)
  const [addr, setAddr] = useState(() => CHIP_TYPES[0].defaultAddress.toString(16))
  const [secondaryAddr, setSecondaryAddr] = useState(() =>
    (CHIP_TYPES[0].secondaryAddress ?? 0).toString(16),
  )
  const [error, setError] = useState<string | null>(null)

  const occupied = useMemo(() => new Set(chips), [chips])
  const type = chipType(typeId)
  const parsed = Number.parseInt(addr, 16)
  const parsedSecondary =
    type?.secondaryAddress !== undefined ? Number.parseInt(secondaryAddr, 16) : undefined
  const validPrimary = Number.isInteger(parsed) && parsed >= 0x03 && parsed <= 0x77
  const validSecondary =
    parsedSecondary === undefined ||
    (Number.isInteger(parsedSecondary) &&
      parsedSecondary >= 0x03 &&
      parsedSecondary <= 0x77 &&
      parsedSecondary !== parsed)
  const valid = validPrimary && validSecondary
  const takenPrimary = validPrimary && occupied.has(parsed)
  const takenSecondary =
    parsedSecondary !== undefined && validSecondary && occupied.has(parsedSecondary)
  const taken = takenPrimary || takenSecondary

  const onTypeChange = (id: string) => {
    setTypeId(id)
    setError(null)
    const t = chipType(id)
    if (t) {
      setAddr(t.defaultAddress.toString(16))
      if (t.secondaryAddress !== undefined) {
        setSecondaryAddr(t.secondaryAddress.toString(16))
      }
    }
  }

  const attach = () => {
    if (!type || !valid) return
    try {
      const created = type.create(parsed, parsedSecondary)
      const list = Array.isArray(created) ? created : [created]
      // Attach all-or-nothing: if a later address collides, roll back earlier ones.
      const attached: number[] = []
      try {
        for (const chip of list) {
          i2cModel.attachChip(chip)
          attached.push(chip.address)
        }
        setError(null)
      } catch (err) {
        for (const address of attached) i2cModel.detachChip(address)
        throw err
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const secondary = type?.secondaryAddress !== undefined

  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">Attach</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={typeId}
          aria-label="Chip type"
          onChange={(e) => onTypeChange(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground outline-none"
        >
          {CHIP_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <AddrField
          label={secondary ? 'LCD' : 'Address'}
          ariaLabel={secondary ? 'LCD address' : 'Address'}
          value={addr}
          onChange={(v) => {
            setAddr(v)
            setError(null)
          }}
        />
        {secondary ? (
          <AddrField
            label={type.secondaryLabel ?? '2nd'}
            ariaLabel={`${type.secondaryLabel ?? 'secondary'} address`}
            value={secondaryAddr}
            onChange={(v) => {
              setSecondaryAddr(v)
              setError(null)
            }}
          />
        ) : null}
        <button
          onClick={attach}
          disabled={!valid || taken}
          className="rounded-md border border-input bg-secondary px-2 py-1 text-[11px] text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          Attach
        </button>
      </div>
      {error ? (
        <p className="text-[10px] text-destructive">{error}</p>
      ) : taken ? (
        <p className="text-[10px] text-destructive">
          {takenPrimary
            ? `0x${addr} is already taken.`
            : `0x${secondaryAddr} is already taken.`}
        </p>
      ) : !validSecondary && parsedSecondary === parsed ? (
        <p className="text-[10px] text-destructive">LCD and backlight need different addresses.</p>
      ) : valid ? (
        <p className="text-[10px] text-muted-foreground">
          {secondary
            ? hasDriver(parsed)
              ? 'Places both endpoints; the guest driver binds at the LCD address.'
              : 'Places both endpoints (bus only — no guest driver at the LCD address).'
            : hasDriver(parsed)
              ? 'The devicetree binds a driver here.'
              : 'Bus only — i2c scan finds it, but no guest driver binds.'}
        </p>
      ) : (
        <p className="text-[10px] text-destructive">Enter an address between 0x03 and 0x77.</p>
      )}
    </div>
  )
}

function AddrField({
  label,
  ariaLabel,
  value,
  onChange,
}: {
  label: string
  ariaLabel: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <span className="flex items-center gap-1 rounded-md border border-input bg-background px-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px] text-muted-foreground">0x</span>
      <input
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 2))}
        className="w-7 bg-transparent py-1 font-mono text-[11px] text-foreground outline-none"
      />
    </span>
  )
}

function i2cChipClass(chip: I2cChip): DeviceClass {
  if (isSensorChip(chip)) return 'sensor'
  if (isMemoryChip(chip)) return 'memory'
  if (isRtcChip(chip)) return 'rtc'
  if (isJhd1313Lcd(chip) || isJhd1313Backlight(chip)) return 'auxdisplay'
  if (isHt16k33(chip)) return 'led'
  if (isLp5562(chip)) return 'led'
  if (isPwmChip(chip)) return 'pwm'
  if (isDacChip(chip)) return 'dac'
  if (isFuelGaugeChip(chip)) return 'fuel-gauge'
  if ('isOn' in chip && 'memory' in chip) return 'display'
  return 'other'
}

// A JHD1313 module is two bus endpoints; detach both to avoid stale backlight links.
function detachAddresses(chip: I2cChip, onBus: readonly I2cChip[]): number[] {
  if (isJhd1313Lcd(chip) && chip.backlight) {
    return [chip.address, chip.backlight.address]
  }
  if (isJhd1313Backlight(chip)) {
    const lcd = onBus.find((c) => isJhd1313Lcd(c) && c.backlight === chip)
    if (lcd) return [lcd.address, chip.address]
  }
  return [chip.address]
}

const HEX = (n: number) => n.toString(16).padStart(2, '0')

function TransactionRow({ entry }: { entry: I2cTransaction }) {
  // Keep long payloads to one line; byteLength is the on-the-wire size.
  const shown = Array.from(entry.bytes.subarray(0, 6)).map(HEX).join(' ')
  const total = entry.byteLength
  const elided = total > 6 ? ` +${total - 6}` : ''

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
