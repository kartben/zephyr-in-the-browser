import { useEffect, useState } from 'react'
import { FileUp } from 'lucide-react'

/**
 * Whole-window drop target for guest images.
 *
 * Drag events fire per-element and bubble, so a naive dragleave handler
 * flickers as the pointer crosses child boundaries. Counting enter/leave pairs
 * is the standard fix — the overlay hides only when the count returns to zero.
 */
export function DropOverlay({ onFile }: { onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let depth = 0

    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Without preventDefault the browser navigates to the dropped file.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) onFile(file)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [onFile])

  if (!dragging) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-8">
      <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-primary px-10 py-8 text-center">
        <FileUp className="size-7 text-primary" aria-hidden />
        <p className="text-sm font-medium">Drop an ELF to boot it</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Replaces the board's stock image. The machine stays whatever the board
          selector says, so the ELF has to be built for it.
        </p>
      </div>
    </div>
  )
}
