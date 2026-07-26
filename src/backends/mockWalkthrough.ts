/**
 * Replays a guided sample's walkthrough on the mock backend.
 *
 * `npm run dev` lands on the mock, because a real emulator is a ~100 MB
 * containerised build most people will not have done yet. That is exactly the
 * audience a teaching feature is for, so the mock emits the same OSC records
 * the firmware would — same protocol, same store, same popups — driven off the
 * catalog the dev server generates from the sample's own comments.
 *
 * It announces itself as a fake by pausing nothing: the mock has no machine to
 * stop, so `attachStub` only tracks the flag. The same trick the Network panel
 * plays with `startFakeNetwork`.
 */

import { loadCatalog } from '@/annotations/catalog'
import { encodeSequence, type AnnotationRecord } from '@/annotations/protocol'
import { attachStub, detach as detachMonitor } from '@/hostMonitor'
import type { Slave } from './types'

/** Beat between the fake sample's steps, when nothing is waiting on the reader. */
const STEP_MS = 2600

/** What the guest would print between annotations, so the terminal is not idle. */
const CHATTER = ['LED state: ON', 'LED state: OFF', 'LED state: ON']

function emit(slave: Slave, record: AnnotationRecord) {
  slave.write(encodeSequence(record))
}

/**
 * Start the replay. Returns a disposer.
 *
 * A sample with no catalog — every unannotated one, and any checkout where the
 * extractor could not run — simply never starts, with nothing said about it.
 */
export function startMockWalkthrough(
  slave: Slave,
  catalogUrl: string,
  signal: AbortSignal,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined

  void loadCatalog(catalogUrl).then((catalog) => {
    if (!catalog || signal.aborted) return

    attachStub()

    // The boot announcement, as SYS_INIT would send it.
    for (const entry of catalog.entries) {
      emit(slave, { kind: 'ann', id: entry.id, line: entry.line })
    }
    emit(slave, { kind: 'table', count: catalog.entries.length })

    // Then walk the steps. Anything the author marked with a panel gets a
    // pause, which is close enough to how the real sample is written to make
    // the interaction worth showing.
    let index = 0
    const step = () => {
      if (signal.aborted) return
      const entry = catalog.entries[index]
      if (!entry) {
        emit(slave, { kind: 'end' })
        return
      }
      emit(slave, { kind: 'show', id: entry.id, pause: entry.panel !== undefined })
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
