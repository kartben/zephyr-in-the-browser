/**
 * User-attached bus parts that should survive page reload ("MCU reset").
 *
 * Devicetree-managed board singletons come back via syncManagedChips; this
 * roster is the breadboard on top — chips the user put on via Attach. NVM
 * contents (AT24 / W25Q) already persist separately; this only remembers
 * *which* parts are soldered where.
 *
 * Intentionally not a Reset-vs-Reboot split: one Reload keeps wiring and flash,
 * clears guest RAM. Detaching a DT-managed part is temporary for the session;
 * on Reload the PCB part is soldered again.
 */

const STORAGE_KEY = 'zephyr.busRoster'
const VERSION = 1

export interface I2cRosterEntry {
  typeId: string
  address: number
  /** Second endpoint for multi-address modules (JHD1313 backlight). */
  secondary?: number
}

export interface SpiRosterEntry {
  typeId: string
  cs: number
}

export interface BusRoster {
  i2c: I2cRosterEntry[]
  spi: SpiRosterEntry[]
}

function empty(): BusRoster {
  return { i2c: [], spi: [] }
}

function read(): BusRoster {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty()
    const parsed = JSON.parse(raw) as { v?: number; i2c?: unknown; spi?: unknown }
    if (parsed.v !== VERSION) return empty()
    return {
      i2c: Array.isArray(parsed.i2c) ? parsed.i2c.filter(isI2cEntry) : [],
      spi: Array.isArray(parsed.spi) ? parsed.spi.filter(isSpiEntry) : [],
    }
  } catch {
    return empty()
  }
}

function isI2cEntry(v: unknown): v is I2cRosterEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as I2cRosterEntry
  return (
    typeof e.typeId === 'string' &&
    typeof e.address === 'number' &&
    (e.secondary === undefined || typeof e.secondary === 'number')
  )
}

function isSpiEntry(v: unknown): v is SpiRosterEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as SpiRosterEntry
  return typeof e.typeId === 'string' && typeof e.cs === 'number'
}

function write(roster: BusRoster): void {
  try {
    if (roster.i2c.length === 0 && roster.spi.length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, ...roster }))
  } catch {
    /* private mode / quota — wiring just won't survive the reload */
  }
}

/** Snapshot of the breadboard roster. */
export function getBusRoster(): BusRoster {
  return read()
}

/** Record an I²C Attach (all addresses the module occupies). */
export function rememberI2cAttach(typeId: string, address: number, secondary?: number): void {
  const roster = read()
  // Drop any prior claim on these addresses so a re-attach replaces cleanly.
  const taken = new Set<number>([address, ...(secondary !== undefined ? [secondary] : [])])
  roster.i2c = roster.i2c.filter(
    (e) => !taken.has(e.address) && (e.secondary === undefined || !taken.has(e.secondary)),
  )
  roster.i2c.push(secondary !== undefined ? { typeId, address, secondary } : { typeId, address })
  write(roster)
}

/** Forget every roster entry that occupied this address (primary or secondary). */
export function forgetI2cAddress(address: number): void {
  const roster = read()
  const next = roster.i2c.filter((e) => e.address !== address && e.secondary !== address)
  if (next.length === roster.i2c.length) return
  roster.i2c = next
  write(roster)
}

export function rememberSpiAttach(typeId: string, cs: number): void {
  const roster = read()
  roster.spi = roster.spi.filter((e) => e.cs !== cs)
  roster.spi.push({ typeId, cs })
  write(roster)
}

export function forgetSpiCs(cs: number): void {
  const roster = read()
  const next = roster.spi.filter((e) => e.cs !== cs)
  if (next.length === roster.spi.length) return
  roster.spi = next
  write(roster)
}

/** Drop the whole breadboard — for tests. */
export function clearBusRoster(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
