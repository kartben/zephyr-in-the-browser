/**
 * Help dialog — opened with `?` (or Ctrl+/). Two tabs: keyboard shortcuts
 * (default) and the changelog generated from CHANGELOG.md.
 */

import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Command, Option } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CHANGELOG, type ChangelogRelease } from '@/changelog'
import {
  isHelpOpen,
  isMacPlatform,
  setHelpOpen,
  shortcutsForHelp,
  subscribeHelp,
  type KeyChord,
  type Shortcut,
  type ShortcutCategory,
} from '@/lib/shortcuts'
import { APP_VERSION } from '@/version'
import { cn } from '@/lib/utils'

const CHANGELOG_URL =
  'https://github.com/kartben/zephyr-in-the-browser/blob/main/CHANGELOG.md'

type HelpTab = 'shortcuts' | 'changelog'
type Group = { category: ShortcutCategory; items: Shortcut[] }

const TAG_CLASS: Record<string, string> = {
  Added: 'bg-success/15 text-success',
  Improved: 'bg-primary/15 text-primary',
  Fixed: 'bg-warning/15 text-warning',
  Changed: 'bg-secondary text-secondary-foreground',
}

/** Greedy pack into N columns by row weight so short sections do not stretch. */
function packColumns(groups: Group[], columns: number): Group[][] {
  const cols: Group[][] = Array.from({ length: columns }, () => [])
  const weights = Array.from({ length: columns }, () => 0)
  for (const group of groups) {
    let best = 0
    for (let i = 1; i < columns; i++) {
      if (weights[i]! < weights[best]!) best = i
    }
    cols[best]!.push(group)
    // Header counts as one unit alongside each shortcut row.
    weights[best]! += 1 + group.items.length
  }
  return cols
}

