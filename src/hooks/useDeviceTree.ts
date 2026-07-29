/**
 * The one place runtime availability meets the devicetree: subscribes to every
 * bridge store plus the devicetree store, and memoizes the derived device
 * inventory both dock views render. Rows never self-gate — presence is decided
 * here, exactly once, so the ⌗ and ▤ projections can never disagree about what
 * exists.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { deriveDeviceInventory, type Availability, type DeviceInventory } from '@/deviceTopology'
import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import * as hostAudio from '@/hostAudio'
import * as hostDisplay from '@/hostDisplay'
import * as hostGnss from '@/hostGnss'
import * as hostBt from '@/hostBt'
import * as hostGpio from '@/hostGpio'
import * as hostInput from '@/hostInput'
import * as hostMic from '@/hostMic'
import * as hostNet from '@/hostNet'
import { publishInventory } from '@/lib/dockReveal'
import { pruneFollows } from '@/lib/followStore'
import { i2cModel, isBound, spiModel, subscribeBinds } from '@/virtio'
import type { I2cChip } from '@/virtio/devices/i2c'
import type { SpiChip } from '@/virtio/devices/spi'

const NO_CHIPS: I2cChip[] = []
const NO_SPI: SpiChip[] = []

export function useDeviceTree(boardId: string): DeviceInventory {
  const tree = useSyncExternalStore(subscribeDeviceTree, getDeviceTree, () => null)
  const chips = useSyncExternalStore(
    i2cModel.subscribe,
    i2cModel.chips,
    useCallback(() => NO_CHIPS, []),
  )
  const spiChips = useSyncExternalStore(
    spiModel.subscribe,
    spiModel.chips,
    useCallback(() => NO_SPI, []),
  )
  const i2c = useSyncExternalStore(
    subscribeBinds,
    useCallback(() => isBound('i2c'), []),
    () => false,
  )
  const spi = useSyncExternalStore(
    subscribeBinds,
    useCallback(() => isBound('spi'), []),
    () => false,
  )
  const gnss = useSyncExternalStore(hostGnss.subscribe, hostGnss.available, () => false)
  const bluetooth = useSyncExternalStore(hostBt.subscribe, hostBt.available, () => false)
  const gpio = useSyncExternalStore(hostGpio.subscribe, hostGpio.available, () => false)
  const audio = useSyncExternalStore(
    hostAudio.subscribe,
    useCallback(() => hostAudio.getSnapshot().available, []),
    () => false,
  )
  const mic = useSyncExternalStore(
    hostMic.subscribe,
    useCallback(() => hostMic.getSnapshot().available, []),
    () => false,
  )
  const net = useSyncExternalStore(
    hostNet.subscribe,
    useCallback(() => hostNet.getSnapshot().available && hostNet.available(), []),
    () => false,
  )
  const display = useSyncExternalStore(
    hostDisplay.subscribe,
    useCallback(() => hostDisplay.getSnapshot().available, []),
    () => false,
  )
  // hostInput has no subscription of its own; it attaches alongside the other
  // bridges, whose notifications re-render this hook anyway. An inert row a
  // beat late is fine.
  const input = hostInput.available()

  // A chip leaving the bus takes its live-follow subscription with it.
  useEffect(() => {
    pruneFollows(chips)
  }, [chips])

  const inventory = useMemo(() => {
    const avail: Availability = { gnss, bluetooth, gpio, audio, mic, net, i2c, spi, display, input }
    return deriveDeviceInventory(tree, chips, spiChips, avail, boardId)
  }, [tree, chips, spiChips, gnss, bluetooth, gpio, audio, mic, net, i2c, spi, display, input, boardId])

  // Hand the inventory to dockReveal so a caller outside React — a tour step
  // naming a panel, say — can turn a PanelKind into the row that represents it.
  // This is the one place the inventory is derived, so it is the only honest
  // place to publish it from.
  useEffect(() => {
    publishInventory(inventory)
  }, [inventory])

  return inventory
}
