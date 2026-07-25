/**
 * The chips the bus panel can attach, and where the guest devicetree expects
 * them.
 *
 * Two facts have to stay in step, and this file is where they meet:
 *
 * - The page can attach any chip at any address at runtime; the bus just starts
 *   ACKing there and `i2c scan` finds it.
 * - The guest's driver list is static. Only the addresses the devicetree
 *   declares get a bound driver. A chip attached anywhere else answers on the
 *   bus but no driver ever talks to it — useful for `i2c scan`/`i2c read`, not
 *   `sensor get`.
 *
 * So detaching a declared chip is a genuine bus-error demo (the driver NAKs like
 * the part fell off the board), and attaching one restores it.
 *
 * Where the declared addresses come from: the *parsed devicetree of the running
 * build* when one is loaded (src/devicetree.ts) — the bridged virtio,i2c bus's
 * enabled children are the truth, including "none, this build has no bus". Only
 * when no devicetree is known (older image tarballs, a custom ELF without one)
 * does the hardcoded mirror of the virtio-i2c snippet overlay take over.
 */

import { get as getDeviceTree } from '@/devicetree'
import type { I2cSlot } from '@/dts'
import type { I2cChip } from './i2c'
import { createAt24 } from './chips/at24'
import { createJhd1313Pair } from './chips/jhd1313'
import { createSsd1306 } from './chips/ssd1306'
import { createPcf8523 } from './rtc/pcf8523'
import { createAdxl345 } from './sensors/adxl345'
import { createIna219 } from './sensors/ina219'
import { createIsl29035 } from './sensors/isl29035'
import { createLm75 } from './sensors/lm75'
import { createLps22hh } from './sensors/lps22hh'
import { createLsm6dso } from './sensors/lsm6dso'
import { createTmp112 } from './sensors/tmp112'

export type ChipKind = 'sensor' | 'eeprom' | 'display' | 'auxdisplay' | 'rtc'

export interface ChipType {
  /** Stable id, also the select value. */
  id: string
  /** Shown in the attach picker and roster. */
  label: string
  kind: ChipKind
  /** Address the part ships at; seeds the picker. */
  defaultAddress: number
  /**
   * Optional second endpoint for multi-address modules (JHD1313 backlight).
   * When set, the attach row collects two addresses and {@link create} receives
   * both.
   */
  secondaryAddress?: number
  /** Short label for the secondary address field (e.g. `backlight`). */
  secondaryLabel?: string
  /**
   * Build the chip(s) to put on the bus. Most types return one chip; a module
   * like the JHD1313 returns `[lcd, backlight]` already linked.
   */
  create(address: number, secondary?: number): I2cChip | readonly I2cChip[]
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
    id: 'lm75',
    label: 'LM75 temperature',
    kind: 'sensor',
    defaultAddress: 0x49,
    create: (address) => createLm75({ address }),
  },
  {
    id: 'adxl345',
    label: 'ADXL345 accelerometer',
    kind: 'sensor',
    defaultAddress: 0x53,
    create: (address) => createAdxl345({ address }),
  },
  {
    id: 'lsm6dso',
    label: 'LSM6DSO IMU',
    kind: 'sensor',
    defaultAddress: 0x6a,
    create: (address) => createLsm6dso({ address }),
  },
  {
    id: 'lps22hh',
    label: 'LPS22HH pressure',
    kind: 'sensor',
    defaultAddress: 0x5c,
    create: (address) => createLps22hh({ address }),
  },
  {
    id: 'ina219',
    label: 'INA219 power monitor',
    kind: 'sensor',
    defaultAddress: 0x40,
    create: (address) => createIna219({ address }),
  },
  {
    id: 'isl29035',
    label: 'ISL29035 light',
    kind: 'sensor',
    defaultAddress: 0x44,
    create: (address) => createIsl29035({ address }),
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
  {
    id: 'jhd1313',
    label: 'JHD1313 LCD (+ backlight)',
    kind: 'auxdisplay',
    defaultAddress: 0x3e,
    secondaryAddress: 0x62,
    secondaryLabel: 'backlight',
    create: (address, secondary = 0x62) => {
      const { lcd, backlight } = createJhd1313Pair({
        lcdAddress: address,
        backlightAddress: secondary,
      })
      return [lcd, backlight]
    },
  },
  {
    id: 'pcf8523',
    label: 'PCF8523 RTC',
    kind: 'rtc',
    defaultAddress: 0x68,
    create: (address) => createPcf8523({ address }),
  },
]

/**
 * Fallback for builds whose devicetree is unknown: the addresses the
 * qemu_cortex_a53 virtio-i2c snippet overlay declares *enabled by default*
 * (TMP112, LM75, ADXL345, AT24, SSD1306). Optional sensors stay off until a
 * sample's tree enables them. Kept in sync with the overlay by hand — but only
 * consulted when no zephyr.dts is loaded.
 */
export const FALLBACK_DT_SLOTS: Record<number, string> = {
  0x48: 'tmp112',
  0x49: 'lm75',
  0x50: 'at24',
  0x53: 'adxl345',
  0x3c: 'ssd1306',
}

/**
 * Slots the loaded devicetree declares on the bridged bus(es), or null when no
 * usable devicetree is known. An empty map is meaningful: the tree parsed and
 * declares no bridged I2C bus, so *nothing* has a driver (the blinky story).
 */
function dtsSlots(): Map<number, I2cSlot> | null {
  const insights = getDeviceTree()?.insights
  if (!insights) return null
  const slots = new Map<number, I2cSlot>()
  for (const bus of insights.i2cBuses) {
    if (!bus.bridged) continue
    for (const slot of bus.slots) slots.set(slot.address, slot)
  }
  return slots
}

/** Whether the guest devicetree binds a driver at this address. */
export function hasDriver(address: number): boolean {
  const slots = dtsSlots()
  if (slots) return slots.has(address)
  return address in FALLBACK_DT_SLOTS
}

/** What the devicetree says lives at an address — for hint text. */
export function declaredChip(address: number): { compatible?: string; chipId?: string } | undefined {
  const slots = dtsSlots()
  if (slots) {
    const slot = slots.get(address)
    return slot ? { compatible: slot.compatible, chipId: slot.chipId } : undefined
  }
  const chipId = FALLBACK_DT_SLOTS[address]
  return chipId === undefined ? undefined : { chipId }
}

export function chipType(id: string): ChipType | undefined {
  return CHIP_TYPES.find((t) => t.id === id)
}
