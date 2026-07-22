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
import { BOARDS } from '@/boards'

/** Sentinel value: an action item rather than a selectable board. */
const LOAD_ELF = '__load_elf__'

interface Props {
  boardId: string
  onBoardChange: (id: string) => void
  onLoadElf: (file: File) => void
  /** Filename of the user-supplied image currently in use, if any. */
  customImage: string | null
  onClearImage: () => void
}

export function BoardSelect({
  boardId,
  onBoardChange,
  onLoadElf,
  customImage,
  onClearImage,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex shrink-0 items-center gap-2">
      {/* Naming the control matters: "board" and "backend" are not self-evident
          side by side, and the dropdown alone gave no hint which was which. */}
      <label className="hidden text-xs text-muted-foreground lg:inline" htmlFor="board-select">
        Board
      </label>
      <Select
        value={boardId}
        onValueChange={(v) => (v === LOAD_ELF ? fileRef.current?.click() : onBoardChange(v))}
      >
        <SelectTrigger id="board-select" className="w-[11.5rem]" aria-label="Board">
          {/* Explicit, not <SelectValue />: the dropdown items are two-line and
              would otherwise render that way inside the closed trigger too. */}
          <span className="truncate">{BOARDS.find((b) => b.id === boardId)?.label}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Machine QEMU emulates</SelectLabel>
            {BOARDS.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                <span className="flex flex-col items-start">
                  <span>{b.label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {b.arch} · {b.zephyrTarget}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          {/*
            The board still selects the *machine*; this only swaps the image it
            boots, which is why it sits below a separator rather than among the
            boards.
          */}
          <SelectItem value={LOAD_ELF}>
            <span className="flex items-center gap-2">
              <FileUp className="size-3.5 opacity-70" />
              Load ELF…
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      {customImage && (
        <span
          className="inline-flex max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 py-1 pl-2.5 pr-1 text-xs"
          title={`Booting ${customImage} instead of the board's stock image`}
        >
          <span className="truncate font-mono text-[11px]">{customImage}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-4 rounded-full"
            aria-label="Use the board's stock image"
            onClick={onClearImage}
          >
            <X className="size-3" />
          </Button>
        </span>
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
