/**
 * Finding the kernel object behind an address, for links between the inspect
 * tabs: a name opens the thing, an address opens its bytes.
 */

import type { ObjectCoreSnapshot, ZephyrKernelObject } from '@/debug/kernel/objectCores'

/**
 * The object at `addr`, or the tightest one containing it. A thread's
 * `pended_on` is the address of a `wait_q`, which is usually but not always
 * the object's first member, so an exact match alone would miss a k_fifo.
 */
export function objectAt(
  objects: ObjectCoreSnapshot | null,
  addr: number,
): ZephyrKernelObject | null {
  let best: { object: ZephyrKernelObject; size: number } | null = null
  for (const type of objects?.types ?? []) {
    for (const object of type.objects) {
      if (object.addr === addr) return object
      const size = object.size ?? type.objectSize ?? 0
      if (addr > object.addr && addr < object.addr + size && (!best || size < best.size)) {
        best = { object, size }
      }
    }
  }
  return best?.object ?? null
}
