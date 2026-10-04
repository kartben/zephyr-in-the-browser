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
 *
 * A chip can instead replay a recorded clip into those same axes (the Magic
 * Wand's gestures). The two are exclusive: a replay pauses an active tilt
 * follow and hands it back when the clip ends.
 */

import {
  sourceGroupOf,
  startLiveSource,
  startOrientationGroup,
  type LiveSourceGroup,
} from '@/virtio/devices/sensors/liveSource'
import type { SensorChip } from '@/virtio/devices/sensors/model'
import type { RecordingSet } from '@/virtio/devices/sensors/recordings'
import { startClipReplay, type Replay, type ReplayTarget } from '@/virtio/devices/sensors/replay'

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

type ReplayStarter = typeof startClipReplay
let replayStarter: ReplayStarter = startClipReplay

/** Test seam: the real replay listens to guest reads and runs a timer. */
export function setReplayStarter(fn: ReplayStarter): void {
  replayStarter = fn
}

interface Follow {
  chip: SensorChip
  stops: Array<() => void>
}

interface Playing {
  clipId: string
  replay: Replay
  /** Tilt follow was on when the clip started; turn it back on after. */
  resumeFollow: boolean
}

const follows = new Map<string, Follow>()
const playing = new Map<SensorChip, Playing>()
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

/** Whether any channel of this chip is being driven by `group`'s source, or by a replay. */
export function groupDrivesChannel(
  chip: SensorChip,
  group: LiveSourceGroup,
  channelKey: string,
): boolean {
  const replaying = group === 'orientation' && playing.has(chip)
  if (!replaying && !isFollowingGroup(chip, group)) return false
  const channel = chip.decl.channels.find((c) => c.key === channelKey)
  return channel?.source !== undefined && sourceGroupOf(channel.source) === group
}

/** The clip this chip is replaying, or null. */
export function replayingClip(chip: SensorChip): string | null {
  return playing.get(chip)?.clipId ?? null
}

/**
 * Where a clip lands on this chip: the channels that follow device tilt, in
 * x/y/z order, and the lowest of their registers, which is where a driver's
 * fetch of a fresh sample starts reading.
 */
function replayTarget(chip: SensorChip): ReplayTarget | null {
  const axes = (['orientation-x', 'orientation-y', 'orientation-z'] as const).map((source) =>
    chip.decl.channels.find((c) => c.source === source),
  )
  const [x, y, z] = axes
  if (!x || !y || !z) return null
  return { channels: [x.key, y.key, z.key], dataReg: Math.min(x.reg, y.reg, z.reg) }
}

/** Replay `clipId` from `set` into the chip's tilt axes, pausing a tilt follow. */
export function startReplay(chip: SensorChip, set: RecordingSet, clipId: string): void {
  const clip = set.clips.find((c) => c.id === clipId)
  const target = replayTarget(chip)
  if (!clip || !target) return

  // A clip pressed over another inherits its promise to resume the follow.
  const previous = playing.get(chip)
  previous?.replay.stop()
  const resumeFollow = previous?.resumeFollow || isFollowingGroup(chip, 'orientation')
  if (isFollowingGroup(chip, 'orientation')) setFollowGroup(chip, 'orientation', false)

  // In the map before it starts: a clip can finish inside the starter.
  const entry = { clipId, resumeFollow } as Playing
  playing.set(chip, entry)
  entry.replay = replayStarter(chip, clip, target, {
    periodMs: 1000 / set.rateHz,
    onDone: () => {
      if (playing.get(chip) !== entry) return
      playing.delete(chip)
      notify()
      if (entry.resumeFollow) setFollowGroup(chip, 'orientation', true)
    },
  })
  notify()
}

/** Stop a replay early, handing the axes back to tilt follow if it was on. */
export function stopReplay(chip: SensorChip): void {
  const entry = playing.get(chip)
  if (!entry) return
  entry.replay.stop()
  playing.delete(chip)
  notify()
  if (entry.resumeFollow) setFollowGroup(chip, 'orientation', true)
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

  // Following the device again takes the axes back from a replay.
  if (group === 'orientation') {
    const entry = playing.get(chip)
    if (entry) {
      entry.replay.stop()
      playing.delete(chip)
    }
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
  for (const [chip, entry] of playing) {
    if (alive.has(chip)) continue
    entry.replay.stop()
    playing.delete(chip)
    changed = true
  }
  if (changed) notify()
}
