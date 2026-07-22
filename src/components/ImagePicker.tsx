import { useRef } from 'react'
import { FileUp, X } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { getBoard, getSample } from '@/boards'

/** Sentinel: an action, not a selectable image. */
const LOAD_ELF = '__load_elf__'

interface Props {
  boardId: string
  sampleId: string
  onSampleChange: (id: string) => void
  /** Filename of the user-supplied image in use, if any. */
  customImage: string | null
  onLoadElf: (file: File) => void
  onClearImage: () => void
}

/**
 * Selects the program the board runs — separate from the board itself, since a
 * machine and the software on it are different kinds of thing.
 */
export function ImagePicker({
  boardId,
  sampleId,
  onSampleChange,
  customImage,
  onLoadElf,
  onClearImage,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const board = getBoard(boardId)

  return (
    <div className="flex min-w-0 shrink items-center gap-2">
      <label className="hidden text-xs text-muted-foreground lg:inline" htmlFor="image-select">
        App
      </label>
      <Select
        // A custom ELF is not one of the listed values, so leave the Select
        // uncontrolled-looking rather than lying about which sample is active.
        value={customImage ? '' : sampleId}
        onValueChange={(v) => (v === LOAD_ELF ? fileRef.current?.click() : onSampleChange(v))}
      >
        <SelectTrigger id="image-select" className="w-[11rem]" aria-label="App">
          <span className={customImage ? 'truncate font-mono text-[11px]' : 'truncate'}>
            {customImage ?? getSample(board, sampleId).label}
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Zephyr app to boot</SelectLabel>
            {board.samples.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="flex flex-col items-start">
                  <span>{s.label}</span>
                  <span className="text-[11px] text-muted-foreground">{s.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value={LOAD_ELF}>
            <span className="flex items-center gap-2">
              <FileUp className="size-3.5 opacity-70" />
              Load your own ELF…
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      {customImage && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="Go back to a built-in app"
          title="Go back to a built-in app"
          onClick={onClearImage}
        >
          <X className="size-3.5" />
        </Button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".elf,application/x-elf,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Reset so picking the same file twice still fires a change event.
          e.target.value = ''
          if (file) onLoadElf(file)
        }}
      />
    </div>
  )
}