export function ShortcutsHelpDialog() {
  const open = useSyncExternalStore(subscribeHelp, isHelpOpen, () => false)
  const [tab, setTab] = useState<HelpTab>('shortcuts')

  // Always reopen on Shortcuts so ? remains the shortcut cheat sheet.
  useEffect(() => {
    if (open) setTab('shortcuts')
  }, [open])

  // General (? / Ctrl+/) lives in the header — listing it again leaves a
  // one-row category that wastes a column band.
  const groups = useMemo(
    () => shortcutsForHelp().filter((g) => g.category !== 'General'),
    [],
  )
  const columns = useMemo(() => packColumns(groups, 2), [groups])

  return (
    <Dialog open={open} onOpenChange={setHelpOpen}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 pb-0 pt-5">
          <DialogTitle>Help</DialogTitle>
          <DialogDescription className="sr-only">
            Keyboard shortcuts and what is new in Zephyr in the Browser.
          </DialogDescription>
          <div
            role="tablist"
            aria-label="Help sections"
            className="mt-3 flex gap-4 text-xs"
          >
            <TabButton
              id="help-tab-shortcuts"
              controls="help-panel-shortcuts"
              selected={tab === 'shortcuts'}
              onSelect={() => setTab('shortcuts')}
            >
              Shortcuts
            </TabButton>
            <TabButton
              id="help-tab-changelog"
              controls="help-panel-changelog"
              selected={tab === 'changelog'}
              onSelect={() => setTab('changelog')}
            >
              Changelog
            </TabButton>
          </div>
        </DialogHeader>

        {tab === 'shortcuts' ? (
          <div
            role="tabpanel"
            id="help-panel-shortcuts"
            aria-labelledby="help-tab-shortcuts"
            className="overflow-y-auto px-5 py-3"
          >
            <p className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <span>Press</span>
              <ChordKbd chord={{ key: '?' }} />
              <span>or</span>
              <ChordKbd chord={{ key: '/', ctrl: true }} />
              <span>anytime to open this list.</span>
            </p>
            <div className="grid items-start gap-x-8 gap-y-3 sm:grid-cols-2">
              {columns.map((column, i) => (
                <div key={i} className="flex min-w-0 flex-col gap-3">
                  {column.map((group) => (
                    <CategoryBlock key={group.category} group={group} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            role="tabpanel"
            id="help-panel-changelog"
            aria-labelledby="help-tab-changelog"
            className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          >
            <p className="mb-4 text-xs text-muted-foreground">
              Zephyr in the Browser{' '}
              <span className="font-mono text-foreground/80">v{APP_VERSION}</span>
            </p>
            <div className="space-y-5">
              {CHANGELOG.map((release) => (
                <ChangelogReleaseBlock key={release.version} release={release} />
              ))}
            </div>
          </div>
        )}

        {tab === 'changelog' && (
          <DialogFooter className="justify-between sm:justify-between">
            <a
              href={CHANGELOG_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Full changelog on GitHub
            </a>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TabButton({
  id,
  controls,
  selected,
  onSelect,
  children,
}: {
  id: string
  controls: string
  selected: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        '-mb-px border-b-2 pb-2.5 font-medium transition-colors',
        selected
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function ChangelogReleaseBlock({ release }: { release: ChangelogRelease }) {
  const unreleased = release.version === 'Unreleased'
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className={cn(
            'font-mono text-sm font-semibold',
            unreleased ? 'text-warning' : 'text-primary',
          )}
        >
          {unreleased ? 'Unreleased' : `v${release.version}`}
        </span>
        {release.date && (
          <span className="text-[11px] text-muted-foreground">{release.date}</span>
        )}
      </div>
      <ul className="space-y-1.5">
        {release.items.map((item, i) => (
          <li
            key={`${release.version}-${i}`}
            className="grid grid-cols-[4.5rem_1fr] items-baseline gap-x-2 text-xs leading-snug text-foreground/90"
          >
            {item.tag ? (
              <span
                className={cn(
                  'justify-self-start rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                  TAG_CLASS[item.tag] ?? 'bg-muted text-muted-foreground',
                )}
              >
                {item.tag}
              </span>
            ) : (
              <span />
            )}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function CategoryBlock({ group }: { group: Group }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {group.category}
      </h3>
      <ul className="space-y-1">
        {group.items.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0">
              <span className="font-medium text-foreground">{item.title}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {item.description}
              </span>
            </span>
            <ChordKbd chord={item.chord} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Chord badge — Lucide Command/Option on Mac, text modifiers elsewhere. */
function ChordKbd({ chord }: { chord: KeyChord }) {
  const mac = isMacPlatform()
  const parts: ReactNode[] = []

  if (chord.ctrl) {
    parts.push(
      mac ? (
        <Command key="ctrl" className="size-3" aria-label="Command" strokeWidth={2} />
      ) : (
        <span key="ctrl">Ctrl</span>
      ),
    )
  }
  if (chord.alt) {
    parts.push(
      mac ? (
        <Option key="alt" className="size-3" aria-label="Option" strokeWidth={2} />
      ) : (
        <span key="alt">Alt</span>
      ),
    )
  }
  if (chord.shift) {
    parts.push(
      mac ? (
        <ShiftIcon key="shift" className="size-3" />
      ) : (
        <span key="shift">Shift</span>
      ),
    )
  }
  parts.push(
    mac ? (
      <span
        key="key"
        className="inline-flex h-3 items-center text-[12px] leading-none"
      >
        {displayKey(chord.key)}
      </span>
    ) : (
      <span key="key">{displayKey(chord.key)}</span>
    ),
  )

  return (
    <kbd
      className={cn(
        'inline-flex shrink-0 items-center rounded border border-border bg-muted/50',
        'px-1.5 py-0.5 font-mono tabular-nums text-foreground/90',
        mac ? 'gap-0.5' : 'gap-0 text-[10px]',
      )}
    >
      {parts.map((part, i) => (
        <span key={i} className="inline-flex h-3 items-center">
          {i > 0 && !mac && <span className="px-0.5">+</span>}
          {part}
        </span>
      ))}
    </kbd>
  )
}

/** Shift glyph — same 24×24 box and stroke as Lucide Command/Option. */
function ShiftIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-label="Shift"
    >
      <path d="M12 4 4 13h5v7h6v-7h5L12 4z" />
    </svg>
  )
}

function displayKey(key: string): string {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}
