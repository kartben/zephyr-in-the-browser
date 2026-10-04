import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSourceKind } from '@/virtio/devices/sensors/model'
import type { SensorChip } from '@/virtio/devices/sensors/model'
import type { RecordingSet } from '@/virtio/devices/sensors/recordings'
import type { ReplayOptions, ReplayTarget } from '@/virtio/devices/sensors/replay'
import * as follow from './followStore'

/** A chip with the ADXL shape: three channels riding one orientation source. */
function fakeAccel(address: number) {
  const values = new Map<string, number[]>()
  const chip = {
    address,
    name: `accel@${address.toString(16)}`,
    decl: {
      channels: [
        { key: 'ax', label: 'Accel X', reg: 0x32, source: 'orientation-x' as LiveSourceKind },
        { key: 'ay', label: 'Accel Y', reg: 0x34, source: 'orientation-y' as LiveSourceKind },
        { key: 'az', label: 'Accel Z', reg: 0x36, source: 'orientation-z' as LiveSourceKind },
        { key: 'plain', label: 'No source', reg: 0x10 },
      ],
    },
    setChannel: (key: string, value: number) => {
      values.set(key, [...(values.get(key) ?? []), value])
    },
  } as unknown as SensorChip
  return { chip, values }
}

let startedKinds: LiveSourceKind[] = []
let orientationStarts = 0
let orientationStops: Array<ReturnType<typeof vi.fn>> = []

interface StartedReplay {
  clip: string
  target: ReplayTarget
  opts: ReplayOptions
  stop: ReturnType<typeof vi.fn>
}
let replays: StartedReplay[] = []

const SET: RecordingSet = {
  target: 'adxl345',
  rateHz: 25,
  rest: [0, 0, 1],
  hint: '',
  credit: '',
  source: '',
  clips: [
    { id: 'wing', label: 'Wing', samples: [[0, 0, 1]] },
    { id: 'ring', label: 'Ring', samples: [[0, 0, 1]] },
  ],
}

beforeEach(() => {
  follow.pruneFollows([])
  startedKinds = []
  orientationStarts = 0
  orientationStops = []
  replays = []
  follow.setReplayStarter((_chip, clip, target, opts) => {
    const stop = vi.fn()
    replays.push({ clip: clip.id, target, opts, stop })
    return { stop }
  })
  follow.setLiveSourceStarter((kind, push) => {
    startedKinds.push(kind)
    push(4.2)
    return vi.fn()
  })
  follow.setOrientationGroupStarter((push) => {
    orientationStarts += 1
    const stop = vi.fn()
    orientationStops.push(stop)
    push('orientation-x', 1.1)
    push('orientation-y', 2.2)
    push('orientation-z', 3.3)
    return stop
  })
})

describe('followStore (grouped)', () => {
  it('one orientation toggle starts a single group listener and drives every axis', () => {
    const { chip, values } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)

    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(true)
    expect(orientationStarts).toBe(1)
    expect(startedKinds).toEqual([])
    // All three axes received the projected values; the sourceless channel none.
    expect(values.get('ax')).toEqual([1.1])
    expect(values.get('ay')).toEqual([2.2])
    expect(values.get('az')).toEqual([3.3])
    expect(values.has('plain')).toBe(false)
  })

  it('reports which channels the group drives', () => {
    const { chip } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)
    expect(follow.groupDrivesChannel(chip, 'orientation', 'ax')).toBe(true)
    expect(follow.groupDrivesChannel(chip, 'orientation', 'plain')).toBe(false)
    follow.setFollowGroup(chip, 'orientation', false)
    expect(follow.groupDrivesChannel(chip, 'orientation', 'ax')).toBe(false)
  })

  it('is idempotent per direction and stops the whole set on unfollow', () => {
    const { chip } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)
    follow.setFollowGroup(chip, 'orientation', true)
    expect(orientationStarts).toBe(1)

    follow.setFollowGroup(chip, 'orientation', false)
    expect(orientationStops[0]).toHaveBeenCalledTimes(1)
    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(false)
  })

  it('ignores a group with no member channels', () => {
    const { chip } = fakeAccel(0x48)
    follow.setFollowGroup(chip, 'battery', true)
    expect(follow.isFollowingGroup(chip, 'battery')).toBe(false)
    expect(startedKinds).toHaveLength(0)
    expect(orientationStarts).toBe(0)
  })

  it('prunes follows for chips that left the bus', () => {
    const a = fakeAccel(0x53)
    const b = fakeAccel(0x48)
    follow.setFollowGroup(a.chip, 'orientation', true)
    follow.setFollowGroup(b.chip, 'orientation', true)

    follow.pruneFollows([a.chip])

    expect(follow.isFollowingGroup(a.chip, 'orientation')).toBe(true)
    expect(follow.isFollowingGroup(b.chip, 'orientation')).toBe(false)
    expect(orientationStops[1]).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers on every transition', () => {
    const { chip } = fakeAccel(0x53)
    const fn = vi.fn()
    const off = follow.subscribe(fn)
    follow.setFollowGroup(chip, 'orientation', true)
    follow.setFollowGroup(chip, 'orientation', false)
    expect(fn).toHaveBeenCalledTimes(2)
    off()
  })
})

