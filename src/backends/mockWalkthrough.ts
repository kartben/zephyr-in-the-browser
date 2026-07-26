/** Replays guided-sample OSC records on the mock backend. */

import { loadCatalog } from '@/annotations/catalog'
import { encodeSequence, type AnnotationRecord } from '@/annotations/protocol'
import { attachStub, detach as detachMonitor } from '@/hostMonitor'
import type { Slave } from './types'

const STEP_MS = 2600

const CHATTER = ['LED state: ON', 'LED state: OFF', 'LED state: ON']

function emit(slave: Slave, record: AnnotationRecord) {
  slave.write(encodeSequence(record))
}

export function startMockWalkthrough(
  slave: Slave,
  catalogUrl: string,
  signal: AbortSignal,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined

  void loadCatalog(catalogUrl).then((catalog) => {
    if (!catalog || signal.aborted) return

    attachStub()

    for (const entry of catalog.entries) {
      emit(slave, { kind: 'ann', id: entry.id, line: entry.line })
    }
    emit(slave, { kind: 'table', count: catalog.entries.length })

    let index = 0
    const step = () => {
      if (signal.aborted) return
      const entry = catalog.entries[index]
      if (!entry) {
        emit(slave, { kind: 'end' })
        return
      }
      emit(slave, {
        kind: 'show',
        id: entry.id,
        pause: entry.fireSites.some((site) => site.pause === true),
      })
      if (index === 0) {
        emit(slave, { kind: 'value', id: entry.id, text: 'mock gpio pin 4' })
      }
      const line = CHATTER[index % CHATTER.length]
      slave.write(`${line}\n`)
      index++
      timer = setTimeout(step, STEP_MS)
    }
    timer = setTimeout(step, STEP_MS)
  })

  return () => {
    if (timer !== undefined) clearTimeout(timer)
    detachMonitor()
  }
}
