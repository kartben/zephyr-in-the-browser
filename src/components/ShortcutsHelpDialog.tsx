/**
 * Keyboard shortcuts help — opened with `?` (or Ctrl+/). Grouped by category;
 * titles and descriptions stay short so the whole map fits one glance.
 */

import { useSyncExternalStore } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  formatChord,
  isHelpOpen,
  setHelpOpen,
  shortcutsForHelp,
  subscribeHelp,
} from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

export function ShortcutsHelpDialog() {
  const open = useSyncExternalStore(subscribeHelp, isHelpOpen, () => false)
  const groups = shortcutsForHelp()

  return (
    <Dialog open={open} onOpenChange={setHelpOpen}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 pb-3 pt-5">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? anytime to open this list.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-5 sm:grid-cols-2">
            {groups.map(({ category, items }) => (
              <section key={category} className="min-w-0">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {category}
                </h3>
                <ul className="space-y-1.5">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-baseline justify-between gap-3 text-xs"
                    >
                      <span className="min-w-0">
                        <span className="font-medium text-foreground">{item.title}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                      <kbd
                        className={cn(
                          'shrink-0 rounded border border-border bg-muted/50 px-1.5 py-0.5',
                          'font-mono text-[10px] tabular-nums text-foreground/90',
                        )}
                      >
                        {formatChord(item.chord)}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
