import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { TopBar } from '@/components/TopBar'
import { XTerminal, type TerminalSession } from '@/components/XTerminal'
import { SensorPanel } from '@/components/SensorPanel'
import { DropOverlay } from '@/components/DropOverlay'
import {
  clear as clearGuestImage,
  get as getGuestImage,
  readFile as readGuestImage,
  set as setGuestImage,
  stash as stashGuestImage,
  subscribe as subscribeGuestImage,
} from '@/guestImage'
import { createBackend, defaultBackendId } from '@/backends'
import type { BackendId, PtyBackend, StatusEvent } from '@/backends'
import { BOARDS, DEFAULT_BOARD_ID, getBoard, getSample } from '@/boards'

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
    (id: string) => applySelection({ boardId: id }),
    [applySelection],
  )

  /** Choosing a built-in app also drops any user-supplied ELF. */
  const handleSampleChange = useCallback(
    (id: string) => {
      clearGuestImage()
      applySelection({ sampleId: id })
    },
    [applySelection],
  )
  /**
   * Boot a user-supplied ELF. If QEMU has already committed this document the
   * bytes have to survive a reload, so they go through the IndexedDB handoff;
   * otherwise the session can just be remounted around them.
   */
  const handleLoadElf = useCallback(async (file: File) => {
    try {
      const image = await readGuestImage(file)
      if (backendRef.current?.resetRequiresReload) {
        await stashGuestImage(image)
        location.reload()
        return
      }
      setGuestImage(image)
      setNonce((n) => n + 1)
    } catch (err) {
      setStatus({
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  const handleClearImage = useCallback(() => {
    clearGuestImage()
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
    // Bumping the key remounts XTerminal, which tears the old session down and
    // brings up a fresh xterm + pty pair for the new run.
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

      <main className="relative min-h-0 flex-1 bg-terminal p-4">
        {/* Changing board or backend remounts the session, same as Restart. */}
        <XTerminal
          key={`${backendId}:${boardId}:${sampleId}:${nonce}`}
          onSession={handleSession}
          onTeardown={handleTeardown}
        />
        {/* Renders nothing unless the running emulator has the sensor device. */}
        <SensorPanel />
      </main>

      {/* Whole-window target, so the drop works wherever the pointer is. */}
      <DropOverlay onFile={handleLoadElf} />
    </div>
  )
}
