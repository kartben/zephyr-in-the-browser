import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react'
import { Gauge } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { isFollowing, setFollow, subscribe as subscribeFollows } from '@/lib/followStore'
import { LIVE_SOURCES } from '@/virtio/devices/sensors/liveSource'
import type { AttrDecl, ChannelDecl, SensorChip } from '@/virtio/devices/sensors/model'

/**
 * The generic control surface for a simulated I2C sensor.
 *
 * Everything it renders comes from the chip's declaration
 * (src/virtio/devices/sensors/model.ts): a slider per channel, a toggle or
 * select per config attribute, and — where a channel names a browser source —
 * a checkbox to follow that source instead of the slider. Adding a sensor is
 * therefore a declaration, not another panel: this card draws whatever the
 * declaration lists.
 *
 * The card is a *device*, so it lives on the devices edge. The bus it rides is
 * incidental here and is the I2C panel's concern; this shows the thing, not the
 * wire.
 */
export function SensorCard({
  chip,
  defaultExpanded = true,
}: {
  chip: SensorChip
  defaultExpanded?: boolean
}) {
  const hex = chip.address.toString(16).padStart(2, '0')
  return (
    <PanelFrame
      id={`sensor:${hex}`}
      title={chip.name}
      icon={Gauge}
      side="right"
      defaultExpanded={defaultExpanded}
      status={<span className="font-mono text-[10px] text-muted-foreground">I2C · 0x{hex}</span>}
    >
      <div className="max-h-[min(26rem,60vh)] space-y-3 overflow-y-auto px-3 py-3">
        {chip.decl.channels.map((c) => (
          <ChannelRow key={c.key} chip={chip} channel={c} />
        ))}
        {chip.decl.attributes?.map((a) => (
          <AttributeRow key={a.key} chip={chip} attr={a} />
        ))}
        {chip.decl.shellLabel && (
          <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
            Read it in the guest with{' '}
            <code className="font-mono text-foreground">
              sensor get {chip.decl.shellLabel}@{hex}
            </code>
            .
          </p>
        )}
      </div>
    </PanelFrame>
  )
}

/** Subscribe a component to a chip's changes, re-rendering on each notify. */
function useChip(chip: SensorChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => chip.subscribe(force), [chip])
}

function ChannelRow({ chip, channel }: { chip: SensorChip; channel: ChannelDecl }) {
  useChip(chip)
  // Follow state lives in the follow store so the browser source keeps driving
  // the channel while this row is unmounted (collapsed card, popped-out body).
  const follow = useSyncExternalStore(
    subscribeFollows,
    useCallback(() => isFollowing(chip, channel.key), [chip, channel.key]),
    () => false,
  )
  const value = chip.getChannel(channel.key)
  const step = channel.step ?? (channel.max - channel.min) / 200

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs">{channel.label}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {value.toFixed(2)} {channel.unit}
        </span>
      </div>
      <input
        type="range"
        min={channel.min}
        max={channel.max}
        step={step}
        value={value}
        disabled={follow}
        aria-label={channel.label}
        onChange={(e) => chip.setChannel(channel.key, Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      />
      {channel.source && (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(chip, channel.key, e.target.checked)}
            className="accent-[var(--color-primary)]"
          />
          Follow {LIVE_SOURCES[channel.source].label}
        </label>
      )}
    </div>
  )
}

function AttributeRow({ chip, attr }: { chip: SensorChip; attr: AttrDecl }) {
  useChip(chip)

  if (attr.bits) {
    const current = Number(chip.getAttr(attr.key))
    return (
      <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{attr.label}</span>
        <select
          value={current}
          aria-label={attr.label}
          onChange={(e) => chip.setAttr(attr.key, Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none"
        >
          {attr.bits.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    )
  }

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={Boolean(chip.getAttr(attr.key))}
        onChange={(e) => chip.setAttr(attr.key, e.target.checked)}
        className="accent-[var(--color-primary)]"
      />
      {attr.label}
    </label>
  )
}
