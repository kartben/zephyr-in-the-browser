import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import { revealDockRow } from '@/lib/dockReveal'
import { attachUserSpi, detachUserSpi, spiModel } from '@/virtio'
import type { SpiChip, SpiTransaction } from '@/virtio/devices/spi'
import { isSpiFlashChip } from '@/virtio/devices/chips/w25q'
import { isSct2024 } from '@/virtio/devices/chips/sct2024'
import { isWs2812 } from '@/virtio/devices/chips/ws2812'
import { isPt6314 } from '@/virtio/devices/chips/pt6314'
import { isTmc50xx } from '@/virtio/devices/chips/tmc50xx'
import { SPI_CHIP_TYPES, spiChipType } from '@/virtio/devices/spiRegistry'
import type { DeviceClass } from '@/deviceTopology'

/**
 * The browser's SPI bus — roster, attach, traffic — mirroring I2cBody.
 * Chip-select replaces the 7-bit address; roster rows navigate to the dock
 * card for that part when one exists.
 */
export function SpiBody({ busLabel = 'virtio_spi0' }: { busLabel?: string } = {}) {
  const chips = useSyncExternalStore(
    spiModel.subscribe,
    spiModel.chips,
    useCallback(() => [], []),
  )
  const log = useSyncExternalStore(
    spiModel.subscribe,
    spiModel.transactions,
    useCallback(() => [], []),
  )
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
              key={chip.cs}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2 py-1"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-90"
                title={`Reveal ${chip.name} in the dock`}
                onClick={() =>
                  revealDockRow(`${busLabel}:${chip.cs.toString(16)}`, spiChipClass(chip))
                }
              >
                <code className="font-mono text-[11px] text-primary">CS{chip.cs}</code>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {chip.name}
                </span>
                {hasSpiDriver(chip.cs) ? (
                  <span
                    className="text-[10px] text-emerald-400"
                    title="The guest devicetree binds a driver here"
                  >
                    driver
                  </span>
                ) : (
                  <span
                    className="text-[10px] text-muted-foreground"
                    title="Answers on the bus, but no guest driver binds here"
                  >
                    bus only
                  </span>
                )}
              </button>
              <button
                aria-label={`Detach ${chip.name}`}
                title="Detach — the guest driver will start to fail transfers"
                onClick={() => detachUserSpi(chip.cs)}
                className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <AttachRow chips={chips.map((c) => c.cs)} />

      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Traffic</span>
          {log.length > 0 && (
            <button
              className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => spiModel.clearTransactions()}
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

    </div>
  )
}

function spiChipClass(chip: SpiChip): DeviceClass {
  if (isSpiFlashChip(chip)) return 'memory'
  if (isSct2024(chip) || isWs2812(chip)) return 'led'
  if (isPt6314(chip)) return 'auxdisplay'
  if (isTmc50xx(chip)) return 'stepper'
  return 'other'
}

function hasSpiDriver(cs: number): boolean {
  const insights = getDeviceTree()?.insights
  if (!insights) return false
  for (const bus of insights.spiBuses) {
    if (!bus.bridged) continue
    if (bus.slots.some((slot) => slot.cs === cs)) return true
  }
  return false
}

const SPI_TYPES = SPI_CHIP_TYPES

function AttachRow({ chips }: { chips: number[] }) {
  const [typeId, setTypeId] = useState(SPI_TYPES[0].id)
  const [csText, setCsText] = useState(() => String(SPI_TYPES[0].defaultCs))
  const [error, setError] = useState<string | null>(null)

  const occupied = useMemo(() => new Set(chips), [chips])
  const type = spiChipType(typeId) ?? SPI_TYPES[0]
  const parsed = Number.parseInt(csText, 10)
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 255
  const taken = valid && occupied.has(parsed)

  const onTypeChange = (id: string) => {
    const t = spiChipType(id)
    if (!t) return
    setTypeId(t.id)
    setCsText(String(t.defaultCs))
    setError(null)
  }

  const attach = () => {
    if (!valid) return
    try {
      attachUserSpi(type.id, parsed)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

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
          {SPI_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="flex items-center gap-1 rounded-md border border-input bg-background px-1.5">
          <span className="text-[10px] text-muted-foreground">CS</span>
          <input
            aria-label="Chip select"
            value={csText}
            onChange={(e) => {
              setCsText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))
              setError(null)
            }}
            className="w-7 bg-transparent py-1 font-mono text-[11px] text-foreground outline-none"
          />
        </span>
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
        <p className="text-[10px] text-destructive">CS{parsed} is already taken.</p>
      ) : valid ? (
        <p className="text-[10px] text-muted-foreground">
          {hasSpiDriver(parsed)
            ? 'The devicetree binds a driver here.'
            : 'Bus only — no guest driver on this chip select.'}
        </p>
      ) : (
        <p className="text-[10px] text-destructive">Enter a chip select between 0 and 255.</p>
      )}
    </div>
  )
}

const HEX = (n: number) => n.toString(16).padStart(2, '0')

function TransactionRow({ entry }: { entry: SpiTransaction }) {
  const tx = Array.from(entry.tx.subarray(0, 4)).map(HEX).join(' ')
  const rx = Array.from(entry.rx.subarray(0, 4)).map(HEX).join(' ')
  const elided = entry.byteLength > 4 ? ` +${entry.byteLength - 4}` : ''

  return (
    <li className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-primary">CS{entry.cs}</span>
      <span className="text-amber-400">TX</span>
      <span className={cn('truncate', entry.ok ? 'text-foreground' : 'text-destructive')}>
        {tx || '(none)'}
        {elided}
      </span>
      <span className="text-sky-400">RX</span>
      <span className={cn('truncate', entry.ok ? 'text-foreground' : 'text-destructive')}>
        {rx || '(none)'}
      </span>
      {!entry.ok && <span className="ml-auto text-destructive">ERR</span>}
    </li>
  )
}
