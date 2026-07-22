import { useCallback, useRef, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { XTerminal, type TerminalSession } from '@/components/XTerminal'
import { createBackend, defaultBackendId } from '@/backends'
import type { BackendId, PtyBackend, StatusEvent } from '@/backends'
import { DEFAULT_BOARD_ID, getBoard } from '@/boards'

export default function App() {
  const [backendId, setBackendId] = useState<BackendId>(defaultBackendId)
  const [boardId, setBoardId] = useState(DEFAULT_BOARD_ID)
  const [{ status, detail }, setStatus] = useState<StatusEvent>({ status: 'idle' })
  const [hardRestart, setHardRestart] = useState(false)
  const [nonce, setNonce] = useState(0)

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
        onBoardChange={setBoardId}
        backendId={backendId}
        onBackendChange={setBackendId}
        status={status}
        detail={detail}
        hardRestart={hardRestart}
        onRestart={handleRestart}
      />

      <main className="min-h-0 flex-1 bg-terminal p-4">
        {/* Changing board or backend remounts the session, same as Restart. */}
        <XTerminal
          key={`${backendId}:${boardId}:${nonce}`}
          onSession={handleSession}
          onTeardown={handleTeardown}
        />
      </main>
    </div>
  )
}
