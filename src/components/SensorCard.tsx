import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from 'react'
import { sampleForSeed } from '@/boards'
import { CheckControl, SelectControl, SliderControl } from '@/components/controls/ControlRow'
import { RegisterMapButton } from '@/components/RegisterMap'
import { getState as getDockState, subscribe as subscribeDock } from '@/lib/dockStore'
import {
  groupDrivesChannel,
  isFollowingGroup,
  replayingClip,
  setFollowGroup,
  startReplay,
  stopReplay,
  subscribe as subscribeFollows,
} from '@/lib/followStore'
import { cn } from '@/lib/utils'
import {
  SOURCE_GROUPS,
  orientationNeedsPermission,
  requestOrientationPermission,
  sourceGroupOf,
  type LiveSourceGroup,
} from '@/virtio/devices/sensors/liveSource'
import type { SensorChip } from '@/virtio/devices/sensors/model'
import { RECORDING_SETS, type RecordingSet } from '@/virtio/devices/sensors/recordings'

/**
 * The generic control surface for a simulated I2C sensor.
 *
 * Everything it renders comes from the chip's declaration
 * (src/virtio/devices/sensors/model.ts): one slider line per channel, a chip
 * per config attribute, and — where channels name browser sources — one
 * "follow" toggle per source *group*, because the ADXL's three axes are one
 * physical tilt, not three decisions. A collapsed **Registers** control opens
 * the fine-grained map (names + bitfields from the JSON/TS register file).
 * Adding a sensor is therefore a declaration, not another panel: this body
 * draws whatever the declaration lists. The one addition from outside it: when
 * the running sample brings recorded motion for this part (the Magic Wand's
 * gestures), a row of buttons replays it.
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

/**
 * The recorded motion the running sample offers for this chip, if any: the
 * Magic Wand's gestures on the ADXL345, and nothing on any other boot.
 */
function useRecordingSet(chip: SensorChip): RecordingSet | null {
  const seededFor = useSyncExternalStore(subscribeDock, () => getDockState().seededFor, () => '')
  const recordings = sampleForSeed(seededFor)?.recordings
  const set = recordings ? RECORDING_SETS[recordings] : undefined
  return set && set.target === chip.decl.shellLabel ? set : null
}

export function SensorBody({ chip }: { chip: SensorChip }) {
  useChip(chip)
  const [motionError, setMotionError] = useState<string | null>(null)
  const recordings = useRecordingSet(chip)

  // The source groups this chip can follow, in channel order, deduplicated.
  const groups: LiveSourceGroup[] = []
  for (const channel of chip.decl.channels) {
    if (!channel.source) continue
    const group = sourceGroupOf(channel.source)
    if (!groups.includes(group)) groups.push(group)
  }

  // Re-render when any follow toggles or a replay starts or ends; the
  // snapshot is a cheap value token.
  useSyncExternalStore(
    subscribeFollows,
    useCallback(
      () =>
        `${groups.filter((group) => isFollowingGroup(chip, group)).join(',')}|${replayingClip(chip) ?? ''}`,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [chip],
    ),
    () => '',
  )
  const playing = replayingClip(chip)

  // On iOS Safari the permission prompt must be requested synchronously from
  // this same click, so it happens here rather than after setFollowGroup —
  // by the time a deferred start ran, the gesture that would authorize it is
  // gone.
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

      {recordings && groups.includes('orientation') && (
        <div className="space-y-1 pt-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Replay</span>
            {recordings.clips.map((clip) => (
              <button
                key={clip.id}
                type="button"
                aria-pressed={playing === clip.id}
                title={`${recordings.credit} (${recordings.source})`}
                onClick={() =>
                  playing === clip.id ? stopReplay(chip) : startReplay(chip, recordings, clip.id)
                }
                className={cn(
                  'rounded-md border px-1.5 py-0.5 text-[11px]',
                  playing === clip.id
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {clip.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{recordings.hint}</p>
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

      <RegisterMapButton chip={chip} />
    </div>
  )
}
