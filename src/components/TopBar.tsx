import { useCallback, useState, useSyncExternalStore } from 'react'
import { Cpu, FileCode2, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/StatusPill'
import { BoardSelect } from '@/components/BoardSelect'
import { SampleGallery } from '@/components/SampleGallery'
import { PartsCatalog } from '@/components/PartsCatalog'
import { ClearPeripheralsControl } from '@/components/ClearPeripheralsControl'
import { DockToggle, PanelsMenu } from '@/components/dock/PanelsMenu'
import { DtsViewer } from '@/components/DtsViewer'
import { PauseDebugControl } from '@/components/PauseDebugControl'
import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import type { BackendStatus } from '@/backends'

interface Props {
  boardId: string
  onBoardChange: (id: string) => void
  sampleId: string
  onSampleChange: (id: string) => void
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

/*
 * There is deliberately no backend selector. The mock exists so a checkout with
 * no emulator still runs, not as something worth choosing: whenever QEMU is
 * available it is simply used, and when it is not the app falls back on its own
 * and says so in the terminal. Offering the two side by side implied the fake
 * one was a legitimate alternative to the real one.
 */
export function TopBar({
  boardId,
  onBoardChange,
  sampleId,
  onSampleChange,
  status,
  detail,
  hardRestart,
  onRestart,
  onLoadElf,
  customImage,
  onClearImage,
}: Props) {
  /*
   * Three groups, in falling order of how often they are touched: what to run,
   * the reference/layout tools, and the machine's state. Everything between the
   * selectors and the status pill is allowed to shrink away on a narrow screen;
   * Reset and the status pill never do — they used to be pushed off the right
   * edge on a phone, which left no way to restart a wedged guest.
   */
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:gap-3 sm:px-5">
      <div className="flex shrink-0 items-center gap-2.5">
        <Cpu className="size-4 text-primary" aria-hidden />
        {/* The wordmark is the first thing to go when the bar gets tight. */}
        <h1 className="hidden whitespace-nowrap text-sm font-semibold tracking-tight lg:block">
          Zephyr in the Browser
        </h1>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-3">
        <BoardSelect boardId={boardId} onBoardChange={onBoardChange} />

        <SampleGallery
          boardId={boardId}
          sampleId={sampleId}
          onSampleChange={onSampleChange}
          customImage={customImage}
          onLoadElf={onLoadElf}
          onClearImage={onClearImage}
        />

        {/* Reference and layout tools — the first things to fold away. */}
        <span className="hidden items-center sm:flex">
          <RunningDtsButton />
          <PartsCatalog />
          <ClearPeripheralsControl />
        </span>

        <PauseDebugControl />

        {/* The drawer itself is how you manage panels on a phone — every row
            collapses in place, so the checklist is desktop-only chrome. */}
        <span className="hidden sm:inline-flex">
          <PanelsMenu boardId={boardId} />
        </span>
        <DockToggle />

        <StatusPill status={status} detail={detail} />

        <Button
          className="shrink-0"
          onClick={onRestart}
          disabled={status === 'loading'}
          title={
            hardRestart
              ? 'Reset the MCU. The emulator reboots; wiring and flash stay'
              : 'Restart the emulator'
          }
        >
          {hardRestart ? <RefreshCw aria-hidden /> : <RotateCcw aria-hidden />}
          <span className="hidden sm:inline">{hardRestart ? 'Reset' : 'Restart'}</span>
        </Button>
      </div>
    </header>
  )
}

/**
 * Opens the devicetree of the *running* build in the viewer. Self-subscribed
 * rather than threaded through TopBar's props: whether a tree is known is the
 * devicetree store's business, and the button simply is not there when none is.
 */
function RunningDtsButton() {
  const deviceTree = useSyncExternalStore(subscribeDeviceTree, getDeviceTree, () => null)
  const [open, setOpen] = useState(false)
  const load = useCallback(() => Promise.resolve(getDeviceTree()?.text ?? null), [])

  if (!deviceTree) return null

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label="View the running build's devicetree"
        title={`Devicetree: ${deviceTree.name}`}
        onClick={() => setOpen(true)}
      >
        <FileCode2 className="size-4" />
      </Button>
      <DtsViewer
        open={open}
        onOpenChange={setOpen}
        title={`${deviceTree.name} — running build`}
        load={load}
      />
    </>
  )
}
