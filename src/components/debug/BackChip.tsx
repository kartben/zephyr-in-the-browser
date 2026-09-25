import { useSyncExternalStore } from 'react'
import { ArrowLeft } from 'lucide-react'
import * as debugUi from '@/lib/debugUi'

const SECTION_NAMES: Partial<Record<debugUi.DebugSection, string>> = {
  threads: 'Threads',
  objects: 'Objects',
  memory: 'Mem',
}

/**
 * "← shell_uart in Threads": the way back after a link carried you to another
 * inspect tab. Shown only on the tab the jump landed on, and gone once you
 * switch tabs yourself.
 */
export function BackChip({ section }: { section: debugUi.DebugSection }) {
  const focus = useSyncExternalStore(debugUi.subscribe, debugUi.getSnapshot, debugUi.getSnapshot)
  const from = focus.from
  if (!from || focus.section !== section) return null
  const where = SECTION_NAMES[from.section] ?? from.section
  const said = from.label === where ? where : `${from.label} in ${where}`
  return (
    <button
      type="button"
      className="flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-foreground/75 hover:bg-muted hover:text-foreground"
      title={`Back to ${said}`}
      onClick={() => debugUi.returnTo(from)}
    >
      <ArrowLeft className="size-3 shrink-0" aria-hidden />
      <span className="truncate">
        {from.label === where ? (
          where
        ) : (
          <>
            {from.label} <span className="text-muted-foreground">in {where}</span>
          </>
        )}
      </span>
    </button>
  )
}
