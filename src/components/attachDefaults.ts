/**
 * What the I²C and SPI attach rows offer before anyone touches them.
 *
 * Both rows used to open on the first chip type at its datasheet default, and
 * on a sample whose bus already carries that part (the A53 shell puts eleven
 * chips on I²C, CS0 and CS1 on SPI) they opened on a red "already taken"
 * before the reader had done anything. These pick a slot that is free, so an
 * untouched row is always one the Attach button accepts. The rows still say
 * "taken" when the reader types a used address: that is feedback on an edit.
 */

/** 0x00 to 0x02 and 0x78 up are reserved 7-bit addresses: the row refuses them. */
export const I2C_ADDR_MIN = 0x03
export const I2C_ADDR_MAX = 0x77
export const SPI_CS_MAX = 255

/**
 * The first number in `[min, max]` not in `taken`, counting up from
 * `preferred` and wrapping round to `min`. A part's datasheet default is the
 * best guess, and the slots just above it are where a second one usually goes
 * (address pins, the next chip select). Null when every slot is taken.
 */
export function firstFree(
  preferred: number,
  taken: ReadonlySet<number>,
  min: number,
  max: number,
): number | null {
  const span = max - min + 1
  const start = Math.min(Math.max(preferred, min), max) - min
  for (let i = 0; i < span; i++) {
    const n = min + ((start + i) % span)
    if (!taken.has(n)) return n
  }
  return null
}

export interface I2cAttachType {
  id: string
  defaultAddress: number
  secondaryAddress?: number
}

export interface I2cAttachSlot {
  address: number
  /** Only for two-endpoint modules (the JHD1313's backlight). */
  secondary?: number
}

/**
 * Free addresses for one chip type: its defaults when they are free, else the
 * nearest free ones above them. A two-endpoint module never gets the same
 * address twice. Null when the bus has no room for it.
 */
export function i2cSlotFor(
  type: I2cAttachType,
  taken: ReadonlySet<number>,
): I2cAttachSlot | null {
  const address = firstFree(type.defaultAddress, taken, I2C_ADDR_MIN, I2C_ADDR_MAX)
  if (address === null) return null
  if (type.secondaryAddress === undefined) return { address }
  const secondary = firstFree(
    type.secondaryAddress,
    new Set([...taken, address]),
    I2C_ADDR_MIN,
    I2C_ADDR_MAX,
  )
  return secondary === null ? null : { address, secondary }
}

/**
 * The type an untouched I²C attach row opens on: the first one whose own
 * default addresses are all free, so the row shows a real part at its real
 * address. When every default is in use, the first type at the nearest free
 * address. Null only when the bus is full.
 */
export function suggestI2cAttach<T extends I2cAttachType>(
  types: readonly T[],
  taken: ReadonlySet<number>,
): { type: T; slot: I2cAttachSlot } | null {
  for (const type of types) {
    const atDefault =
      !taken.has(type.defaultAddress) &&
      (type.secondaryAddress === undefined ||
        (!taken.has(type.secondaryAddress) && type.secondaryAddress !== type.defaultAddress))
    if (atDefault) {
      return {
        type,
        slot:
          type.secondaryAddress === undefined
            ? { address: type.defaultAddress }
            : { address: type.defaultAddress, secondary: type.secondaryAddress },
      }
    }
  }
  const type = types[0]
  if (!type) return null
  const slot = i2cSlotFor(type, taken)
  return slot ? { type, slot } : null
}

export interface SpiAttachType {
  id: string
  defaultCs: number
}

/** A free chip select for one type: its default, else the next free line. */
export function spiCsFor(type: SpiAttachType, taken: ReadonlySet<number>): number | null {
  return firstFree(type.defaultCs, taken, 0, SPI_CS_MAX)
}

/** {@link suggestI2cAttach} for SPI: a type whose default CS is free, else the first type on the next free line. */
export function suggestSpiAttach<T extends SpiAttachType>(
  types: readonly T[],
  taken: ReadonlySet<number>,
): { type: T; cs: number } | null {
  for (const type of types) {
    if (!taken.has(type.defaultCs)) return { type, cs: type.defaultCs }
  }
  const type = types[0]
  if (!type) return null
  const cs = spiCsFor(type, taken)
  return cs === null ? null : { type, cs }
}
