import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react'
import { Gauge } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { CheckControl, SelectControl, SliderControl } from '@/components/controls/ControlRow'
import {
  groupDrivesChannel,
  isFollowingGroup,
  setFollowGroup,
  subscribe as subscribeFollows,
} from '@/lib/followStore'
import {
  SOURCE_GROUPS,
  sourceGroupOf,
  type LiveSourceGroup,
} from '@/virtio/devices/sensors/liveSource'
import type { SensorChip } from '@/virtio/devices/sensors/model'

/**
 * The generic control surface for a simulated I2C sensor.
 *
 * Everything it renders comes from the chip's declaration
 * (src/virtio/devices/sensors/model.ts): one slider line per channel, a chip
 * per config attribute, and — where channels name browser sources — one
 * "follow" toggle per source *group*, because the ADXL's three axes are one
 * physical tilt, not three decisions. Adding a sensor is therefore a
 * declaration, not another panel: this body draws whatever the declaration
 * lists.
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
      <div className="max-h-[min(26rem,60vh)] overflow-y-auto">
        <SensorBody chip={chip} />
      </div>
    </PanelFrame>
  )
}

/** Subscribe a component to a chip's changes, re-rendering on each notify. */
function useChip(chip: SensorChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => chip.subscribe(force), [chip])
}

export function SensorBody({ chip }: { chip: SensorChip }) {
  useChip(chip)
  const hex = chip.address.toString(16).padStart(2, '0')

  // The source groups this chip can follow, in channel order, deduplicated.
  const groups: LiveSourceGroup[] = []
  for (const channel of chip.decl.channels) {
    if (!channel.source) continue
    const group = sourceGroupOf(channel.source)
    if (!groups.includes(group)) groups.push(group)
  }

  // Re-render when any follow toggles; the snapshot is a cheap value token.
  useSyncExternalStore(
    subscribeFollows,
    useCallback(
      () => groups.filter((group) => isFollowingGroup(chip, group)).join(','),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [chip],
    ),
    () => '',
  )

  const bitAttrs = chip.decl.attributes?.filter((a) => !a.bits) ?? []
  const fieldAttrs = chip.decl.attributes?.filter((a) => a.bits) ?? []

  return (
    <div className="space-y-1 px-3 py-2.5">
      {chip.decl.channels.map((channel) => {
        const group = channel.source ? sourceGroupOf(channel.source) : undefined
        const driven = group !== undefined && groupDrivesChannel(chip, group, channel.key)
        return (
          <SliderControl
            key={channel.key}
            label={channel.label}
            value={chip.getChannel(channel.key)}
            unit={channel.unit}
            min={channel.min}
            max={channel.max}
            step={channel.step ?? (channel.max - channel.min) / 200}
            disabled={driven}
            onChange={(value) => chip.setChannel(channel.key, value)}
          />
        )
      })}

      {(groups.length > 0 || bitAttrs.length > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {groups.map((group) => (
            <CheckControl
              key={group}
              label={`Follow ${SOURCE_GROUPS[group].label}`}
              checked={isFollowingGroup(chip, group)}
              onChange={(on) => setFollowGroup(chip, group, on)}
            />
          ))}
          {bitAttrs.map((attr) => (
            <CheckControl
              key={attr.key}
              label={attr.label}
              checked={Boolean(chip.getAttr(attr.key))}
              onChange={(on) => chip.setAttr(attr.key, on)}
            />
          ))}
        </div>
      )}

      {fieldAttrs.map((attr) => (
        <SelectControl
          key={attr.key}
          label={attr.label}
          value={Number(chip.getAttr(attr.key))}
          options={attr.bits!.options}
          onChange={(value) => chip.setAttr(attr.key, value)}
        />
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
  )
}
