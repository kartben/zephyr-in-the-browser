/**
 * The chips the bus panel can attach, and where the guest devicetree expects
 * them.
 *
 * Two facts have to stay in step, and this file is where they meet:
 *
 * - The page can attach any chip at any address at runtime; the bus just starts
 *   ACKing there and `i2c scan` finds it.
 * - The guest's driver list is static. Only the addresses the devicetree
 *   declares (zephyr-module/snippets/virtio-i2c/boards/qemu_cortex_a53.overlay)
 *   get a bound driver. A chip attached anywhere else answers on the bus but no
 *   driver ever talks to it — useful for `i2c scan`/`i2c read`, not `sensor get`.
 *
 * So detaching a declared chip is a genuine bus-error demo (the driver NAKs like
 * the part fell off the board), and attaching one restores it. `DT_SLOTS` mirrors
 * the overlay; keep the two in sync.
 */

import type { I2cChip } from './i2c'
import { createAt24 } from './chips/at24'
import { createSsd1306 } from './chips/ssd1306'
import { createTmp112 } from './sensors/tmp112'

export type ChipKind = 'sensor' | 'eeprom' | 'display'

export interface ChipType {
  /** Stable id, also the select value. */
  id: string
  /** Shown in the attach picker and roster. */
  label: string
  kind: ChipKind
  /** Address the part ships at; seeds the picker. */
  defaultAddress: number
  create(address: number): I2cChip
}

/** Every chip type the panel offers to attach. */
export const CHIP_TYPES: ChipType[] = [
  {
    id: 'tmp112',
    label: 'TMP112 temperature',
    kind: 'sensor',
    defaultAddress: 0x48,
    create: (address) => createTmp112({ address }),
  },
  {
    id: 'at24',
    label: 'AT24C02 EEPROM',
    kind: 'eeprom',
    defaultAddress: 0x50,
    create: (address) => createAt24({ address }),
  },
  {
    id: 'ssd1306',
    label: 'SSD1306 OLED',
    kind: 'display',
    defaultAddress: 0x3c,
    create: (address) => createSsd1306({ address }),
  },
]

/**
 * Addresses the qemu_cortex_a53 I2C overlay declares a driver for, mapped to
 * the chip type that belongs there. Kept in sync with the overlay by hand.
 */
export const DT_SLOTS: Record<number, string> = {
  0x48: 'tmp112',
  0x50: 'at24',
  0x3c: 'ssd1306',
}

/** Whether the guest devicetree binds a driver at this address. */
export function hasDriver(address: number): boolean {
  return address in DT_SLOTS
}

export function chipType(id: string): ChipType | undefined {
  return CHIP_TYPES.find((t) => t.id === id)
}
