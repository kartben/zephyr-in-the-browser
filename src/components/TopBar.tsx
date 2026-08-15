import { useCallback, useState, useSyncExternalStore } from 'react'
import { CircleHelp, Cpu, FileCode2, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { StatusPill } from '@/components/StatusPill'
import { BoardSelect } from '@/components/BoardSelect'
import { ModeSwitch } from '@/components/ModeSwitch'
import { SampleGallery } from '@/components/SampleGallery'
import { LearnDialog } from '@/components/LearnDialog'
import type { LearnStep } from '@/learn/tracks'
import { PartsCatalog } from '@/components/PartsCatalog'
import { ClearPeripheralsControl } from '@/components/ClearPeripheralsControl'
import { DockToggle, PanelsMenu } from '@/components/dock/PanelsMenu'
import { DtsViewer } from '@/components/DtsViewer'
import { SettingsMenu } from '@/components/SettingsMenu'
import { PauseDebugControl } from '@/components/PauseDebugControl'
import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import { formatChord, isMacPlatform, toggleHelp } from '@/lib/shortcuts'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import type { SessionMode } from '@/lib/modeStore'
import * as bridge from '@/probe/client'
import type { BackendStatus } from '@/backends'

interface Props {
  mode: SessionMode
  onModeChange: (mode: SessionMode) => void
  boardId: string
  onBoardChange: (id: string) => void
  sampleId: string
  onSampleChange: (id: string) => void
  status: BackendStatus
  detail?: string
  /** True once the backend can only be restarted by reloading the document. */
  hardRestart: boolean
  onRestart: () => void
  onLaunchLearnStep: (step: LearnStep) => void
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
  mode,
  onModeChange,
  boardId,
  onBoardChange,
  sampleId,
  onSampleChange,
  status,
  detail,
  hardRestart,
  onRestart,
  onLaunchLearnStep,
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
   *
   * A Live board session keeps only the tools that are about the page itself
   * (Settings, Help, panels; dock via the edge tab or the mobile drawer
   * toggle): the board is physical, so picking one, booting apps, wiring
   * parts, and restarting a guest have nothing to act on.
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

      <ModeSwitch mode={mode} onModeChange={onModeChange} />

      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-3">
        {mode === 'sim' && (
          <>
            <BoardSelect boardId={boardId} onBoardChange={onBoardChange} />

            <SampleGallery
              boardId={boardId}
              sampleId={sampleId}
              onSampleChange={onSampleChange}
              customImage={customImage}
              onLoadElf={onLoadElf}
              onClearImage={onClearImage}
            />

            <LearnDialog
              boardId={boardId}
              sampleId={sampleId}
              onLaunchStep={onLaunchLearnStep}
            />

            {/* Reference and layout tools — the first things to fold away. */}
            <span className="hidden items-center sm:flex">
              <RunningDtsButton />
              <PartsCatalog />
              <ClearPeripheralsControl />
            </span>
          </>
        )}

        <PauseDebugControl />

        <SettingsMenu />

        {/* Page chrome, same weight as Settings: shortcuts + changelog. */}
        <HelpButton />

        {/* Per-row show/hide. Desktop only: on a phone the drawer is the
            inventory, and DockToggle below is how you open it. */}
        <span className="hidden sm:inline-flex">
          <PanelsMenu boardId={boardId} />
        </span>
        {/* Desktop collapse leaves an edge tab on the dock itself; this
            control is the reopen path for the mobile overlay drawer. */}
        <MobileDockToggle />

        {mode === 'sim' ? <StatusPill status={status} detail={detail} /> : <LiveStatusPill />}

        {mode === 'sim' && (
          <Button
            className="shrink-0"
            onClick={onRestart}
            disabled={status === 'loading'}
            title={
              hardRestart
                ? 'Reset the MCU. The guest reboots; wiring and flash stay'
                : 'Restart the guest'
            }
          >
            {hardRestart ? <RefreshCw aria-hidden /> : <RotateCcw aria-hidden />}
            <span className="hidden sm:inline">{hardRestart ? 'Reset' : 'Restart'}</span>
          </Button>
        )}
      </div>
    </header>
  )
}

/**
 * The Live board counterpart of StatusPill: the session's health is the
 * bridge connection, not a backend. Self-subscribed for the same reason
 * RunningDtsButton is — connection state is the bridge client's business.
 */
function LiveStatusPill() {
  const snap = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
  const streaming = snap.phase === 'connected' && snap.serial?.phase === 'streaming'
  const label =
    snap.phase === 'connected'
      ? 'Connected'
      : snap.phase === 'connecting'
        ? 'Connecting'
        : snap.phase === 'error'
          ? 'Error'
          : 'Bridge off'
  const dot =
    snap.phase === 'connected'
      ? 'bg-success'
      : snap.phase === 'connecting'
        ? 'bg-warning animate-pulse'
        : snap.phase === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground'
  const detail = streaming ? (snap.serial?.path ?? undefined) : snap.detail || undefined

  return (
    <span
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border px-2 py-1 text-xs sm:px-2.5"
      title={detail}
    >
      <span className={cn('size-1.5 rounded-full', dot)} />
      <span className="sr-only sm:not-sr-only sm:font-medium">{label}</span>
      {detail && (
        <span
          className="hidden max-w-[22ch] truncate font-mono text-muted-foreground lg:inline"
          aria-label="status detail"
        >
          {detail}
        </span>
      )}
    </span>
  )
}

/**
 * Opens the help dialog (shortcuts + changelog). Sits with Settings as
 * always-available page chrome, including on Live board.
 */
function HelpButton() {
  const chord = formatChord({ key: '?' }, isMacPlatform())
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      aria-label="Help"
      title={`Help (${chord})`}
      onClick={() => toggleHelp()}
    >
      <CircleHelp className="size-4" />
    </Button>
  )
}

/** Top-bar dock control only on narrow viewports (overlay drawer). */
function MobileDockToggle() {
  const desktop = useIsDesktop()
  if (desktop) return null
  return <DockToggle />
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