describe('followStore (replay)', () => {
  it('replays into the tilt axes, at the lowest of their registers', () => {
    const { chip } = fakeAccel(0x53)
    follow.startReplay(chip, SET, 'ring')
    expect(follow.replayingClip(chip)).toBe('ring')
    expect(replays).toHaveLength(1)
    expect(replays[0]!.target).toEqual({ channels: ['ax', 'ay', 'az'], dataReg: 0x32 })
    expect(replays[0]!.opts.periodMs).toBe(40)
  })

  it('locks the tilt sliders while it plays', () => {
    const { chip } = fakeAccel(0x53)
    follow.startReplay(chip, SET, 'wing')
    expect(follow.groupDrivesChannel(chip, 'orientation', 'ax')).toBe(true)
    expect(follow.groupDrivesChannel(chip, 'orientation', 'plain')).toBe(false)
    replays[0]!.opts.onDone!()
    expect(follow.replayingClip(chip)).toBeNull()
    expect(follow.groupDrivesChannel(chip, 'orientation', 'ax')).toBe(false)
  })

  it('pauses tilt follow for the clip and hands it back after', () => {
    const { chip } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)
    follow.startReplay(chip, SET, 'wing')
    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(false)
    expect(orientationStops[0]).toHaveBeenCalledTimes(1)

    replays[0]!.opts.onDone!()
    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(true)
    expect(orientationStarts).toBe(2)
  })

  it('keeps that promise when one clip is pressed over another', () => {
    const { chip } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)
    follow.startReplay(chip, SET, 'wing')
    follow.startReplay(chip, SET, 'ring')
    expect(replays[0]!.stop).toHaveBeenCalledTimes(1)
    // The first clip's late onDone must not end the second.
    replays[0]!.opts.onDone!()
    expect(follow.replayingClip(chip)).toBe('ring')
    replays[1]!.opts.onDone!()
    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(true)
  })

  it('stops early on request, restoring follow', () => {
    const { chip } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)
    follow.startReplay(chip, SET, 'ring')
    follow.stopReplay(chip)
    expect(replays[0]!.stop).toHaveBeenCalledTimes(1)
    expect(follow.replayingClip(chip)).toBeNull()
    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(true)
  })

  it('gives way when tilt follow is turned on mid-clip', () => {
    const { chip } = fakeAccel(0x53)
    follow.startReplay(chip, SET, 'ring')
    follow.setFollowGroup(chip, 'orientation', true)
    expect(replays[0]!.stop).toHaveBeenCalledTimes(1)
    expect(follow.replayingClip(chip)).toBeNull()
    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(true)
  })

  it('stops replays for chips that left the bus', () => {
    const a = fakeAccel(0x53)
    const b = fakeAccel(0x1d)
    follow.startReplay(a.chip, SET, 'ring')
    follow.startReplay(b.chip, SET, 'wing')
    follow.pruneFollows([a.chip])
    expect(follow.replayingClip(a.chip)).toBe('ring')
    expect(follow.replayingClip(b.chip)).toBeNull()
    expect(replays[1]!.stop).toHaveBeenCalledTimes(1)
  })

  it('ignores an unknown clip', () => {
    const { chip } = fakeAccel(0x53)
    follow.startReplay(chip, SET, 'loop')
    expect(replays).toHaveLength(0)
    expect(follow.replayingClip(chip)).toBeNull()
  })
})
