import type { openpty } from 'xterm-pty'
import type { Board } from '@/boards'

/**
 * xterm-pty keeps `Slave`/`Master` internal; derive them from `openpty` so upgrades
 * do not leave local re-declarations stale.
 */
export type Pty = ReturnType<typeof openpty>
export type Slave = Pty['slave']
export type PtyMaster = Pty['master']

type ListenerArg<T> = T extends (listener: (arg: infer A) => void) => unknown ? A : never
export type PtySignal = ListenerArg<Slave['onSignal']>

export type BackendId = 'mock' | 'qemu'

export type BackendStatus = 'idle' | 'loading' | 'running' | 'exited' | 'error'

export interface StatusEvent {
  status: BackendStatus
  detail?: string
}

export interface StartOptions {
  board: Board
  sampleId: string
  onStatus: (event: StatusEvent) => void
  /** Check after every await; React StrictMode double-starts would wedge QEMU. */
  signal: AbortSignal
}

export interface PtyBackend {
  readonly id: BackendId
  readonly label: string
  /** True when `reset()` must navigate because the backend is document-global. */
  readonly resetRequiresReload: boolean
  start(slave: Slave, opts: StartOptions): Promise<void>
  reset(): Promise<void>
}
