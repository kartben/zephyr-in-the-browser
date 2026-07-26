/** Dialog that asks how dropped DTS files should be used. */

import { useRef } from 'react'
import { FileCode2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function DtsPromptDialog({
  elfName,
  open,
  onDts,
  onSkip,
  onDismiss,
}: {
  elfName: string
  open: boolean
  onDts: (file: File) => void
  onSkip: () => void
  onDismiss: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add its devicetree?</DialogTitle>
          <DialogDescription>
            Booting <code className="font-mono text-foreground">{elfName}</code>. If you add the
            build&apos;s <code className="font-mono">zephyr.dts</code> (from{' '}
            <code className="font-mono">build/zephyr/</code>), the peripheral panels follow it —
            which buses exist, the GPIO pin names, the I2C chips with drivers. Skipping just shows
            every panel this machine has.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" onClick={onSkip}>
            Skip — boot without it
          </Button>
          <Button onClick={() => fileRef.current?.click()}>
            <FileCode2 aria-hidden />
            Add zephyr.dts…
          </Button>
        </DialogFooter>

        <input
          ref={fileRef}
          type="file"
          accept=".dts"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) onDts(file)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
