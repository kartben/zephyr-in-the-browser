/**
 * W25Q-class SPI NOR — a {@link SpiFlashDecl} over the shared JEDEC NOR machine.
 *
 * Capacity is 1 MiB so stock `samples/drivers/spi_flash` (test offset
 * `0xff000`) fits. Endurance is the W25Q80JV datasheet figure (100K cycles)
 * so the card's wear heatmap has a real scale. Denser W25Q parts (or another
 * vendor's JEDEC NOR) are another declaration; the card stays shared.
 */

import {
  createSpiFlashChip,
  createSpiLoopback,
  isSpiFlashChip,
  type SpiFlashChip,
  type SpiFlashDecl,
  type SpiFlashOptions,
} from '../flash/model'

/** Winbond-ish JEDEC ID — density 0x14 ⇒ 2^20 bytes = 1 MiB (W25Q80). */
export const W25Q_JEDEC_ID = Uint8Array.of(0xef, 0x40, 0x14)

/**
 * Default capacity — must cover `SPI_FLASH_TEST_REGION_OFFSET` (0xff000) plus
 * one 4 KiB sector from samples/drivers/spi_flash.
 */
export const W25Q_DEFAULT_SIZE = 1024 * 1024

/** Datasheet erase endurance for the W25Q80JV (cycles per sector). */
export const W25Q_ENDURANCE_CYCLES = 100_000

export const w25qDecl: SpiFlashDecl = {
  name: 'W25Q80JV SPI NOR',
  shellLabel: 'w25q80jv@0',
  defaultCs: 0,
  size: W25Q_DEFAULT_SIZE,
  pageSize: 256,
  sectorSize: 4096,
  blockEraseSizes: [32 * 1024, 64 * 1024],
  jedecId: W25Q_JEDEC_ID,
  erased: 0xff,
  enduranceCycles: W25Q_ENDURANCE_CYCLES,
}

export type { SpiFlashChip, SpiFlashDecl, SpiFlashOptions }
export type W25qChip = SpiFlashChip
export type W25qOptions = SpiFlashOptions

export { createSpiLoopback, isSpiFlashChip }

export function createW25q(options: SpiFlashOptions = {}): SpiFlashChip {
  return createSpiFlashChip(w25qDecl, options)
}
