/**
 * A shell command a tour step hands the learner, with Run and Copy.
 *
 * Run types each command line into the terminal followed by Enter, the same
 * keystrokes the learner would type. On a paused card the guest is halted and
 * its shell cannot answer, so typing first would look broken: there the button
 * reads Continue and run, resumes the guest, and types once the debugger says
 * it is running and the shell is listening.
 *
 * Placeholders (`${thread:NAME}`, `${addr:SYMBOL}`) are filled in as the card
 * renders, from the debugger's thread walk and the image's symbols. One that
 * will not resolve leaves Run disabled and says why, rather than typing a
 * command the shell would reject.
 *
 * Takes plain lines, so a fenced ```shell block and a list of commands from
 * a step's directives render the same way.
 */

import { Fragment, useState, useSyncExternalStore } from 'react'
import { Check, Copy, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import * as debug from '@/debug/control'
import * as terminal from '@/lib/terminalInput'
import { isCommandLine, resolvePlaceholders, type SnippetContext } from '@/tours/snippets'
import { next } from '@/tours/store'
import { cn } from '@/lib/utils'

/** How long Continue and run waits for the guest to report it is running. */
const RESUME_TIMEOUT_MS = 2000

/** How long it then waits for the shell to show its prompt. */
const PROMPT_TIMEOUT_MS = 3000

interface Props {
  /** The snippet as written, one entry per line. */
  lines: readonly string[]
  /** The card is paused on the guest, so Run has to resume it first. */
  paused?: boolean
}

/** Resolves true once the debugger reports the guest running, false on timeout. */
function untilRunning(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = () => {}
    let done = false
    const finish = (running: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      resolve(running)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const check = () => {
      if (!debug.getSnapshot().paused) finish(true)
    }
    unsubscribe = debug.subscribe(check)
    check()
  })
}

/**
 * Leave the paused card the way Continue does, then type.
 *
 * `next()` takes the card down at once, and the resume it starts lands a beat
 * later (the next step's breakpoint is planted first). So this outlives the
 * component that called it, which is why it is not component state.
 *
 * Running is not quite enough. A card paused early in boot (in `main()`, say)
 * has a shell that has not started yet, and it throws away anything typed
 * before it does, so this also waits for the prompt. Neither wait is fatal:
 * past either timeout the command is typed anyway.
 */
export async function continueAndRun(
  commands: readonly string[],
  { resumeMs = RESUME_TIMEOUT_MS, promptMs = PROMPT_TIMEOUT_MS } = {},
): Promise<boolean> {
  next()
  if (!(await untilRunning(resumeMs))) {
    console.warn('[tour] the guest did not report running in time; typing the snippet anyway')
  }
  await terminal.waitForPrompt(promptMs)
  return terminal.typeLines(commands)
}

export function ShellSnippet({ lines, paused = false }: Props) {
  const { t } = useTranslation()
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const ready = useSyncExternalStore(terminal.subscribe, terminal.canType, terminal.canType)
  const [typing, setTyping] = useState(false)
  const [copied, setCopied] = useState(false)

  const context: SnippetContext = {
    threads: snap.threads,
    symbols: debug.elfAddressSources().symbols?.objects ?? null,
  }
  const resolved = lines.map((line) => resolvePlaceholders(line, context))
  const commands = resolved.flatMap((line, i) =>
    line.text !== null && isCommandLine(lines[i]!) ? [line.text.trim()] : [],
  )
  const problem =
    resolved.flatMap((line) => line.errors)[0] ??
    (commands.length === 0
      ? t('tour.shell.nothing')
      : !ready
        ? t('tour.shell.noTerminal')
        : null)
  const shown = resolved.map((line) => line.pieces.map((piece) => piece.text).join('')).join('\n')

  const run = () => {
    if (paused) {
      void continueAndRun(commands)
      return
    }
    setTyping(true)
    void terminal.typeLines(commands).finally(() => setTyping(false))
  }

  const copy = () => {
    navigator.clipboard
      ?.writeText(shown)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        /* the text is still selectable */
      })
  }

  return (
    <div className="overflow-hidden rounded border border-border bg-muted/60">
      <pre
        className="overflow-x-auto p-2 font-mono text-[11px] leading-relaxed text-foreground"
        data-language="shell"
      >
        <code>
          {resolved.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && '\n'}
              {line.pieces.map((piece, j) =>
                piece.placeholder === null ? (
                  piece.text
                ) : (
                  <span
                    key={j}
                    title={piece.error ?? piece.placeholder}
                    className={cn(
                      'rounded-sm',
                      piece.error
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'underline decoration-muted-foreground/60 decoration-dotted underline-offset-2',
                    )}
                  >
                    {piece.text}
                  </span>
                ),
              )}
            </Fragment>
          ))}
        </code>
      </pre>
      <div className="flex items-center gap-1 border-t border-border/60 px-1.5 py-1">
        {/* A disabled button takes no pointer events, so the reason sits on its wrapper. */}
        <span className="inline-flex" title={problem ?? undefined}>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 border-primary/50 px-2 text-[11px] text-primary-text hover:bg-primary/10 [&_svg]:size-3"
            disabled={problem !== null || typing}
            title={
              problem !== null
                ? undefined
                : paused
                  ? t('tour.shell.continueRunTitle')
                  : t('tour.shell.runTitle')
            }
            onClick={run}
          >
            <Play aria-hidden />
            {paused ? t('tour.shell.continueRun') : t('tour.shell.run')}
          </Button>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px] text-muted-foreground [&_svg]:size-3"
          onClick={copy}
        >
          {copied ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
          {copied ? t('tour.shell.copied') : t('tour.shell.copy')}
        </Button>
        {problem !== null && (
          <span className="min-w-0 truncate text-[11px] text-amber-700 dark:text-amber-400">
            {problem}
          </span>
        )}
      </div>
    </div>
  )
}
