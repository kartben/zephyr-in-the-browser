import { describe, expect, it } from 'vitest'
import { stripDtsProvenance } from './provenance'

describe('stripDtsProvenance', () => {
  it('drops node origin lines and property origin comments, with their padding', () => {
    const built = [
      "\t/* node '/buttons' defined in zephyr/boards/vendor/board/board.dts:28 */",
      '\tbuttons {',
      '\t\tcompatible = "gpio-keys"; /* in zephyr/boards/vendor/board/board.dts:29 */',
      '',
      "\t\t/* node '/buttons/button_0' defined in ../../zephyr-module/x.overlay:31 */",
      '\t\tbutton0: button_0 {',
      '\t\t\tgpios = < &gpio0 0x0 0x11 >; /* in ../../zephyr-module/x.overlay:32 */',
      '\t\t\tlabel = "BOOT Button";       /* in ../../zephyr-module/x.overlay:33 */',
      '\t\t\tgpio-controller;             /* in ../../zephyr-module/x.overlay:34 */',
      '\t\t};',
      '\t};',
    ]
    expect(stripDtsProvenance(built)).toEqual([
      '\tbuttons {',
      '\t\tcompatible = "gpio-keys";',
      '',
      '\t\tbutton0: button_0 {',
      '\t\t\tgpios = < &gpio0 0x0 0x11 >;',
      '\t\t\tlabel = "BOOT Button";',
      '\t\t\tgpio-controller;',
      '\t\t};',
      '\t};',
    ])
  })

  it('leaves a tree without them, and look-alikes inside strings, as they are', () => {
    const plain = ['/ {', '\tmodel = "/* in a.dts:1 */ board";', '\t/* a note */', '};']
    expect(stripDtsProvenance(plain)).toEqual(plain)
  })
})
