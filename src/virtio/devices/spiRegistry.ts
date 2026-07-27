/**
 * SPI parts the attach picker can put on the virtio-spi bus.
 *
 * Mirrors {@link ./registry.ts} for I²C: create factories live here; identity
 * cards live in {@link ./parts.ts}.
 */

import type { SpiChip } from './spi'
import { createSct2024 } from './chips/sct2024'
import { createPt6314 } from './chips/pt6314'
import { createWs2812 } from './chips/ws2812'
import { createTmc50xx } from './chips/tmc50xx'
import { createMcp2515 } from './chips/mcp2515'
import { createSpiLoopback, createW25q } from './chips/w25q'
import { partById, type PartIdentity } from './parts'

export interface SpiChipType {
  id: string
  label: string
  defaultCs: number
  /**
   * Real silicon has an identity card; the loopback tool does not — it is an
   * attach helper, not a catalogued part.
   */
  catalogued: boolean
  create(cs: number): SpiChip
}

export const SPI_CHIP_TYPES: SpiChipType[] = [
  {
    id: 'w25q',
    label: 'W25Q SPI NOR',
    defaultCs: 0,
    catalogued: true,
    create: (cs) => createW25q({ cs }),
  },
  {
    id: 'sct2024',
    label: 'SCT2024 LED',
    defaultCs: 0,
    catalogued: true,
    create: (cs) => createSct2024({ cs }),
  },
  {
    id: 'ws2812',
    label: 'WS2812 LED strip',
    defaultCs: 0,
    catalogued: true,
    create: (cs) => createWs2812({ cs }),
  },
  {
    id: 'pt6314',
    label: 'PT6314 VFD',
    defaultCs: 0,
    catalogued: true,
    create: (cs) => createPt6314({ cs }),
  },
  {
    id: 'tmc50xx',
    label: 'TMC50xx stepper',
    defaultCs: 0,
    catalogued: true,
    create: (cs) => createTmc50xx({ cs }),
  },
  {
    id: 'mcp2515',
    label: 'MCP2515 CAN',
    defaultCs: 0,
    catalogued: true,
    // Bare chip: hostCan.ts wires it to the bus and the INT line when it sees
    // one attach, the same way hostStepper watches GPIO for step/dir.
    create: (cs) => createMcp2515({ cs }),
  },
  {
    id: 'loopback',
    label: 'SPI loopback',
    defaultCs: 1,
    catalogued: false,
    create: (cs) => createSpiLoopback(cs),
  },
]

export function spiChipType(id: string): SpiChipType | undefined {
  return SPI_CHIP_TYPES.find((t) => t.id === id)
}

export function spiChipIdentity(id: string): PartIdentity | undefined {
  const type = spiChipType(id)
  if (!type?.catalogued) return undefined
  return partById(id)
}
