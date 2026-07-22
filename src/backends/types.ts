import type { openpty } from 'xterm-pty'
import type { Board } from '@/boards'

/**
 * xterm-pty only exports `openpty`, `Termios`, `TermiosConfig` and `Flags` — the
 * `Slave`/`Master`/`Signal` types are internal. Derive them from the factory so
 * they stay correct across xterm-pty upgrades instead of being re-declared here.
 */
export type Pty = ReturnType<typeof openpty>
export type Slave = Pty['slave']
export type PtyMaster = Pty['master']

type ListenerArg<T> = T extends (listener: (arg: infer A) => void) => unknown ? A : never
/** "SIGINT" | "SIGQUIT" | "SIGTSTP" | "SIGWINCH" */
export type PtySignal = ListenerArg<Slave['onSignal']>

export type BackendId = 'mock' | 'qemu'

/**
 * `idle` covers "constructed but not started yet"; the other four are the
 * lifecycle states a running emulator moves through.
 */
export type BackendStatus = 'idle' | 'loading' | 'running' | 'exited' | 'error'

export interface StatusEvent {
  status: BackendStatus
  /** Short human-readable qualifier, shown beside the status pill. */
  detail?: string
}

export interface StartOptions {
  board: Board
  /** Which of the board's prebuilt images to boot. Ignored if the user supplied an ELF. */
  sampleId: string
  onStatus: (event: StatusEvent) => void
  /**
   * Aborted when the terminal unmounts or the session restarts. Backends must
   * check it after every await — React StrictMode mounts effects twice in dev,
   * and a double-started emulator is unrecoverable.
   */
  signal: AbortSignal
}

export interface PtyBackend {
  readonly id: BackendId
  readonly label: string
  /**
   * True when the backend cannot be recycled in-place and `reset()` navigates.
   * Emscripten modules are single-shot per document, so qemuBackend sets this.
   */
  readonly resetRequiresReload: boolean
  /** Boot the emulator and wire its stdio to `slave`. */
  start(slave: Slave, opts: StartOptions): Promise<void>
  /** Tear down the current run so `start()` can be called again. */
  reset(): Promise<void>
}
