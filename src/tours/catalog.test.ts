import { describe, expect, it } from 'vitest'
import type { Board } from '@/boards'
import { nextSampleId } from '@/tours/catalog'

/** Only the app list matters to where a `next:` lands. */
function board(...ids: string[]): Board {
  return { samples: ids.map((id) => ({ id })) } as unknown as Board
}

describe('nextSampleId', () => {
  it('lands on the app the tour is named after', () => {
    expect(nextSampleId(board('msg_queue', 'msgq_lab'), 'msg_queue', 'msgq_lab')).toBe('msgq_lab')
  })

  it('keeps a reader on a traced twin on the next one', () => {
    const a53 = board('msg_queue', 'msg_queue_trace', 'msgq_lab', 'msgq_lab_trace')
    expect(nextSampleId(a53, 'msg_queue_trace', 'msgq_lab')).toBe('msgq_lab_trace')
    expect(nextSampleId(a53, 'msg_queue', 'msgq_lab')).toBe('msgq_lab')
  })

  it('falls back to the plain app when the next one has no traced twin', () => {
    expect(nextSampleId(board('blinky_trace', 'basic_button'), 'blinky_trace', 'basic_button')).toBe(
      'basic_button',
    )
  })

  it('is null when this board does not offer the next app', () => {
    expect(nextSampleId(board('msg_queue'), 'msg_queue', 'msgq_lab')).toBeNull()
  })
})
