import { Cpu, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select'
import { StatusPill } from '@/components/StatusPill'
import { BoardSelect } from '@/components/BoardSelect'
import type { BackendId, BackendStatus } from '@/backends'

interface Props {
  boardId: string
  onBoardChange: (id: string) => void
  backendId: BackendId
  onBackendChange: (id: BackendId) => void
  status: BackendStatus
  detail?: string
  /** True once the backend can only be restarted by reloading the document. */
  hardRestart: boolean
  onRestart: () => void
  onLoadElf: (file: File) => void
  /** Filename of the user-supplied guest image in use, if any. */
  customImage: string | null
  onClearImage: () => void
}

export function TopBar({
  boardId,
  onBoardChange,
  backendId,
  onBackendChange,
  status,
  detail,
  hardRestart,
  onRestart,
  onLoadElf,
  customImage,
  onClearImage,
}: Props) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-5">
      <div className="flex shrink-0 items-center gap-2.5">
        <Cpu className="size-4 text-primary" aria-hidden />
        {/* The wordmark is the first thing to go when the bar gets tight. */}
        <h1 className="hidden whitespace-nowrap text-sm font-semibold tracking-tight md:block">
          Zephyr in the Browser
        </h1>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <BoardSelect
          boardId={boardId}
          onBoardChange={onBoardChange}
          onLoadElf={onLoadElf}
          customImage={customImage}
          onClearImage={onClearImage}
        />

        <label className="hidden text-xs text-muted-foreground lg:inline" htmlFor="backend-select">
          Runs on
        </label>
        <Select value={backendId} onValueChange={(v) => onBackendChange(v as BackendId)}>
          <SelectTrigger id="backend-select" className="w-[8.5rem]" aria-label="Backend">
            <span className="truncate">{backendId === 'qemu' ? 'QEMU' : 'Mock shell'}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>What drives the terminal</SelectLabel>
              <SelectItem value="qemu">
                <span className="flex flex-col items-start">
                  <span>QEMU</span>
                  <span className="text-[11px] text-muted-foreground">
                    real emulator, real Zephyr
                  </span>
                </span>
              </SelectItem>
              <SelectItem value="mock">
                <span className="flex flex-col items-start">
                  <span>Mock shell</span>
                  <span className="text-[11px] text-muted-foreground">
                    canned replies, no emulator
                  </span>
                </span>
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>

        <StatusPill status={status} detail={detail} />

        <Button onClick={onRestart} disabled={status === 'loading'}>
          {hardRestart ? <RefreshCw aria-hidden /> : <RotateCcw aria-hidden />}
          {hardRestart ? 'Reload' : 'Restart'}
        </Button>
      </div>
    </header>
  )
}
