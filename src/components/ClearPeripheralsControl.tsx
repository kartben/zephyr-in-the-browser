/**
 * TopBar control that unsolders breadboard Attach wiring in one click.
 *
 * Icon-only and absent until there is something to clear — same pattern as the
 * running-devicetree and parts-catalog buttons. Tooltip carries the meaning;
 * the panels keep per-chip Detach for surgical removes.
 */

import { useSyncExternalStore } from 'react'
import { Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  clearUserPeripherals,
  hasUserPeripherals,
  i2cModel,
  spiModel,
} from '@/virtio'

export function ClearPeripheralsControl() {
  // Attach / detach / clear all notify the bus models; that is enough to know
  // whether the breadboard (or a stranger on it) is present.
  useSyncExternalStore(i2cModel.subscribe, i2cModel.chips, i2cModel.chips)
  useSyncExternalStore(spiModel.subscribe, spiModel.chips, spiModel.chips)

  if (!hasUserPeripherals()) return null

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground"
      aria-label="Clear breadboard attachments"
      title="Clear breadboard attachments"
      onClick={() => clearUserPeripherals()}
    >
      <Unplug className="size-3.5" aria-hidden />
    </Button>
  )
}
