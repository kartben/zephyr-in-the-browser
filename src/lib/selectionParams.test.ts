import { describe, expect, it } from 'vitest'
import { BOARDS, DEFAULT_BOARD_ID, getBoard } from '@/boards'
import { carryTour, parseSelection, tourLink } from '@/lib/selectionParams'

const parse = (search: string) => parseSelection(search, 'qemu')

describe('parseSelection', () => {
  it('reads the board, app and backend, as the page always has', () => {
    expect(parse('?board=qemu_cortex_a53&app=blinky&backend=mock')).toEqual({
      boardId: 'qemu_cortex_a53',
      sampleId: 'blinky',
      backendId: 'mock',
      tour: null,
      step: null,
    })
  })

  it('falls back to the default board and app, and the backend it is given', () => {
    const selection = parse('?board=nope&backend=nope')
    expect(selection.boardId).toBe(DEFAULT_BOARD_ID)
    expect(selection.sampleId).toBe(getBoard(DEFAULT_BOARD_ID).defaultSampleId)
    expect(selection.backendId).toBe('qemu')
  })

  it('reads a tour by id, and a step counted from 1', () => {
    expect(
      parse('?board=qemu_cortex_a53&app=basic_button&tour=basic_button.msgq&step=3'),
    ).toMatchObject({ sampleId: 'basic_button', tour: 'basic_button.msgq', step: 3 })
  })

  it('reads `none` as a run with no tour', () => {
    expect(parse('?app=blinky&tour=none').tour).toBe('none')
  })

  it.each(['', 'samples/basic/blinky', 'blinky.', '.msgq', 'a.b.c', '<b>'])(
    'reads tour=%j as no tour named',
    (tour) => {
      expect(parse(`?app=blinky&tour=${encodeURIComponent(tour)}`).tour).toBeNull()
    },
  )

  it.each(['', '0', '-1', '2.5', '03', 'three'])('reads step=%j as no step', (step) => {
    expect(parse(`?app=blinky&step=${step}`).step).toBeNull()
  })

  it("runs a tour's app when the link names only the tour", () => {
    expect(parse('?board=qemu_cortex_a53&tour=basic_button.msgq')).toMatchObject({
      sampleId: 'basic_button',
      tour: 'basic_button.msgq',
    })
  })

  it("stays on the board's default app when the board has no app for that tour", () => {
    const board = BOARDS.find((b) => !b.samples.some((s) => s.id === 'philosophers'))!
    expect(parse(`?board=${board.id}&tour=philosophers`).sampleId).toBe(board.defaultSampleId)
  })

  it("lets an app the link names win over the tour's", () => {
    expect(parse('?board=qemu_cortex_a53&app=blinky&tour=basic_button.msgq')).toMatchObject({
      sampleId: 'blinky',
      tour: 'basic_button.msgq',
    })
  })
})

describe('carryTour', () => {
  it('keeps a tour while the app stays the same, traced twin or not', () => {
    expect(carryTour('basic_button.msgq', 'basic_button', 'basic_button_trace')).toBe(
      'basic_button.msgq',
    )
  })

  it('drops a tour of another app', () => {
    expect(carryTour('basic_button.msgq', 'basic_button', 'blinky')).toBeNull()
  })

  it('keeps a clean run only on the same app', () => {
    expect(carryTour('none', 'blinky', 'blinky_trace')).toBe('none')
    expect(carryTour('none', 'blinky', 'basic_button')).toBeNull()
  })

  it('has nothing to carry when no tour was asked for', () => {
    expect(carryTour(null, 'blinky', 'blinky')).toBeNull()
  })
})

describe('tourLink', () => {
  const at = {
    boardId: 'qemu_cortex_a53',
    sampleId: 'basic_button_trace',
    tourId: 'basic_button.msgq',
    step: 3,
  }

  it('names the board, app, tour and step, and nothing else', () => {
    expect(tourLink('https://example.org/zitb/', at)).toBe(
      'https://example.org/zitb/?board=qemu_cortex_a53&app=basic_button_trace&tour=basic_button.msgq&step=3',
    )
  })

  it('leaves the step out at the first one, where the tour starts anyway', () => {
    expect(tourLink('http://localhost:5173/', { ...at, step: 1 })).not.toContain('step=')
  })

  it('reads back as the selection it was made from', () => {
    const link = new URL(tourLink('http://localhost:5173/', at))
    expect(parse(link.search)).toMatchObject({
      boardId: at.boardId,
      sampleId: at.sampleId,
      tour: at.tourId,
      step: at.step,
    })
  })
})
