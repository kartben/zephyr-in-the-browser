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

/**
 * The follow-up to loading a custom ELF: optionally take its zephyr.dts too.
 *
 * With the devicetree the peripheral panels are grounded — only the buses the
 * build enables appear, with its own pin names and I2C slots. Without it the
 * peripherals stay unknowable and everything the machine exposes is shown
 * expanded, exactly the pre-devicetree behavior.
 *
 * Three exits: a .dts (boot with it), Skip (boot without), or dismissing the
 * dialog (don't boot — the drop is forgotten).
 */
export function DtsPromptDialog({
  elfName,
  open,
  onDts,
  onSkip,
  onDismiss,
}: {
  elfName: string
  open: boolean
  /** Boot the pending ELF, grounding the panels in this devicetree. */
  onDts: (file: File) => void
  /** Boot the pending ELF without a devicetree. */
  onSkip: () => void
  /** Forget the pending ELF entirely. */
  onDismiss: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add its devicetree?</DialogTitle>
          <DialogDescription>
            Booting <code className="font-mono text-foreground">{elfName}</code>. Add the build&apos;s{' '}
            <code className="font-mono">zephyr.dts</code> (from{' '}
            <code className="font-mono">build/zephyr/</code>) and the dock follows it — the right
            buses, GPIO pin names and I²C chips. Skip it and you get every panel this machine has.
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
