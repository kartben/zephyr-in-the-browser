/**
 * The terminal, as something the page can type into.
 *
 * A tour card's Run button types a shell command for the learner, and the card
 * is nowhere near the xterm that App mounts. This is the seam between them: App
 * registers the live terminal when a session starts and clears it on teardown,
 * and anything that wants to type asks here.
 *
 * Typing goes through xterm's `input()`, which fires `onData` exactly as a
 * keypress does. The pty master forwards that to the guest, or to the mock
 * shell's line discipline, so a typed command is indistinguishable from one
 * typed by hand: the shell echoes it, its history keeps it, and Ctrl+C still
 * works.
 *
 * Module-level store plus subscribe, the same shape as dockStore.
 */

/**
 * The slice of xterm's `Terminal` this needs, spelt out so a test can hand in
 * a small fake. A real `Terminal` fits it as is.
 */
export interface TerminalSink {
  input(data: string, wasUserInput?: boolean): void
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      readonly cursorX: number
      readonly cursorY: number
      getLine(y: number):
        | { translateToString(trimRight?: boolean, start?: number, end?: number): string }
        | undefined
    }
  }
  onWriteParsed(listener: () => void): { dispose(): void }
}

/**
 * Pause between lines.
 *
 * The Zephyr shell reads input through a small receive buffer (64 bytes in the
 * packaged images) and runs each command to completion before it reads on, so
 * a burst of lines can outrun it while a long command is still printing. A
 * fast typist's gap between Enters leaves it time to drain.
 */
const LINE_GAP_MS = 150

/** What a Zephyr shell prompt ends with: `uart:~$ `. */
const PROMPT = /\$ $/

let terminal: TerminalSink | null = null
const listeners = new Set<() => void>()

/** The terminal a session just mounted, or null when it is torn down. */
export function registerTerminal(term: TerminalSink | null): void {
  if (terminal === term) return
  terminal = term
  for (const fn of listeners) fn()
}

/** True when there is a terminal to type into. */
export function canType(): boolean {
  return terminal !== null
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function atPrompt(term: TerminalSink): boolean {
  const buffer = term.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  return PROMPT.test(line?.translateToString(false, 0, buffer.cursorX) ?? '')
}

/**
 * Resolves true once the cursor sits right after a shell prompt, or false
 * after `timeoutMs` (or with no terminal).
 *
 * Zephyr's shell throws away whatever arrived before it started: `shell_start()`
 * flushes its receive buffer, then prints the prompt. So a command typed the
 * moment a guest paused early in boot is resumed is lost, and the prompt is
 * the first sign that the shell is listening. A shell that is already idle at
 * its prompt answers at once.
 */
export function waitForPrompt(timeoutMs: number): Promise<boolean> {
  const term = terminal
  if (!term) return Promise.resolve(false)
  if (atPrompt(term)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer)
      parsed.dispose()
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const parsed = term.onWriteParsed(() => {
      if (atPrompt(term)) finish(true)
    })
  })
}

/**
 * Type each line followed by Enter, in order, `gapMs` apart.
 *
 * Resolves false when there is no terminal, or when the one it started on was
 * replaced partway through (a restart remounts it), so a half-typed snippet
 * never carries on into the next session.
 */
export async function typeLines(lines: readonly string[], gapMs = LINE_GAP_MS): Promise<boolean> {
  const term = terminal
  if (!term) return false
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
    if (terminal !== term) return false
    // `true` marks it as the learner's own input, which scrolls the terminal
    // back to the prompt if they had scrolled up, so the command is in view.
    term.input(`${lines[i]}\r`, true)
  }
  return true
}
