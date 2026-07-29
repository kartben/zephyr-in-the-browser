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
  const board = BOARDS.find((b) => b.id === boardId)
  return (
    <div className="flex shrink-0 items-center gap-2">
      <label className="hidden text-xs text-muted-foreground xl:inline" htmlFor="board-select">
        Board
      </label>
      <Select value={boardId} onValueChange={onBoardChange}>
        {/*
          Narrow: the core alone ("A53"), so the app name next to it keeps the
          room it needs. Full label from `sm` up.
        */}
        <SelectTrigger
          id="board-select"
          className="w-[4.5rem] px-2 sm:w-[11.5rem] sm:px-3"
          aria-label="Board"
          title={board?.label}
        >
          {/* Explicit, not <SelectValue />: the items are two-line and would
              otherwise render that way inside the closed trigger too. */}
          <span className="truncate sm:hidden">{board?.shortLabel}</span>
          <span className="hidden truncate sm:inline">{board?.label}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Board</SelectLabel>
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
