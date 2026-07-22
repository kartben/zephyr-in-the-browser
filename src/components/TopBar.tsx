import { Cpu, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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

        <Select value={backendId} onValueChange={(v) => onBackendChange(v as BackendId)}>
          <SelectTrigger className="w-[8.5rem]" aria-label="Backend">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="qemu">QEMU</SelectItem>
            <SelectItem value="mock">Mock shell</SelectItem>
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
