import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { TopBar } from '@/components/TopBar'
import { XTerminal, type TerminalSession } from '@/components/XTerminal'
import { DisplayPanel } from '@/components/DisplayPanel'
import { TracePanel } from '@/components/TracePanel'
import { StagePill } from '@/components/StagePill'
import { Dock } from '@/components/dock/Dock'
import { FloatingWindows } from '@/components/dock/FloatingWindows'
import { DropOverlay } from '@/components/DropOverlay'
import { DtsPromptDialog } from '@/components/DtsPromptDialog'
import { AnnotationCard } from '@/components/AnnotationCard'
import { attachAnnotations } from '@/annotations/attach'
import { loadFor as loadAnnotations, reset as resetAnnotations } from '@/annotations/store'
import {
  STAGE_DISPLAY_KEY,
  getState as getDockState,
  seedForSelection,
  subscribe as subscribeDock,
} from '@/lib/dockStore'
import {
  clear as clearGuestImage,
  get as getGuestImage,
  looksLikeElf,
  readFile as readGuestImage,
  set as setGuestImage,
  stash as stashGuestImage,
  subscribe as subscribeGuestImage,
  type GuestImage,
} from '@/guestImage'
import {
  clear as clearDeviceTree,
  clearStashedDts,
  get as getDeviceTree,
  setUserDts,
  stashUserDts,
  subscribe as subscribeDeviceTree,
} from '@/devicetree'
import { emphasisPanels } from '@/dts'
import { createBackend, defaultBackendId } from '@/backends'
import type { BackendId, PtyBackend, StatusEvent } from '@/backends'
import {
  BOARDS,
  DEFAULT_BOARD_ID,
  getBoard,
  getSample,
  sampleAnnotationsAsset,
  samplePrimaryPanels,
} from '@/boards'

function StageOverlays({
  displayExpanded,
  traceExpanded,
  boardId,
  sampleId,
}: {
  displayExpanded: boolean
  traceExpanded: boolean
  boardId: string
  sampleId: string
}) {
  const dock = useSyncExternalStore(subscribeDock, getDockState, getDockState)
  return (
    <>
      {/* A paused annotation must stay above device cards. */}
      <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex justify-center md:inset-x-4 md:top-4">
        <AnnotationCard board={getBoard(boardId)} sampleId={sampleId} />
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] flex-col items-stretch gap-3 sm:right-auto sm:max-w-[min(34rem,calc(100%-1.5rem))] md:bottom-4 md:left-4">
        <div className="self-start">
          <StagePill />
        </div>
        <TracePanel defaultExpanded={traceExpanded} />
      </div>
      {!dock.devices[STAGE_DISPLAY_KEY]?.hidden && (
        <div className="pointer-events-none absolute bottom-4 right-4 z-20 flex max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col items-end">
          <DisplayPanel defaultExpanded={displayExpanded} />
        </div>
      )}
    </>
  )
}

/**
 * The selection lives in the query string so it can survive the reload that a
 * committed QEMU session needs. Without this the board and backend dropdowns
 * become dead controls the moment the emulator is running.
 */
function readSelection() {
  const params = new URLSearchParams(location.search)
  const board = params.get('board')
  const backend = params.get('backend')
  const app = params.get('app')
  const boardId = BOARDS.some((b) => b.id === board) ? board! : DEFAULT_BOARD_ID
  const resolved = getBoard(boardId)
  return {
    boardId,
    sampleId: getSample(resolved, app ?? resolved.defaultSampleId).id,
    backendId: backend === 'mock' || backend === 'qemu' ? backend : defaultBackendId(),
  }
}

