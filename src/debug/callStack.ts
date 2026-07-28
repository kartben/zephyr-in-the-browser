/**
 * Call stack for the Debug panel — who called whom, without a DWARF unwinder.
 *
 * A full debugger reads `.eh_frame` / `.debug_frame` CFI to unwind exactly.
 * That is a lot of machinery for a playground, so this does what a human does
 * when staring at a stack dump, in two passes:
 *
 *   1. **Frame-pointer chain** — when the guest was built with frame pointers
 *      (`CONFIG_FRAME_POINTER=y`, which packaged images set), each frame stores
 *      `{caller fp, return address}` at a known place relative to fp. Walking
 *      that chain is exact, so it is tried first.
 *   2. **Stack scan** — otherwise, read words up the thread's stack and keep
 *      the ones that land *inside* a function (offset > 0). A return address
 *      always points after a call, never at a function's first instruction, so
 *      that one rule throws out most function-pointer tables and stale data.
 *
 * Pass 2 is a guess and the UI says so: every frame carries {@link StackFrame.origin}
 * and the result carries {@link UnwindResult.method}. Better an honest
 * "scanned" list of plausible callers than a confident wrong one.
 *
 * Pure module — memory comes in through {@link UnwindOptions.read} and symbols
 * through {@link UnwindOptions.resolve}, so it tests without a live guest.
 */

import { codeAddr, ptrBytes, type GdbArch } from '@/debug/gdb/regs'
import { formatSymbol, type ResolvedSymbol } from '@/debug/elfSymbols'

/** Deepest frame count we build — a playground stack is never 40 deep. */
export const MAX_FRAMES = 16

/** How far up the stack the scan looks when the fp chain is unavailable. */
export const SCAN_BYTES = 1024

/**
 * Bytes per RSP peek while scanning. Same reasoning as the Mem search chunk:
 * QEMU's gdbstub caps a packet near 4 KiB and `m` replies are hex.
 */
export const SCAN_CHUNK_BYTES = 512

export type FrameOrigin =
  /** The stopped PC itself. */
  | 'pc'
  /** The link register — the caller of frame 0 before it is spilled. */
  | 'lr'
  /** Followed from a frame-pointer record. */
  | 'fp'
  /** Found by scanning the stack; plausible, not proven. */
  | 'scan'

export interface StackFrame {
  /** Instruction address (frame 0) or return address (deeper frames). */
  addr: number
  /** `foo+0x14`, when symbols resolve. */
  label: string | null
  fn: ResolvedSymbol | null
  origin: FrameOrigin
  /** Stack slot the address was recovered from, for a Mem peek. */
  slot: number | null
}

export type UnwindMethod = 'fp' | 'scan' | 'none'

export interface UnwindResult {
  frames: StackFrame[]
  /** How frames past #0 were recovered — the UI labels scans as heuristic. */
  method: UnwindMethod
  /** Hit {@link MAX_FRAMES} or the scan window before the stack ran out. */
  truncated: boolean
}

export interface UnwindOptions {
  arch: GdbArch
  pc: number | null
  sp: number | null
  fp?: number | null
  lr?: number | null
  /** Stack buffer bounds, when the thread walk knows them. Limits the scan. */
  stackStart?: number | null
  stackSize?: number | null
  /** Guest memory reader; resolves null when the read fails. */
  read: (addr: number, length: number) => Promise<Uint8Array | null>
  /** Nearest enclosing function for an address (symtab). */
  resolve: (addr: number) => ResolvedSymbol | null
  maxFrames?: number
  scanBytes?: number
}

function readWord(bytes: Uint8Array, at: number, width: 4 | 8): number {
  const lo =
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  if (width === 4) return lo
  const hi =
    ((bytes[at + 4] ?? 0) |
      ((bytes[at + 5] ?? 0) << 8) |
      ((bytes[at + 6] ?? 0) << 16) |
      ((bytes[at + 7] ?? 0) << 24)) >>>
    0
  return lo + hi * 0x1_0000_0000
}

function makeFrame(
  addr: number,
  origin: FrameOrigin,
  slot: number | null,
  resolve: UnwindOptions['resolve'],
): StackFrame {
  const fn = resolve(addr)
  return { addr, label: formatSymbol(fn), fn, origin, slot }
}

/**
 * Is this word plausibly a return address?
 *
 * Inside a known function and past its first instruction — a call always
 * returns into the middle of its caller, so `offset === 0` is a symbol
 * reference (vtable, k_thread entry, ISR vector), not a caller.
 */
function isReturnAddress(addr: number, resolve: UnwindOptions['resolve']): ResolvedSymbol | null {
  if (!addr || !Number.isFinite(addr)) return null
  const fn = resolve(addr)
  if (!fn || fn.offset <= 0) return null
  return fn
}

