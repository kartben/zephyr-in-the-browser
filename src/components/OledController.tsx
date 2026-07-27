/**
 * Collapsed-by-default status inspector for the SSD1306.
 *
 * The OLED is a *command stream*, not a pointered register file — so this is
 * not the SVD-style Registers dialog. It still gives the same "open when you
 * care" affordance: live on/invert/contrast/addressing window as the guest
 * last programmed them.
 */

import { useEffect, useReducer, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Ssd1306Chip } from '@/virtio/devices/chips/ssd1306'

const UI_MS = 100

function useChip(chip: Ssd1306Chip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      const now = performance.now()
      const wait = UI_MS - (now - last)
      if (wait <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        refresh()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, wait)
    })
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
}

export function OledControllerButton({ chip }: { chip: Ssd1306Chip }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Status
      </button>
      <OledControllerDialog chip={chip} open={open} onOpenChange={setOpen} />
    </>
  )
}

function OledControllerDialog({
  chip,
  open,
  onOpenChange,
}: {
  chip: Ssd1306Chip
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  useChip(chip)
  const state = chip.getControllerState()
  const hex = chip.address.toString(16).padStart(2, '0')

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Display', value: state.on ? 'on' : 'off' },
    { label: 'Invert', value: state.inverted ? 'yes' : 'no' },
    { label: 'Contrast', value: `0x${state.contrast.toString(16).toUpperCase().padStart(2, '0')}` },
    { label: 'Addressing', value: state.addressingMode },
    { label: 'Column window', value: `${state.columnStart}–${state.columnEnd}` },
    { label: 'Page window', value: `${state.pageStart}–${state.pageEnd}` },
    { label: 'Cursor', value: `col ${state.cursorColumn}, page ${state.cursorPage}` },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {chip.name} · 0x{hex}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Live OLED display state
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto border-t border-border px-5 py-3">
          <dl className="space-y-1.5">
            {rows.map((row) => (
              <div key={row.label} className="grid grid-cols-[7rem_1fr] gap-2 text-[11px]">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="font-mono tabular-nums text-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </DialogContent>
    </Dialog>
  )
}
