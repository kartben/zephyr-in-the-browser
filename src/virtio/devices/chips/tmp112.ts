/**
 * The TMP112 moved onto the generic sensor framework (src/virtio/devices/
 * sensors/). This file stays as the historical import path — the chip, its
 * options and its `setCelsius`/`getCelsius` surface are re-exported unchanged.
 */

export {
  createTmp112,
  tmp112Decl,
  type Tmp112Chip,
  type Tmp112Options,
} from '../sensors/tmp112'
