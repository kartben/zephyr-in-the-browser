/**
 * Shared main-thread timer for the slow host bridges.
 *
 * Several bridges need a low-rate heartbeat on the page thread — GPIO MMIO
 * outputs, audio drain, display metadata, CTF follow, guest MIPS, GNSS NMEA,
 * QMP monitor drain. Each used to own a `setInterval`, so a fully attached
 * A53 board woke the event loop five or six times a second on staggered
 * timers even when every callback was a single shared-memory load.
 *
 * One 100 ms beat runs them all: each task keeps its own period, and the
 * beat skips any task whose period has not elapsed. Callers that need a
 * faster cadence (GPIO steppers at 1 ms, net at 10 ms hot) keep a private
 * timer — this module rejects periods below the shared beat.
 */

export const HOST_POLL_MS = 100

interface Task {
  periodMs: number
  tick: () => void
  /** ms until the next run; 0 means due on this beat. */
  dueIn: number
}

const tasks = new Map<string, Task>()
let timer: ReturnType<typeof setInterval> | undefined

function ensureTimer() {
  if (timer !== undefined || tasks.size === 0) return
  timer = setInterval(beat, HOST_POLL_MS)
}

function stopTimerIfIdle() {
  if (tasks.size > 0 || timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

function beat() {
  for (const task of tasks.values()) {
    if (task.dueIn > 0) {
      task.dueIn -= HOST_POLL_MS
      if (task.dueIn > 0) continue
    }
    task.dueIn = task.periodMs
    // Isolate so one bridge throwing cannot skip the rest of the beat.
    try {
      task.tick()
    } catch (error) {
      console.error(`[hostPoll] ${error instanceof Error ? error.message : error}`)
    }
  }
}

/**
 * Register (or replace) a named task. Returns an unregister function.
 * Re-registering the same id replaces the previous task without stacking.
 */
export function register(id: string, periodMs: number, tick: () => void): () => void {
  if (!(periodMs >= HOST_POLL_MS)) {
    throw new Error(
      `hostPoll: period ${periodMs}ms is below the ${HOST_POLL_MS}ms shared beat`,
    )
  }
  tasks.set(id, { periodMs, tick, dueIn: 0 })
  ensureTimer()
  return () => unregister(id)
}

export function unregister(id: string): void {
  if (!tasks.delete(id)) return
  stopTimerIfIdle()
}

/** Whether a named task is currently on the shared beat. */
export function isRegistered(id: string): boolean {
  return tasks.has(id)
}

/** Test helper: drop every task and stop the timer. */
export function resetForTests(): void {
  tasks.clear()
  stopTimerIfIdle()
}
