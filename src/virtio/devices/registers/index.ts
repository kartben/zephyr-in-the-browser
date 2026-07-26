/** JSON register maps: names, widths, access, reset values, and bitfields. */

import type { Endian, FieldDecl, RegisterDecl } from './types'

export interface FieldMapJson {
  name: string
  lsb: number
  msb: number
  description?: string
  values?: Array<{ name: string; value: number | string; description?: string }>
}

export interface RegisterMapEntryJson {
  name: string
  addr: number | string
  bytes: 1 | 2 | 3
  access: 'rw' | 'ro'
  reset?: number | string
  endian?: Endian
  highByteOf?: number | string
  description?: string
  fields?: FieldMapJson[]
}

export interface RegisterMapJson {
  name?: string
  description?: string
  registers: RegisterMapEntryJson[]
}

export function parseHexish(value: number | string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`invalid numeric value: ${value}`)
    return value >>> 0
  }
  const trimmed = value.trim()
  if (/^0x/i.test(trimmed)) {
    const n = Number.parseInt(trimmed, 16)
    if (!Number.isFinite(n)) throw new Error(`invalid hex value: ${value}`)
    return n >>> 0
  }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(n)) throw new Error(`invalid numeric value: ${value}`)
  return n >>> 0
}

function fieldFromJson(raw: FieldMapJson): FieldDecl {
  if (raw.msb < raw.lsb) {
    throw new Error(`field ${raw.name}: msb (${raw.msb}) < lsb (${raw.lsb})`)
  }
  return {
    name: raw.name,
    lsb: raw.lsb,
    msb: raw.msb,
    description: raw.description,
    values: raw.values?.map((entry) => ({
      name: entry.name,
      value: parseHexish(entry.value),
      description: entry.description,
    })),
  }
}

function registerFromJson(raw: RegisterMapEntryJson): RegisterDecl {
  if (raw.bytes !== 1 && raw.bytes !== 2 && raw.bytes !== 3) {
    throw new Error(`register ${raw.name}: bytes must be 1, 2, or 3`)
  }
  return {
    name: raw.name,
    addr: parseHexish(raw.addr),
    bytes: raw.bytes,
    access: raw.access,
    reset: raw.reset === undefined ? 0 : parseHexish(raw.reset),
    endian: raw.endian,
    highByteOf: raw.highByteOf === undefined ? undefined : parseHexish(raw.highByteOf),
    description: raw.description,
    fields: raw.fields?.map(fieldFromJson),
  }
}

export function registersFromJson(map: RegisterMapJson): RegisterDecl[] {
  return map.registers.map(registerFromJson)
}

export function mergeRegisterMap(
  registers: RegisterDecl[],
  map: RegisterMapJson,
): RegisterDecl[] {
  const byAddr = new Map(registersFromJson(map).map((r) => [r.addr, r]))
  return registers.map((reg) => {
    const overlay = byAddr.get(reg.addr)
    if (!overlay) return reg
    return {
      ...reg,
      name: overlay.name ?? reg.name,
      description: overlay.description ?? reg.description,
      fields: overlay.fields ?? reg.fields,
    }
  })
}
