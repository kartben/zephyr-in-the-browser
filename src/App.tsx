import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { TopBar } from '@/components/TopBar'
import { XTerminal, type TerminalSession } from '@/components/XTerminal'
import { Dock } from '@/components/dock/Dock'
import { FloatingWindows } from '@/components/dock/FloatingWindows'
import { InstrumentWindows } from '@/components/dock/Instruments'
import { DropOverlay } from '@/components/DropOverlay'
import { DtsPromptDialog } from '@/components/DtsPromptDialog'
import { ShortcutsHelpDialog } from '@/components/ShortcutsHelpDialog'
import { TourCard } from '@/components/TourCard'
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts'
import { registerCommand } from '@/lib/commands'
import { loadFor as loadTour, reset as resetTour } from '@/tours/store'
import { seedForSelection } from '@/lib/dockStore'
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
  markAbsent as markDeviceTreeAbsent,
  setUserDts,
  stashUserDts,
  subscribe as subscribeDeviceTree,
} from '@/devicetree'
import { emphasisPanels } from '@/dts'
import { createBackend, defaultBackendId } from '@/backends'
import type { BackendId, PtyBackend, StatusEvent } from '@/backends'
import { startBridgeClient } from '@/probe/client'
import { getMode, setMode, MODE_QUERY_PARAM, type SessionMode } from '@/lib/modeStore'
import { setLiveMode } from '@/debug/liveDebug'
import { LiveBoardHome } from '@/components/LiveBoardHome'
import { set as setLiveImage, type LiveImage } from '@/liveImage'
import {
  BOARDS,
  DEFAULT_BOARD_ID,
  getBoard,
  getSample,
  sampleSourceAsset,
  samplePrimaryPanels,
  type PanelKind,
} from '@/boards'

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
  useGlobalShortcuts()
  useEffect(() => {
    startBridgeClient()
  }, [])
  // Fixed for the document's life: mode changes navigate (see modeStore).
  const mode = getMode()
  useEffect(() => {
    // Live sessions get their debugger bound (bridge source, ELF symbols).
    setLiveMode(mode === 'live')
    // mode is fixed for the document's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [backendId] = useState<BackendId>(() => readSelection().backendId)
  const [boardId, setBoardId] = useState(() => readSelection().boardId)
  const [sampleId, setSampleId] = useState(() => readSelection().sampleId)
  const [{ status, detail }, setStatus] = useState<StatusEvent>({ status: 'idle' })
  const [hardRestart, setHardRestart] = useState(false)
  const [nonce, setNonce] = useState(0)
  const customImage = useSyncExternalStore(subscribeGuestImage, getGuestImage, () => null)
  const deviceTree = useSyncExternalStore(subscribeDeviceTree, getDeviceTree, () => null)

  /*
   * What opens expanded: the sample's primaryPanels, a DTS-grounded custom
   * ELF's emphasis set (always including Trace + Debug — dropped ELFs may
   * have CTF semihosting / DEBUG_THREAD_INFO), or everything for an ELF whose
   * peripherals are unknowable. These feed the dock's per-selection seed —
   * user expansion choices override the seed and survive a same-selection
   * reload, and a new selection reseeds (dockStore's contract).
   */
  const primaryPanels = (() => {
    if (customImage !== null && deviceTree?.insights) {
      return new Set<PanelKind>([...emphasisPanels(deviceTree.insights), 'trace', 'debug'])
    }
    if (customImage !== null) {
      // expandAll covers interactive dock rows; still seed Trace + Debug so
      // their instrument rows open even before anything is discovered.
      return new Set<PanelKind>(['trace', 'debug'])
    }
    return samplePrimaryPanels(getBoard(boardId), sampleId)
  })()
  const expandAllPanels = customImage !== null && !deviceTree?.insights
  useEffect(() => {
    // A Live board session has no guest: Trace and Debug are the point, and
    // there is no device inventory.
    if (mode === 'live') {
      seedForSelection('live', { primary: ['trace', 'debug'], expandAll: false })
      return
    }
    seedForSelection(
      customImage !== null
        ? `custom:${customImage.name}:${deviceTree?.name ?? ''}`
        : `${boardId}:${sampleId}`,
      { primary: [...primaryPanels], expandAll: expandAllPanels },
    )
    // primaryPanels is derived from exactly these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, sampleId, customImage, deviceTree])

  // Current selection, readable from the mount-once terminal callbacks without
  // making them change identity (which would remount the terminal).
  const configRef = useRef({ backendId, boardId, sampleId })
  configRef.current = { backendId, boardId, sampleId }

  const backendRef = useRef<PtyBackend | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const handleSession = useCallback(({ slave }: TerminalSession) => {
    const ac = new AbortController()
    abortRef.current = ac

    setHardRestart(false)
    setStatus({ status: 'loading' })

    /*
     * The tour, if this sample has one. It rides in the page bundle, so it is
     * there whatever the guest images do — only the source excerpts come from
     * the image build. Fire-and-forget. Loading it early matters
     * — the store hands the debugger an attach hook, and the breakpoints have
     * to be planted at the stop that opening the gdbstub produces, before the
     * guest runs past main().
     */
    resetTour()
    void loadTour(
      configRef.current.sampleId,
      (file) =>
        `${import.meta.env.BASE_URL}qemu/${sampleSourceAsset(
          getBoard(configRef.current.boardId),
          configRef.current.sampleId,
          file,
        )}`,
    )

    // Drop status updates from a session that has already been torn down —
    // StrictMode's double mount in dev makes this a real ordering hazard.
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

        /*
         * With no backend selector, an emulator that will not start must not
         * leave a dead terminal. A pre-commit failure (missing assets, no
         * cross-origin isolation) has touched nothing, so the mock can take
         * over — but say why, or it looks like the real thing booted.
         */
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
    resetTour()
  }, [])

  /**
   * Switching mode always navigates: a committed QEMU document cannot be
   * recycled, and one code path removes every mid-boot teardown hazard.
   * Persist first — with storage blocked, the URL still carries the intent —
   * and write ?mode= explicitly so a refresh cannot surprise-flip (the param
   * outranks ?bridge= in resolveModeConfig).
   */
  const handleModeChange = useCallback((next: SessionMode) => {
    if (next === getMode()) return
    setMode(next)
    const params = new URLSearchParams(location.search)
    params.set(MODE_QUERY_PARAM, next)
    location.search = params.toString() // navigates; nothing after this runs
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

  /**
   * Choosing a built-in app also drops any user-supplied ELF — and with it any
   * user devicetree, which must not leak onto a sample. The sample's own tree
   * is re-fetched by the backend when the new session starts. Await the
   * IndexedDB clears before any hard navigation so Reload cannot resurrect them.
   */
  const handleSampleChange = useCallback(
    (id: string) => {
      void (async () => {
        await clearGuestImage()
        await clearDeviceTree()
        applySelection({ sampleId: id })
      })()
    },
    [applySelection],
  )
  /**
   * A user ELF awaiting its optional devicetree — the prompt dialog is open
   * while this is set. Booting happens in commitElf, not before.
   */
  const [pendingElf, setPendingElf] = useState<GuestImage | null>(null)

  const reportError = useCallback((err: unknown) => {
    setStatus({
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
  }, [])

  /**
   * Boot a user-supplied ELF, with or without its devicetree. Both files are
   * persisted in IndexedDB for the session so Reload / refresh keeps them; a
   * committed QEMU document still has to navigate to pick the new bytes up.
   * A stale stashed devicetree is cleared either way, so skipping the prompt
   * cannot resurrect an old one.
   */
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
        else await markDeviceTreeAbsent()
        setGuestImage(image)
        setNonce((n) => n + 1)
      } catch (err) {
        reportError(err)
      }
    },
    [reportError],
  )

  /** An ELF chosen via the picker: validate it, then ask about its devicetree. */
  const handleLoadElf = useCallback(
    async (file: File) => {
      try {
        if (mode === 'live') {
          setLiveImage(await readGuestImage(file))
          return
        }
        setPendingElf(await readGuestImage(file))
      } catch (err) {
        reportError(err)
      }
    },
    // mode is fixed for the document's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reportError],
  )

  /**
   * Files dropped on the window: an ELF (prompt for its devicetree), an ELF
   * plus a .dts (boot with both, no prompt), or a .dts alone for the custom
   * image already running.
   */
  const handleFilesDropped = useCallback(
    async (files: File[]) => {
      // A Live board session takes the ELF as debug symbols — nothing boots.
      if (mode === 'live') {
        try {
          let elf: LiveImage | null = null
          for (const file of files) {
            const bytes = new Uint8Array(await file.arrayBuffer())
            if (looksLikeElf(bytes)) {
              elf ??= { name: file.name, bytes }
            } else if (file.name.endsWith('.dts')) {
              throw new Error(
                `Devicetree files apply to the Simulator. Switch to Simulator to use ${file.name}.`,
              )
            }
          }
          if (!elf) throw new Error(`${files[0].name} is not an ELF file (bad magic).`)
          setLiveImage(elf)
        } catch (err) {
          reportError(err)
        }
        return
      }
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
          // A devicetree alone only makes sense against a user image — a
          // bundled sample already carries its own truth.
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
    // mode is fixed for the document's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitElf, reportError],
  )

  const handleClearImage = useCallback(() => {
    void (async () => {
      // Drop the session copies before any hard reload, or they would come back.
      await clearGuestImage()
      await clearDeviceTree()
      if (backendRef.current?.resetRequiresReload) {
        location.reload()
        return
      }
      setNonce((n) => n + 1)
    })()
  }, [])

  const handleRestart = useCallback(() => {
    const backend = backendRef.current
    if (backend?.resetRequiresReload) {
      // Custom ELF/DTS stay in IndexedDB across this navigation (claim leaves
      // them in place); stock samples have nothing persisted to reclaim. User
      // Attach wiring and NVM survive the same way — this is an MCU reset.
      void backend.reset() // navigates; nothing after this runs
      return
    }
    void backend?.reset()
    setStatus({ status: 'idle' })
    // Bumping the key remounts XTerminal, which tears the old session down and
    // brings up a fresh xterm + pty pair for the new run.
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => registerCommand('restart', handleRestart), [handleRestart])

  return (
    <div className="flex h-full flex-col">
      <TopBar
        mode={mode}
        onModeChange={handleModeChange}
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
        {/*
          The stage is the terminal, whole. Panels — devices, and the machine's
          own instruments — live in the dock and pop out into windows from
          there; nothing is pinned over the console any more, so no band has to
          be measured out from under it. This wrapper is static and always
          present, so the dock opening or closing never reparents (and so never
          remounts) the terminal — only its box changes, which the FitAddon's
          ResizeObserver absorbs.
        */}
        <div className="relative min-w-0 flex-1 p-4">
          {mode === 'live' ? (
            /* No guest, no terminal: the stage is the bridge walkthrough. */
            <LiveBoardHome errorDetail={status === 'error' ? (detail ?? null) : null} />
          ) : (
            <>
              {/* Changing board or backend remounts the session, same as Restart. */}
              <XTerminal
                key={`${backendId}:${boardId}:${sampleId}:${nonce}`}
                onSession={handleSession}
                onTeardown={handleTeardown}
              />
              {/* A tour step may have stopped the machine, so its card sits above
                  the panels but below the z-50 modals. */}
              <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex justify-center md:inset-x-4 md:top-4">
                <TourCard board={getBoard(boardId)} sampleId={sampleId} />
              </div>
            </>
          )}
        </div>

        {/*
          The dock: every control surface, one scrollbar, two projections of
          the same rows (devicetree ⌗ / peripheral classes ▤). Known devices
          are listed from the first paint (inert until their bridge is live);
          the derivation in useDeviceTree owns that gating.
        */}
        <Dock boardId={boardId} />
        <FloatingWindows boardId={boardId} />
        <InstrumentWindows />
      </main>

      {/* Whole-window target, so the drop works wherever the pointer is. */}
      <DropOverlay onFiles={handleFilesDropped} />

      {/* Follow-up to a user ELF: optionally take its zephyr.dts before boot. */}
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

      <ShortcutsHelpDialog />
    </div>
  )
}
