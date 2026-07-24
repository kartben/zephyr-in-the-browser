import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { Cable, X } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { cn } from '@/lib/utils'
import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import { i2cModel, isBound, subscribeBinds } from '@/virtio'
import { CHIP_TYPES, chipType, hasDriver } from '@/virtio/devices/registry'
import type { I2cTransaction } from '@/virtio/devices/i2c'

/**
 * The browser's I2C bus, as a debug + wiring surface.
 *
 * The bus and every chip on it are page-side models (src/virtio/devices/), so
 * unlike the other panels this one is not a control surface onto a QEMU device
 * — it is a window onto the bus itself, and a workbench for it. Two jobs:
 *
 * - **Debug.** Every message that crossed the bus, in a trace. An I2C bug is
 *   almost always "the driver sent something other than what you assumed", and
 *   without a trace the only evidence is a return code. Scan NAKs are filtered
 *   by the model, so a 116-address `i2c scan` does not bury the traffic.
 * - **Wiring.** Attach and detach chips at runtime. Detaching a chip the guest
 *   has a driver for makes that driver NAK exactly as if the part fell off the
 *   board — a bus error this simulator can actually demonstrate. The controls
 *   for a chip (a sensor's slider, the OLED's screen) live on the devices edge;
 *   this side is the bus, not the things on it.
 */
export function I2cPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const isAvailable = useSyncExternalStore(
    subscribeBinds,
    useCallback(() => isBound('i2c'), []),
    () => false,
  )
  const chips = useSyncExternalStore(
    i2cModel.subscribe,
    i2cModel.chips,
    useCallback(() => [], []),
  )

  if (!isAvailable) return null

  return (
    <PanelFrame
      id="i2c"
      title="I2C bus"
      icon={Cable}
      side="left"
      defaultExpanded={defaultExpanded}
      status={
        <span className="font-mono text-[10px] text-muted-foreground">
          {chips.length} {chips.length === 1 ? 'chip' : 'chips'}
        </span>
      }
    >
      <I2cBody />
    </PanelFrame>
  )
}

function I2cBody() {
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
  // hasDriver() answers from the loaded devicetree; subscribing here is what
  // re-renders the driver/bus-only tags when a tree arrives or goes away.
  useSyncExternalStore(subscribeDeviceTree, getDeviceTree, () => null)

  // Newest first, and only as many as fit without turning the panel into a
  // wall — the whole log is still there for anyone who wants it.
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
              <button
                aria-label={`Detach ${chip.name}`}
                title="Detach — the guest driver will start to NAK"
                onClick={() => i2cModel.detachChip(chip.address)}
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
        In the guest: <code className="font-mono text-foreground">i2c scan virtio_i2c0</code>{' '}
        finds every attached chip; a driver only binds at the addresses the devicetree
        declares.
      </p>
    </div>
  )
}

/** The attach control: pick a chip type and an address, put it on the bus. */
function AttachRow({ chips }: { chips: number[] }) {
  const [typeId, setTypeId] = useState(CHIP_TYPES[0].id)
  const [addr, setAddr] = useState(() => CHIP_TYPES[0].defaultAddress.toString(16))
  const [error, setError] = useState<string | null>(null)

  const occupied = useMemo(() => new Set(chips), [chips])
  const parsed = Number.parseInt(addr, 16)
  const valid = Number.isInteger(parsed) && parsed >= 0x03 && parsed <= 0x77
  const taken = valid && occupied.has(parsed)

  const onTypeChange = (id: string) => {
    setTypeId(id)
    setError(null)
    const t = chipType(id)
    if (t) setAddr(t.defaultAddress.toString(16))
  }

  const attach = () => {
    const type = chipType(typeId)
    if (!type || !valid) return
    try {
      i2cModel.attachChip(type.create(parsed))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">Attach</span>
      <div className="flex items-center gap-1.5">
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
        <span className="flex items-center rounded-md border border-input bg-background px-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">0x</span>
          <input
            aria-label="Address"
            value={addr}
            onChange={(e) => {
              setAddr(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 2))
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
        <p className="text-[10px] text-destructive">0x{addr} is already taken.</p>
      ) : valid ? (
        <p className="text-[10px] text-muted-foreground">
          {hasDriver(parsed)
            ? 'The devicetree binds a driver here.'
            : 'Bus only — i2c scan finds it, but no guest driver binds.'}
        </p>
      ) : (
        <p className="text-[10px] text-destructive">Enter an address between 0x03 and 0x77.</p>
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
