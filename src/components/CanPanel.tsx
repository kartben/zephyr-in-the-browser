import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CAN_NODE_TYPES,
  LOCAL_NODE,
  addNode,
  canBus,
  canChip,
  recover,
  removeNode,
  sendAs,
} from '@/hostCan'
import { nodeType } from '@/can/nodes'
import type { CanLogEntry, CanNodeSnapshot, CanState } from '@/can/bus'
import type { Mcp2515Chip } from '@/virtio/devices/chips/mcp2515'
import { RegisterMapButton } from './RegisterMap'

/**
 * The CAN bus, as a workbench — the same three sections as {@link ./I2cPanel},
 * plus the two affordances I²C structurally cannot have.
 *
 * - **Roster.** Who is on the bus, with error counters and state. The `×` is
 *   the interesting control: unplug the last node that acknowledges and the
 *   controller counts its way to bus-off, which is a real failure mode with no
 *   equivalent anywhere else in the tree.
 * - **Add node.** Page-side presets, with the fields each one needs.
 * - **Send.** A composed frame, transmitted *as* a chosen node so the error
 *   counters and arbitration attribute to something real.
 * - **Traffic.** Every frame, plus the two events nothing in the guest can
 *   show: a frame its filters dropped, and one that lost arbitration.
 *
 * No arbitration lane view here on purpose. The trace already carries those
 * events as rows, and the only Gantt renderer in the tree
 * ({@link ./TracePanel}, over `src/ctf`) is bound to CTF's thread/state model
 * — reusing it would mean inventing fake threads, and duplicating it would
 * mean a second lane renderer. If lanes are wanted later, the honest move is
 * to lift the row renderer out of `ctf/` first.
 */
export function CanBody() {
  const bus = canBus()
  const nodes = useSyncExternalStore(
    bus.subscribe,
    bus.nodes,
    useCallback(() => [] as readonly CanNodeSnapshot[], []),
  )
  const log = useSyncExternalStore(
    bus.subscribe,
    bus.log,
    useCallback(() => [] as readonly CanLogEntry[], []),
  )
  // `canChip()` changes exactly when a node does (wire/unwire attach or
  // detach the local node together), so this stays in sync off the same
  // subscription without a separate one.
  return <CanView nodes={nodes} log={log} onClear={bus.clearLog} chip={canChip()} />
}

/**
 * The panel proper, over plain data. Split from the store reader above so what
 * a reader sees can be asserted directly — `useSyncExternalStore` serves its
 * *server* snapshot under `renderToStaticMarkup`, and the convention here (see
 * I2cBody) is for that snapshot to be empty.
 */
