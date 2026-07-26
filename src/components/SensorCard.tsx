/** Dock/window body for declarative I2C sensors. */

import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from 'react'
import { CheckControl, SelectControl, SliderControl } from '@/components/controls/ControlRow'
import { RegisterMapButton } from '@/components/RegisterMap'
import {
  groupDrivesChannel,
  isFollowingGroup,
  setFollowGroup,
  subscribe as subscribeFollows,
} from '@/lib/followStore'
import {
  SOURCE_GROUPS,
  orientationNeedsPermission,
  requestOrientationPermission,
  sourceGroupOf,
  type LiveSourceGroup,
} from '@/virtio/devices/sensors/liveSource'
import type { SensorChip } from '@/virtio/devices/sensors/model'

// ~20 Hz is plenty for UI readout; the guest still reads live values.
const SENSOR_UI_MS = 50

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
  const [motionError, setMotionError] = useState<string | null>(null)

  const groups: LiveSourceGroup[] = []
  for (const channel of chip.decl.channels) {
    if (!channel.source) continue
    const group = sourceGroupOf(channel.source)
    if (!groups.includes(group)) groups.push(group)
  }

  useSyncExternalStore(
    subscribeFollows,
    useCallback(
      () => groups.filter((group) => isFollowingGroup(chip, group)).join(','),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [chip],
    ),
    () => '',
  )

  // iOS Safari requires the motion permission prompt inside the click gesture.
  const onToggleFollow = (group: LiveSourceGroup, on: boolean) => {
    if (!on || group !== 'orientation' || !orientationNeedsPermission()) {
      setMotionError(null)
      setFollowGroup(chip, group, on)
      return
    }
    void requestOrientationPermission().then((result) => {
      if (result === 'granted') {
        setMotionError(null)
        setFollowGroup(chip, group, true)
      } else {
        setMotionError(
          'Motion access was denied. Enable it in Settings > Safari > Motion & Orientation Access.',
        )
        setFollowGroup(chip, group, false)
      }
    })
  }

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
              onChange={(on) => onToggleFollow(group, on)}
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

      {motionError && (
        <p className="pt-1 text-[11px] leading-relaxed text-destructive">{motionError}</p>
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

      <RegisterMapButton chip={chip} />
    </div>
  )
}
