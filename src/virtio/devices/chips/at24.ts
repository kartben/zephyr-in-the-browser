/**
 * The AT24 moved onto the generic memory framework (src/virtio/devices/
 * memory/). This file stays as the historical import path — the chip and its
 * options are re-exported unchanged.
 */

export { createAt24, at24Decl, type At24Chip, type At24Options } from '../memory/at24'
