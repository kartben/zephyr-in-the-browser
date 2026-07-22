import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select'
import { BOARDS } from '@/boards'

/**
 * Selects the emulated machine, and nothing else. The guest image is a separate
 * control — an ELF is not a board, and putting "Load ELF…" in this list made two
 * unrelated kinds of thing look like alternatives.
 */
export function BoardSelect({
  boardId,
  onBoardChange,
}: {
  boardId: string
  onBoardChange: (id: string) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <label className="hidden text-xs text-muted-foreground lg:inline" htmlFor="board-select">
        Board
      </label>
      <Select value={boardId} onValueChange={onBoardChange}>
        <SelectTrigger id="board-select" className="w-[11.5rem]" aria-label="Board">
          {/* Explicit, not <SelectValue />: the items are two-line and would
              otherwise render that way inside the closed trigger too. */}
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
        </SelectContent>
      </Select>
    </div>
  )
}