export function CanView({
  nodes,
  log,
  onClear,
  chip,
}: {
  nodes: readonly CanNodeSnapshot[]
  log: readonly CanLogEntry[]
  onClear?: () => void
  /** The local controller, for the roster row's Registers link. */
  chip?: Mcp2515Chip | null
}) {
  const local = nodes.find((n) => n.local)
  const recent = log.slice(-8).reverse()

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="space-y-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">On the bus</span>
        <ul className="space-y-1">
          {nodes.length === 0 && (
            <li className="text-[11px] text-muted-foreground">Nothing attached.</li>
          )}
          {nodes.map((node) => (
            <NodeRow key={node.id} node={node} chip={node.local ? chip : undefined} />
          ))}
        </ul>
      </div>

      {local?.state === 'bus-off' && (
        <button
          onClick={() => recover()}
          title="Transmission stays stopped until can_recover(). Zephyr's CAN shell: can recover can0"
          className="rounded-md border border-input bg-secondary px-2 py-1 text-[11px] text-foreground hover:bg-background"
        >
          Recover
        </button>
      )}

      <AddNodeRow />
      <SendRow nodes={nodes} />

      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Traffic</span>
          {log.length > 0 && (
            <button
              className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={onClear}
            >
              clear
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nothing has crossed the bus yet.</p>
        ) : (
          <ul className="space-y-0.5 font-mono text-[10px]">
            {recent.map((entry) => (
              <TrafficRow key={entry.seq} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const STATE_DOT: Record<CanState, string> = {
  'error-active': 'bg-success',
  'error-passive': 'bg-warning',
  'bus-off': 'bg-destructive',
}

const STATE_TITLE: Record<CanState, string> = {
  'error-active': 'Transmit errors below 128. Normal operation.',
  'error-passive':
    'Transmit errors above 127. Still on the bus, defers longer after transmitting.',
  'bus-off': 'Transmit errors reached 256. Off the bus until recovery.',
}

function NodeRow({ node, chip }: { node: CanNodeSnapshot; chip?: Mcp2515Chip | null }) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md border bg-secondary px-2 py-1',
        node.local ? 'border-primary/45' : 'border-border',
      )}
      title={node.local ? "This board's controller" : undefined}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-[11px]', node.local && 'font-mono')}>
            {node.name}
          </span>
          <span
            className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground"
            title={STATE_TITLE[node.state]}
          >
            <span className={cn('size-1.5 rounded-full', STATE_DOT[node.state])} />
            {node.state}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="truncate font-mono text-[10px] tabular-nums text-muted-foreground">
            {node.summary}
          </span>
          {chip && <RegisterMapButton chip={chip} />}
        </div>
      </div>
      {node.local ? (
        <span className="size-[18px] shrink-0" />
      ) : (
        <button
          aria-label={`Unplug ${node.name}`}
          title="Unplug. With nothing left to ACK, can0 counts its way to bus-off."
          onClick={() => removeNode(node.id)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
        >
          <X className="size-3" />
        </button>
      )}
    </li>
  )
}

/** Type select plus only the fields the chosen preset needs. */
function AddNodeRow() {
  const [typeId, setTypeId] = useState(CAN_NODE_TYPES[0]!.id)
  const type = nodeType(typeId)
  const [id, setId] = useState(() => hex(CAN_NODE_TYPES[0]!.defaults.id ?? 0))
  const [period, setPeriod] = useState(() => String(CAN_NODE_TYPES[0]!.defaults.periodMs ?? 100))

  const onType = (next: string) => {
    setTypeId(next)
    const t = nodeType(next)
    if (t?.defaults.id !== undefined) setId(hex(t.defaults.id))
    if (t?.defaults.periodMs !== undefined) setPeriod(String(t.defaults.periodMs))
  }

  const parsedId = Number.parseInt(id, 16)
  const parsedPeriod = Number.parseInt(period, 10)
  const needsId = type?.fields.includes('id') ?? false
  const needsPeriod = type?.fields.includes('period') ?? false
  const valid =
    (!needsId || (Number.isInteger(parsedId) && parsedId >= 0 && parsedId <= 0x7ff)) &&
    (!needsPeriod || (Number.isInteger(parsedPeriod) && parsedPeriod > 0))

  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">Add node</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={typeId}
          aria-label="Node type"
          onChange={(e) => onType(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground outline-none"
        >
          {CAN_NODE_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          disabled={!valid}
          onClick={() => addNode(typeId, { id: parsedId || 0, periodMs: parsedPeriod || 100 })}
          className="rounded-md border border-input bg-secondary px-2 py-1 text-[11px] text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {(needsId || needsPeriod) && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          title="Only the fields this type needs. Counter, Listener and Silent take none."
        >
          {needsId && <HexField label="ID" ariaLabel="Node ID" value={id} onChange={setId} />}
          {needsPeriod && (
            <span className="flex items-center gap-1 rounded-md border border-input bg-background px-1.5">
              <span className="text-[10px] text-muted-foreground">every</span>
              <input
                aria-label="Period in ms"
                value={period}
                onChange={(e) => setPeriod(e.target.value.replace(/\D/g, '').slice(0, 5))}
                className="w-8 bg-transparent py-1 font-mono text-[11px] text-foreground outline-none"
              />
              <span className="text-[10px] text-muted-foreground">ms</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The composer sends *as* a roster node rather than as an anonymous injector,
 * so a frame it puts on the bus is subject to the same arbitration and error
 * accounting as any other.
 */
function SendRow({ nodes }: { nodes: readonly CanNodeSnapshot[] }) {
  const [id, setId] = useState('0A0')
  const [bytes, setBytes] = useState<string[]>(() => ['DE', 'AD', 'BE', 'EF', '', '', '', ''])
  const [rtr, setRtr] = useState(false)
  const [from, setFrom] = useState(LOCAL_NODE)

  const senders = useMemo(() => nodes.filter((n) => !n.local), [nodes])
  const sender = senders.some((n) => n.id === from) ? from : (senders[0]?.id ?? '')
  const parsedId = Number.parseInt(id, 16)
  const valid = Number.isInteger(parsedId) && parsedId >= 0 && parsedId <= 0x7ff && sender !== ''

  const send = () => {
    if (!valid) return
    const data = rtr
      ? new Uint8Array()
      : Uint8Array.from(
          bytes.filter((b) => b !== '').map((b) => Number.parseInt(b, 16) & 0xff),
        )
    sendAs(sender, { id: parsedId, ext: false, rtr, data })
  }

  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">Send</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={sender}
          aria-label="Send as"
          onChange={(e) => setFrom(e.target.value)}
          disabled={senders.length === 0}
          className="min-w-0 max-w-[8rem] flex-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground outline-none disabled:opacity-50"
          title="Frames go out as this node, so arbitration and error counters attribute to it."
        >
          {senders.length === 0 && <option>no other node</option>}
          {senders.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
        <HexField label="ID" ariaLabel="Frame ID" value={id} onChange={setId} width="w-9" />
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={rtr}
            onChange={(e) => setRtr(e.target.checked)}
            className="size-3 accent-primary"
          />
          RTR
        </label>
        <button
          onClick={send}
          disabled={!valid}
          className="ml-auto rounded-md border border-primary/60 bg-secondary px-2 py-1 text-[11px] text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {!rtr && (
        <div className="flex gap-1">
          {bytes.map((b, i) => (
            <input
              key={i}
              value={b}
              aria-label={`byte ${i}`}
              onChange={(e) => {
                const next = [...bytes]
                next[i] = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 2).toUpperCase()
                setBytes(next)
              }}
              className="min-w-0 flex-1 rounded border border-input bg-background py-1 text-center font-mono text-[10px] text-foreground outline-none"
            />
          ))}
        </div>
      )}
    </div>
  )
}

function HexField({
  label,
  ariaLabel,
  value,
  onChange,
  width = 'w-8',
}: {
  label: string
  ariaLabel: string
  value: string
  onChange: (v: string) => void
  width?: string
}) {
  return (
    <span className="flex items-center gap-1 rounded-md border border-input bg-background px-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px] text-muted-foreground">0x</span>
      <input
        aria-label={ariaLabel}
        value={value}
        onChange={(e) =>
          onChange(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 3).toUpperCase())
        }
        className={cn('bg-transparent py-1 font-mono text-[11px] text-foreground outline-none', width)}
      />
    </span>
  )
}

const HEX2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')

function TrafficRow({ entry }: { entry: CanLogEntry }) {
  const id = `0x${hex(entry.frame.id)}`

  if (entry.kind === 'arbitration') {
    return (
      <li
        className="flex items-baseline gap-1.5 whitespace-nowrap text-warning"
        title="Both were ready in the same slot. The lower ID wins the bus."
      >
        <span>⚡</span>
        <span>{id}</span>
        <span className="truncate">lost arbitration to 0x{hex(entry.lostTo ?? 0)}</span>
        <span className="ml-auto pl-1.5">retry</span>
      </li>
    )
  }

  const data = Array.from(entry.frame.data.subarray(0, 6)).map(HEX2).join(' ')

  if (entry.kind === 'no-ack') {
    return (
      <li
        className="flex items-baseline gap-1.5 whitespace-nowrap"
        title="No node acknowledged the frame. Each failure adds 8 to TEC."
      >
        <span className="text-amber-400">↑</span>
        <span className="text-primary">{id}</span>
        <span className="truncate text-destructive">{data || '(none)'}</span>
        <span className="ml-auto pl-1.5 text-destructive">no ACK · TEC {entry.tec}</span>
      </li>
    )
  }

  return (
    <li
      className={cn(
        'flex items-baseline gap-1.5 whitespace-nowrap',
        entry.drop === 'filtered' && 'text-muted-foreground/60',
        entry.drop === 'overflow' && 'text-warning',
      )}
      title={
        entry.drop === 'filtered'
          ? `Reached ${LOCAL_NODE}. No acceptance filter matches ${id}.`
          : entry.drop === 'overflow'
            ? `Reached ${LOCAL_NODE}. Both receive buffers still hold undrained frames.`
            : undefined
      }
    >
      <span className={entry.local ? 'text-amber-400' : 'text-sky-400'}>
        {entry.local ? '↑' : '↓'}
      </span>
      <span className={cn(entry.drop === 'filtered' ? 'text-primary/45' : 'text-primary')}>{id}</span>
      <span className="text-muted-foreground">[{entry.frame.rtr ? 'r' : entry.frame.data.length}]</span>
      <span className="truncate">{data || '(none)'}</span>
      {entry.drop && <span className="ml-auto pl-1.5">{entry.drop}</span>}
    </li>
  )
}

function hex(id: number): string {
  return id.toString(16).toUpperCase().padStart(3, '0')
}