export default function App() {
  const [backendId] = useState<BackendId>(() => readSelection().backendId)
  const [boardId, setBoardId] = useState(() => readSelection().boardId)
  const [sampleId, setSampleId] = useState(() => readSelection().sampleId)
  const [{ status, detail }, setStatus] = useState<StatusEvent>({ status: 'idle' })
  const [hardRestart, setHardRestart] = useState(false)
  const [nonce, setNonce] = useState(0)
  const customImage = useSyncExternalStore(subscribeGuestImage, getGuestImage, () => null)
  const deviceTree = useSyncExternalStore(subscribeDeviceTree, getDeviceTree, () => null)

  const primaryPanels =
    customImage !== null && deviceTree?.insights
      ? emphasisPanels(deviceTree.insights)
      : samplePrimaryPanels(getBoard(boardId), sampleId)
  const expandAllPanels = customImage !== null && !deviceTree?.insights
  useEffect(() => {
    seedForSelection(
      customImage !== null
        ? `custom:${customImage.name}:${deviceTree?.name ?? ''}`
        : `${boardId}:${sampleId}`,
      { primary: [...primaryPanels], expandAll: expandAllPanels },
    )
    // primaryPanels is derived from exactly these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, sampleId, customImage, deviceTree])

  // Read by mount-once terminal callbacks without changing their identity.
  const configRef = useRef({ backendId, boardId, sampleId })
  configRef.current = { backendId, boardId, sampleId }

  const backendRef = useRef<PtyBackend | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const detachAnnotationsRef = useRef<(() => void) | null>(null)

  const handleSession = useCallback(({ xterm, slave }: TerminalSession) => {
    const ac = new AbortController()
    abortRef.current = ac

    setHardRestart(false)
    setStatus({ status: 'loading' })

    // OSC annotations ride the terminal; no catalog is the normal case.
    resetAnnotations()
    detachAnnotationsRef.current = attachAnnotations(xterm)
    void loadAnnotations(
      `${import.meta.env.BASE_URL}qemu/${sampleAnnotationsAsset(
        getBoard(configRef.current.boardId),
        configRef.current.sampleId,
      )}`,
    )

    // StrictMode can tear down a session before its async status returns.
    const onStatus = (event: StatusEvent) => {
      if (!ac.signal.aborted) setStatus(event)
    }

    const run = async (id: BackendId) => {
      const backend = createBackend(id)
      backendRef.current = backend
      await backend.start(slave, {
        board: getBoard(configRef.current.boardId),
        sampleId: configRef.current.sampleId,
        onStatus,
        signal: ac.signal,
      })
      if (!ac.signal.aborted) setHardRestart(backend.resetRequiresReload)
    }

    void (async () => {
      const preferred = configRef.current.backendId
      try {
        await run(preferred)
      } catch (err: unknown) {
        if (ac.signal.aborted) return
        const message = err instanceof Error ? err.message : String(err)

        // Before QEMU commits the document, mock can take over without a reload.
        const canFallBack = preferred === 'qemu' && !backendRef.current?.resetRequiresReload
        if (!canFallBack) {
          setHardRestart(backendRef.current?.resetRequiresReload ?? false)
          setStatus({ status: 'error', detail: message })
          slave.write(`\x1b[31m${message}\x1b[0m\n`)
          return
        }

        slave.write(
          `\x1b[31mQEMU could not start: ${message}\x1b[0m\r\n` +
            `\x1b[2mFalling back to the mock shell.\x1b[0m\r\n`,
        )
        try {
          await run('mock')
        } catch {
          if (!ac.signal.aborted) setStatus({ status: 'error', detail: message })
        }
      }
    })()
  }, [])

  const handleTeardown = useCallback(() => {
    abortRef.current?.abort(new DOMException('terminal unmounted', 'AbortError'))
    abortRef.current = null
    detachAnnotationsRef.current?.()
    detachAnnotationsRef.current = null
    resetAnnotations()
  }, [])

  /**
   * A committed QEMU document cannot be recycled, so a selection change there
   * has to go through a reload carrying the new choice in the URL. Otherwise
   * the key change on <XTerminal> remounts the session in place.
   */
  const applySelection = useCallback((next: { boardId?: string; sampleId?: string }) => {
    if (backendRef.current?.resetRequiresReload) {
      const params = new URLSearchParams(location.search)
      params.set('board', next.boardId ?? configRef.current.boardId)
      params.set('app', next.sampleId ?? configRef.current.sampleId)
      params.set('backend', configRef.current.backendId)
      location.search = params.toString()
      return
    }
    if (next.boardId !== undefined) setBoardId(next.boardId)
    if (next.sampleId !== undefined) setSampleId(next.sampleId)
  }, [])

  const handleBoardChange = useCallback(
    (id: string) => {
      const board = getBoard(id)
      // Keep a shared sample (currently Hello World), otherwise choose the
      // destination board's first/default sample instead of requesting an ELF
      // that only exists for the board we just left.
      const nextSampleId = board.samples.some(
        (sample) => sample.id === configRef.current.sampleId,
      )
        ? configRef.current.sampleId
        : board.defaultSampleId
      applySelection({ boardId: id, sampleId: nextSampleId })
    },
    [applySelection],
  )

  const handleSampleChange = useCallback(
    (id: string) => {
      clearGuestImage()
      clearDeviceTree()
      applySelection({ sampleId: id })
    },
    [applySelection],
  )
  const [pendingElf, setPendingElf] = useState<GuestImage | null>(null)

  const reportError = useCallback((err: unknown) => {
    setStatus({
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
  }, [])

  // Committed QEMU sessions hand custom ELF/DTS bytes through IndexedDB reloads.
  const commitElf = useCallback(
    async (image: GuestImage, dts: { name: string; text: string } | null) => {
      setPendingElf(null)
      try {
        if (backendRef.current?.resetRequiresReload) {
          await stashGuestImage(image)
          if (dts) await stashUserDts(dts.name, dts.text)
          else await clearStashedDts()
          location.reload()
          return
        }
        if (dts) setUserDts(dts.name, dts.text)
        else clearDeviceTree()
        setGuestImage(image)
        setNonce((n) => n + 1)
      } catch (err) {
        reportError(err)
      }
    },
    [reportError],
  )

  const handleLoadElf = useCallback(
    async (file: File) => {
      try {
        setPendingElf(await readGuestImage(file))
      } catch (err) {
        reportError(err)
      }
    },
    [reportError],
  )

  const handleFilesDropped = useCallback(
    async (files: File[]) => {
      try {
        let elf: GuestImage | null = null
        let dts: { name: string; text: string } | null = null
        for (const file of files) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          if (looksLikeElf(bytes)) {
            elf ??= { name: file.name, bytes }
            continue
          }
          const text = new TextDecoder().decode(bytes)
          if (file.name.endsWith('.dts') || text.slice(0, 256).includes('/dts-v1/')) {
            dts ??= { name: file.name, text }
          }
        }

        if (elf && dts) return void commitElf(elf, dts)
        if (elf) return void setPendingElf(elf)
        if (dts) {
          // A devicetree alone only makes sense against a user image.
          if (getGuestImage() === null) {
            throw new Error(`${dts.name}: drop the ELF this devicetree belongs to as well.`)
          }
          if (backendRef.current?.resetRequiresReload) {
            await stashGuestImage(getGuestImage()!)
            await stashUserDts(dts.name, dts.text)
            location.reload()
            return
          }
          setUserDts(dts.name, dts.text)
          return
        }
        throw new Error(`${files[0].name} is not an ELF file (bad magic).`)
      } catch (err) {
        reportError(err)
      }
    },
    [commitElf, reportError],
  )

  const handleClearImage = useCallback(() => {
    clearGuestImage()
    clearDeviceTree()
    if (backendRef.current?.resetRequiresReload) {
      location.reload()
      return
    }
    setNonce((n) => n + 1)
  }, [])

  const handleRestart = useCallback(() => {
    const backend = backendRef.current
    if (backend?.resetRequiresReload) {
      void backend.reset() // navigates; nothing after this runs
      return
    }
    void backend?.reset()
    setStatus({ status: 'idle' })
    // Remount XTerminal to create a fresh xterm + pty pair.
    setNonce((n) => n + 1)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <TopBar
        boardId={boardId}
        onBoardChange={handleBoardChange}
        sampleId={sampleId}
        onSampleChange={handleSampleChange}
        status={status}
        detail={detail}
        hardRestart={hardRestart}
        onRestart={handleRestart}
        onLoadElf={handleLoadElf}
        customImage={customImage?.name ?? null}
        onClearImage={handleClearImage}
      />

      <main className="flex min-h-0 flex-1 bg-terminal">
        <div className="relative min-w-0 flex-1 p-4">
          <XTerminal
            key={`${backendId}:${boardId}:${sampleId}:${nonce}`}
            onSession={handleSession}
            onTeardown={handleTeardown}
          />
          <StageOverlays
            key={`${sampleId}:${customImage?.name ?? ''}:${deviceTree?.source ?? ''}:${deviceTree?.name ?? ''}`}
            displayExpanded={expandAllPanels || primaryPanels.has('display')}
            traceExpanded={expandAllPanels || primaryPanels.has('trace')}
            boardId={boardId}
            sampleId={sampleId}
          />
        </div>

        <Dock boardId={boardId} />
        <FloatingWindows boardId={boardId} />
      </main>

      <DropOverlay onFiles={handleFilesDropped} />

      <DtsPromptDialog
        elfName={pendingElf?.name ?? ''}
        open={pendingElf !== null}
        onDts={(file) => {
          const elf = pendingElf
          if (!elf) return
          void file
            .text()
            .then((text) => commitElf(elf, { name: file.name, text }))
            .catch(reportError)
        }}
        onSkip={() => {
          if (pendingElf) void commitElf(pendingElf, null)
        }}
        onDismiss={() => setPendingElf(null)}
      />
    </div>
  )
}
