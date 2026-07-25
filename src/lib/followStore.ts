/**
 * Which sensor chips are following a browser source group ("device tilt",
 * "battery level"), held at module level rather than in the checkbox that
 * toggled it. The subscription must outlive the widget: a collapsed or
 * popped-out card unmounts its rows, and component-local state would silently
 * stop the source mid-follow — a chip should keep tilting with the device
 * whether or not its controls happen to be on screen.
 *
 * Keyed per (chip, source group), not per channel: the ADXL's three axes are
 * one physical tilt, so they follow — and stop following — together.
 */

import {
  sourceGroupOf,
  startLiveSource,
  startOrientationGroup,
  type LiveSourceGroup,
} from '@/virtio/devices/sensors/liveSource'
import type { SensorChip } from '@/virtio/devices/sensors/model'

type Starter = typeof startLiveSource
let starter: Starter = startLiveSource

/** Test seam: the real starter touches window/navigator. */
export function setLiveSourceStarter(fn: Starter): void {
  starter = fn
}

type OrientationStarter = typeof startOrientationGroup
let orientationStarter: OrientationStarter = startOrientationGroup

/** Test seam for the grouped orientation path. */
export function setOrientationGroupStarter(fn: OrientationStarter): void {
  orientationStarter = fn
}

interface Follow {
  chip: SensorChip
  stops: Array<() => void>
}

const follows = new Map<string, Follow>()
const listeners = new Set<() => void>()

const keyOf = (chip: SensorChip, group: LiveSourceGroup) => `${chip.address}:${group}`

function notify() {
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function isFollowingGroup(chip: SensorChip, group: LiveSourceGroup): boolean {
  return follows.has(keyOf(chip, group))
}

/** Whether any channel of this chip is being driven by `group`'s source. */
export function groupDrivesChannel(
  chip: SensorChip,
  group: LiveSourceGroup,
  channelKey: string,
): boolean {
  if (!isFollowingGroup(chip, group)) return false
  const channel = chip.decl.channels.find((c) => c.key === channelKey)
  return channel?.source !== undefined && sourceGroupOf(channel.source) === group
}

export function setFollowGroup(chip: SensorChip, group: LiveSourceGroup, follow: boolean): void {
  const key = keyOf(chip, group)
  const current = follows.get(key)
  if (follow === (current !== undefined)) return

  if (!follow) {
    for (const stop of current!.stops) stop()
    follows.delete(key)
    notify()
    return
  }

  const members = chip.decl.channels.filter(
    (c) => c.source !== undefined && sourceGroupOf(c.source) === group,
  )
  if (members.length === 0) return

  // Orientation is one physical sensor: one browser listener writes every
  // member channel. Other groups (battery) still start one source per channel.
  const stops =
    group === 'orientation'
      ? [
          orientationStarter((axis, value) => {
            const channel = members.find((c) => c.source === axis)
            if (channel) chip.setChannel(channel.key, value)
          }),
        ]
      : members.map((c) => starter(c.source!, (value) => chip.setChannel(c.key, value)))

  follows.set(key, { chip, stops })
  notify()
}

/**
 * Stop follows whose chip is no longer on the bus. Called when the attached
 * chip set changes; a re-attached chip is a new handle and starts unfollowed,
 * exactly like a part freshly soldered on.
 */
export function pruneFollows(attached: readonly { address: number }[]): void {
  const alive = new Set(attached)
  let changed = false
  for (const [key, follow] of follows) {
    if (alive.has(follow.chip)) continue
    for (const stop of follow.stops) stop()
    follows.delete(key)
    changed = true
  }
  if (changed) notify()
}
