import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react'
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

/** ~20 Hz is plenty for a slider readout; the guest still reads live values. */
const SENSOR_UI_MS = 50

/**
 * Subscribe a component to a chip's changes, re-rendering on each notify —
 * but capped. Follow-tilt and fast slider drags can outrun what a dock row
 * needs to show, and every React commit on this thread is time stolen from
 * qemu-wasm's main loop (which paints the accelerometer chart).
 */
function useChip(chip: SensorChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      const now = performance.now()
      const wait = SENSOR_UI_MS - (now - last)
      if (wait <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        refresh()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, wait)
    })
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
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
