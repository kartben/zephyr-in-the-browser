/**
 * The annotation popup: what the running sample has to say for itself.
 *
 * Sits over the stage, above the device panels and below the modals. When the
 * annotation asked for it the machine is stopped underneath — the whole reason
 * the pause exists is that a lesson about `gpio_pin_toggle_dt()` is worthless
 * once the LED has already blinked forty times.
 */

import { useSyncExternalStore } from 'react'
import { GraduationCap, Pause, X } from 'lucide-react'
import { dismiss, getSnapshot, setEnabled, subscribe } from '@/annotations/store'
import { InlineMarkdown, Markdown } from '@/components/Markdown'
import { SourceSnippet } from '@/components/SourceSnippet'
import { WalkthroughOutline } from '@/components/WalkthroughOutline'
import { sampleSourceAsset, type Board } from '@/boards'
import { Button } from '@/components/ui/button'

interface Props {
  board: Board
  sampleId: string
}

export function AnnotationCard({ board, sampleId }: Props) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const view = state.current

  if (!view || !state.enabled) return null

  const { entry, step, total, paused, value } = view
  const file = state.catalog?.files[entry.file]
  const src = file
    ? `${import.meta.env.BASE_URL}qemu/${sampleSourceAsset(board, sampleId, file)}`
    : null
  const fireLines = entry.fireSites.filter((s) => s.file === entry.file).map((s) => s.line)

  return (
    <div className="pointer-events-auto w-full max-w-[34rem]">
      <div className="rounded-lg border border-primary/40 bg-card/95 shadow-xl backdrop-blur">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <GraduationCap className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {total > 0 ? `${step}/${total}` : step}
          </span>
          <WalkthroughOutline
            outline={state.outline}
            seen={state.seen}
            currentId={entry.id}
            catalog={state.catalog}
          />
          {paused && (
            <span
              className="ml-auto flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary"
              title="The emulated machine is stopped on this line"
            >
              <Pause className="size-2.5" aria-hidden />
              paused
            </span>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismiss}
            className={`${paused ? '' : 'ml-auto '}rounded p-0.5 text-muted-foreground hover:text-foreground`}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>

        <div className="max-h-[min(28rem,60vh)] space-y-2.5 overflow-y-auto px-3 py-2.5">
          <h2 className="text-sm font-semibold text-foreground">
            <InlineMarkdown text={entry.title} />
          </h2>
          <Markdown
            body={entry.body}
            className="space-y-2 text-[12.5px] leading-relaxed text-muted-foreground"
          />

          {value !== undefined && (
            <p className="font-mono text-[11px] text-foreground">
              <span className="text-muted-foreground">→ </span>
              {value}
            </p>
          )}

          {src && !state.drift && (
            <SourceSnippet src={src} line={entry.line} fireLines={fireLines} />
          )}
          {state.drift && (
            <p className="text-[11px] text-muted-foreground">
              The shipped annotations do not match this build, so the source
              excerpt is hidden — its line numbers would point at the wrong code.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Button size="sm" onClick={dismiss} className="h-7 px-3 text-xs">
            {paused ? 'Continue' : 'Got it'}
          </Button>
          {paused && (
            <span className="text-[11px] text-muted-foreground">resumes the machine</span>
          )}
          <button
            type="button"
            onClick={() => setEnabled(false)}
            className="ml-auto text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Skip the walkthrough
          </button>
        </div>
      </div>
    </div>
  )
}
