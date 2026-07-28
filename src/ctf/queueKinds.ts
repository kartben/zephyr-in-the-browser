/**
 * Classify Zephyr CTF data-passing events (msgq / queue / fifo / lifo).
 *
 * FIFO/LIFO wrap k_queue with `_queue` at offset 0, so nested queue_* events
 * share the same object `id`. Prefer the outer kind and ignore nested queue_*
 * for those addresses when reconstructing depth / flow.
 */

export type QueueKind = 'msgq' | 'queue' | 'fifo' | 'lifo'

/** Unified flow ops used by the pipe graph mouths. */
export type QueueFlowOp = 'put' | 'put_front' | 'get'

export type QueueDepthAction = 'put' | 'get' | 'purge'

export interface ClassifiedQueueEvent {
  kind: QueueKind
  /** Object address from CTF `id`. */
  id: number
  /** Mouth / topology op; null for purge (depth-only). */
  flowOp: QueueFlowOp | null
  depthAction: QueueDepthAction
  ok: boolean
}

function prefixKind(name: string): QueueKind | null {
  if (name.startsWith('msgq_')) return 'msgq'
  if (name.startsWith('fifo_')) return 'fifo'
  if (name.startsWith('lifo_')) return 'lifo'
  if (name.startsWith('queue_')) return 'queue'
  return null
}

function num(fields: Record<string, string | number>, key: string): number | null {
  const v = fields[key]
  return typeof v === 'number' ? v : null
}

/** True when a pointer-returning get/remove succeeded (non-NULL / non-zero). */
function ptrOk(ret: number | null): boolean {
  return ret != null && ret !== 0
}

/** True when an errno-style exit succeeded (`ret == 0`). */
function errnoOk(ret: number | null): boolean {
  return ret == null || ret === 0
}

/**
 * Classify a single CTF event by name. Returns null for non-IPC or for exits
 * that do not affect depth/flow (peeks, bulk list ops, enter/blocking, …).
 */
export function classifyQueueEvent(
  name: string,
  fields: Record<string, string | number>,
): ClassifiedQueueEvent | null {
  const kind = prefixKind(name)
  if (!kind) return null
  const id = num(fields, 'id')
  if (id == null) return null
  const ret = num(fields, 'ret')

  if (kind === 'msgq') {
    if (name === 'msgq_put_exit') {
      return { kind, id, flowOp: 'put', depthAction: 'put', ok: errnoOk(ret) }
    }
    if (name === 'msgq_put_front_exit') {
      return { kind, id, flowOp: 'put_front', depthAction: 'put', ok: errnoOk(ret) }
    }
    if (name === 'msgq_get_exit') {
      return { kind, id, flowOp: 'get', depthAction: 'get', ok: errnoOk(ret) }
    }
    if (name === 'msgq_purge') {
      return { kind, id, flowOp: null, depthAction: 'purge', ok: true }
    }
    return null
  }

  if (kind === 'fifo') {
    if (name === 'fifo_put_exit') {
      return { kind, id, flowOp: 'put', depthAction: 'put', ok: true }
    }
    if (name === 'fifo_alloc_put_exit') {
      return { kind, id, flowOp: 'put', depthAction: 'put', ok: errnoOk(ret) }
    }
    if (name === 'fifo_get_exit') {
      return { kind, id, flowOp: 'get', depthAction: 'get', ok: ptrOk(ret) }
    }
    return null
  }

  if (kind === 'lifo') {
    if (name === 'lifo_put_exit') {
      return { kind, id, flowOp: 'put_front', depthAction: 'put', ok: true }
    }
    if (name === 'lifo_alloc_put_exit') {
      return { kind, id, flowOp: 'put_front', depthAction: 'put', ok: errnoOk(ret) }
    }
    if (name === 'lifo_get_exit') {
      return { kind, id, flowOp: 'get', depthAction: 'get', ok: ptrOk(ret) }
    }
    return null
  }

  // bare k_queue — skip bulk list/merge (no item count in CTF).
  if (name === 'queue_append_exit') {
    return { kind, id, flowOp: 'put', depthAction: 'put', ok: true }
  }
  if (name === 'queue_alloc_append_exit') {
    return { kind, id, flowOp: 'put', depthAction: 'put', ok: errnoOk(ret) }
  }
  if (name === 'queue_prepend_exit') {
    return { kind, id, flowOp: 'put_front', depthAction: 'put', ok: true }
  }
  if (name === 'queue_alloc_prepend_exit') {
    return { kind, id, flowOp: 'put_front', depthAction: 'put', ok: errnoOk(ret) }
  }
  if (name === 'queue_insert_exit') {
    // Insert after a node is neither end nor front — treat as put for topology.
    return { kind, id, flowOp: 'put', depthAction: 'put', ok: true }
  }
  if (name === 'queue_unique_append_exit') {
    // uint8_t ret: non-zero means appended.
    return { kind, id, flowOp: 'put', depthAction: 'put', ok: ptrOk(ret) }
  }
  if (name === 'queue_get_exit') {
    return { kind, id, flowOp: 'get', depthAction: 'get', ok: ptrOk(ret) }
  }
  if (name === 'queue_remove_exit') {
    // uint8_t ret: non-zero means removed; depth −1, no flow mouth.
    return { kind, id, flowOp: null, depthAction: 'get', ok: ptrOk(ret) }
  }
  return null
}

/**
 * Scan the trace for object kinds. FIFO/LIFO win over nested queue_* for the
 * same address; msgq and bare queue are assigned from their own prefixes.
 */
export function classifyQueueKinds(
  events: Iterable<{ name: string; fields: Record<string, string | number> }>,
): Map<number, QueueKind> {
  const kinds = new Map<number, QueueKind>()
  for (const ev of events) {
    const kind = prefixKind(ev.name)
    if (!kind) continue
    const id = num(ev.fields, 'id')
    if (id == null) continue
    const prev = kinds.get(id)
    if (prev === 'fifo' || prev === 'lifo') continue
    if (kind === 'fifo' || kind === 'lifo') {
      kinds.set(id, kind)
      continue
    }
    if (prev === 'msgq') continue
    if (kind === 'msgq') {
      kinds.set(id, 'msgq')
      continue
    }
    if (!prev) kinds.set(id, 'queue')
  }
  return kinds
}

/** True when a classified queue_* event should be ignored (FIFO/LIFO wrapper). */
export function isNestedQueueEvent(
  classified: ClassifiedQueueEvent,
  kinds: Map<number, QueueKind>,
): boolean {
  if (classified.kind !== 'queue') return false
  const outer = kinds.get(classified.id)
  return outer === 'fifo' || outer === 'lifo'
}

export function queueKindLabel(kind: QueueKind): string {
  return kind
}
