export type Endian = 'be' | 'le'

/** Inclusive `[lsb, msb]` matches CMSIS-SVD bitRange. */
export interface FieldDecl {
  name: string
  lsb: number
  msb: number
  description?: string
  values?: Array<{ name: string; value: number; description?: string }>
}

export interface RegisterDecl {
  addr: number
  bytes: 1 | 2 | 3
  access: 'rw' | 'ro'
  reset: number
  endian?: Endian
  highByteOf?: number
  name?: string
  description?: string
  fields?: FieldDecl[]
}

export interface RegisterMapSource {
  name: string
  address: number
  registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  subscribe(fn: () => void): () => void
}

export function hasRegisterMap(
  chip: Partial<RegisterMapSource> | null | undefined,
): chip is RegisterMapSource {
  return (
    !!chip &&
    typeof chip.peek === 'function' &&
    typeof chip.getPointer === 'function' &&
    typeof chip.poke === 'function' &&
    typeof chip.setField === 'function' &&
    typeof chip.subscribe === 'function' &&
    Array.isArray(chip.registers) &&
    chip.registers.length > 0 &&
    typeof chip.name === 'string' &&
    typeof chip.address === 'number'
  )
}