/** Follow `{caller fp, return address}` records while they stay sane. */
async function walkFramePointer(
  opts: UnwindOptions,
  limit: number,
): Promise<StackFrame[]> {
  const { arch, read, resolve } = opts
  const width = ptrBytes(arch)
  const out: StackFrame[] = []
  let fp = opts.fp ?? 0
  const low = opts.sp ?? 0
  const high =
    opts.stackStart != null && opts.stackSize != null
      ? opts.stackStart + opts.stackSize
      : Number.POSITIVE_INFINITY

  for (let depth = 0; depth < limit; depth++) {
    if (!fp || fp % width !== 0) break
    if (low && fp < low) break
    if (fp >= high) break

    // AAPCS64 / RISC-V place the record differently around fp.
    //   aarch64: [fp] = caller fp, [fp+8]  = return address
    //   riscv:   [fp-16] = caller fp, [fp-8] = return address
    //   thumb:   [fp] = caller fp, [fp+4]  = return address  (r7 chain)
    const recordAt = arch === 'riscv32' ? fp - 2 * width : fp
    if (recordAt < 0) break
    const record = await read(recordAt, 2 * width)
    if (!record || record.length < 2 * width) break

    const nextFp = readWord(record, 0, width)
    const ret = codeAddr(arch, readWord(record, width, width))
    const fn = isReturnAddress(ret, resolve)
    if (!fn) break

    out.push(makeFrame(ret, 'fp', recordAt + width, resolve))

    // The chain must climb; equal or descending means we followed garbage.
    if (!nextFp || nextFp <= fp) break
    fp = nextFp
  }

  return out
}

/** Read words up the stack and keep the ones that look like return addresses. */
async function scanStack(
  opts: UnwindOptions,
  limit: number,
  seedAddr: number | null,
): Promise<{ frames: StackFrame[]; truncated: boolean }> {
  const { arch, read, resolve } = opts
  const width = ptrBytes(arch)
  const frames: StackFrame[] = []
  const sp = opts.sp ?? 0
  if (!sp) return { frames, truncated: false }

  const start = Math.ceil(sp / width) * width
  const budget = opts.scanBytes ?? SCAN_BYTES
  const stackEnd =
    opts.stackStart != null && opts.stackSize != null
      ? opts.stackStart + opts.stackSize
      : start + budget
  const end = Math.min(start + budget, stackEnd)
  if (end <= start) return { frames, truncated: false }

  let last = seedAddr
  for (let at = start; at < end; ) {
    const length = Math.min(SCAN_CHUNK_BYTES, end - at)
    const chunk = await read(at, length)
    if (!chunk || chunk.length < width) break

    const usable = Math.floor(chunk.length / width) * width
    for (let off = 0; off < usable; off += width) {
      const candidate = codeAddr(arch, readWord(chunk, off, width))
      if (candidate === last) continue // same address twice in one prologue
      if (!isReturnAddress(candidate, resolve)) continue
      frames.push(makeFrame(candidate, 'scan', at + off, resolve))
      last = candidate
      if (frames.length >= limit) return { frames, truncated: true }
    }
    at += usable
  }

  return { frames, truncated: end < stackEnd }
}

/**
 * Build a call stack for one context (the stopped CPU, or a parked thread).
 *
 * Pass `pc`/`lr` for the running context; for a thread that is not current,
 * pass its saved `sp` alone and the scan does the work.
 */
export async function unwindStack(opts: UnwindOptions): Promise<UnwindResult> {
  const limit = opts.maxFrames ?? MAX_FRAMES
  const frames: StackFrame[] = []

  const pc = opts.pc != null ? codeAddr(opts.arch, opts.pc) : null
  if (pc) frames.push(makeFrame(pc, 'pc', null, opts.resolve))
  if (frames.length >= limit) return { frames, method: 'none', truncated: true }

  const viaFp = await walkFramePointer(opts, limit - frames.length)
  if (viaFp.length > 0) {
    frames.push(...viaFp)
    return {
      frames,
      method: 'fp',
      truncated: frames.length >= limit,
    }
  }

  // No usable frame record: LR still holds frame 0's caller when the callee
  // has not spilled it yet, so it is the one non-guess we have left.
  const lr = opts.lr != null ? codeAddr(opts.arch, opts.lr) : null
  if (lr && lr !== pc && isReturnAddress(lr, opts.resolve)) {
    frames.push(makeFrame(lr, 'lr', null, opts.resolve))
  }

  const seed = frames.length > 1 ? frames[frames.length - 1]!.addr : null
  const scanned = await scanStack(opts, limit - frames.length, seed)
  frames.push(...scanned.frames)

  return {
    frames,
    method: frames.some((f) => f.origin === 'scan') ? 'scan' : 'none',
    truncated: scanned.truncated || frames.length >= limit,
  }
}

/** Short human label for how the frames were found. */
export function describeMethod(method: UnwindMethod): string | null {
  if (method === 'fp') return 'frame pointers'
  if (method === 'scan') return 'stack scan · plausible callers'
  return null
}
