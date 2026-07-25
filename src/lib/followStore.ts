/**
 * Which sensor channels are following a browser source ("device tilt",
 * "battery level"), held at module level rather than in the checkbox that
 * toggled it. The subscription must outlive the widget: a collapsed or
 * popped-out card unmounts its rows, and the old component-local state
 * silently stopped the source mid-follow — a chip should keep tilting with
 * the device whether or not its controls happen to be on screen.
 */

import { startLiveSource } from '@/virtio/devices/sensors/liveSource'
import type { SensorChip } from '@/virtio/devices/sensors/model'

type Starter = typeof startLiveSource
let starter: Starter = startLiveSource

/** Test seam: the real starter touches window/navigator. */
export function setLiveSourceStarter(fn: Starter): void {
  starter = fn
}

interface Follow {
  chip: SensorChip
  stop: () => void
}

const follows = new Map<string, Follow>()
const listeners = new Set<() => void>()

const keyOf = (chip: SensorChip, channelKey: string) => `${chip.address}:${channelKey}`

function notify() {
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function isFollowing(chip: SensorChip, channelKey: string): boolean {
  return follows.has(keyOf(chip, channelKey))
}

export function setFollow(chip: SensorChip, channelKey: string, follow: boolean): void {
  const key = keyOf(chip, channelKey)
  const current = follows.get(key)
  if (follow === (current !== undefined)) return

  if (!follow) {
    current!.stop()
    follows.delete(key)
    notify()
    return
  }

  const channel = chip.decl.channels.find((c) => c.key === channelKey)
  if (!channel?.source) return
  const stop = starter(channel.source, (value) => chip.setChannel(channelKey, value))
  follows.set(key, { chip, stop })
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
    follow.stop()
    follows.delete(key)
    changed = true
  }
  if (changed) notify()
}
