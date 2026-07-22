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
import { BOARDS, DEFAULT_BOARD_ID, getBoard } from '@/boards'

/**
 * The selection lives in the query string so it can survive the reload that a
 * committed QEMU session needs. Without this the board and backend dropdowns
 * become dead controls the moment the emulator is running.
 */
function readSelection() {
  const params = new URLSearchParams(location.search)
  const board = params.get('board')
  const backend = params.get('backend')
  return {
    boardId: BOARDS.some((b) => b.id === board) ? board! : DEFAULT_BOARD_ID,
    backendId: backend === 'mock' || backend === 'qemu' ? backend : defaultBackendId(),
  }
}

export default function App() {
  const [backendId, setBackendId] = useState<BackendId>(() => readSelection().backendId)
  const [boardId, setBoardId] = useState(() => readSelection().boardId)
  const [{ status, detail }, setStatus] = useState<StatusEvent>({ status: 'idle' })
  const [hardRestart, setHardRestart] = useState(false)
  const [nonce, setNonce] = useState(0)
  const customImage = useSyncExternalStore(subscribeGuestImage, getGuestImage, () => null)

  // Current selection, readable from the mount-once terminal callbacks without
  // making them change identity (which would remount the terminal).
  const configRef = useRef({ backendId, boardId })
  configRef.current = { backendId, boardId }

  const backendRef = useRef<PtyBackend | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const handleSession = useCallback(({ slave }: TerminalSession) => {
    const ac = new AbortController()
    abortRef.current = ac

    const backend = createBackend(configRef.current.backendId)
    backendRef.current = backend
    setHardRestart(false)
    setStatus({ status: 'loading' })

    // Drop status updates from a session that has already been torn down —
    // StrictMode's double mount in dev makes this a real ordering hazard.
    const onStatus = (event: StatusEvent) => {
      if (!ac.signal.aborted) setStatus(event)
    }

    backend
      .start(slave, { board: getBoard(configRef.current.boardId), onStatus, signal: ac.signal })
      .then(() => {
        if (!ac.signal.aborted) setHardRestart(backend.resetRequiresReload)
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        setHardRestart(backend.resetRequiresReload)
        setStatus({ status: 'error', detail: message })
        // The status pill truncates; the terminal is where the user is looking,
        // so put the full reason there too.
        slave.write(`\x1b[31m${backend.label}: ${message}\x1b[0m\n`)
      })
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
  const applySelection = useCallback((next: { boardId?: string; backendId?: BackendId }) => {
    if (backendRef.current?.resetRequiresReload) {
      const params = new URLSearchParams(location.search)
      params.set('board', next.boardId ?? configRef.current.boardId)
      params.set('backend', next.backendId ?? configRef.current.backendId)
      location.search = params.toString()
      return
    }
    if (next.boardId !== undefined) setBoardId(next.boardId)
    if (next.backendId !== undefined) setBackendId(next.backendId)
  }, [])

  const handleBoardChange = useCallback(
    (id: string) => applySelection({ boardId: id }),
    [applySelection],
  )
  const handleBackendChange = useCallback(
    (id: BackendId) => applySelection({ backendId: id }),
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
        backendId={backendId}
        onBackendChange={handleBackendChange}
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
          key={`${backendId}:${boardId}:${nonce}`}
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
