/**
 * The Mem pane's dump and its inspector strip.
 *
 * The strip sits above the dump at a fixed height and says what the hovered
 * (or pinned) word is. It replaces a tooltip on purpose: in a dock a few
 * hundred pixels wide, a card big enough to explain a pointer covers half the
 * rows you are reading, and a strip never does. It never changes height, so
 * the dump under it never moves; with nothing inspected it holds the legend.
 *
 * Hover previews after a moment and then tracks the pointer instantly, so
 * sweeping across the grid does not strobe. A click pins a word so its actions
 * can be reached; Esc lets go.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Pin, X } from 'lucide-react'
import { HexView } from '@/components/HexView'
import { TONE_CLASSES, type HexSection, type NoteTone } from '@/components/hexNotes'
import {
  badgeFor,
  explainPointer,
  storedAs,
  targetName,
  type MemoryNote,
  type PointerInfo,
} from '@/components/debug/memoryNotes'
import type { ResolvedAddress } from '@/debug/addressMap'
import { formatStackSize } from '@/debug/kernel/threads'
import type { DebugMemoryChip } from '@/debug/debugMemoryChip'
import { isMacPlatform } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

/** Hover this long before the strip first follows the pointer. */
const PREVIEW_MS = 250
/** Grace after leaving a word, so crossing a gap between two does not blink. */
const RELEASE_MS = 400

const LEGEND: ReadonlyArray<[NoteTone, string]> = [
  ['object', 'kernel object'],
  ['data', 'variable'],
  ['code', 'function'],
  ['plain', 'stack'],
  ['quiet', 'kernel bookkeeping'],
]

export function MemoryDump({
  chip,
  notes,
  sections,
  noteColumn,
  here,
  ptrBytes,
  arch,
  onOpenObject,
  onOpenThread,
}: {
  chip: DebugMemoryChip
  notes: readonly MemoryNote[]
  sections?: readonly HexSection[]
  /** An image is loaded, so keep a notes column whatever this window holds. */
  noteColumn: boolean
  /** What the window's first byte sits in. */
  here: ResolvedAddress | null
  ptrBytes: 4 | 8
  /** gdb's name for the CPU, for the pointer-width line. */
  arch: string | null
  onOpenObject?: (addr: number) => void
  onOpenThread?: (addr: number) => void
}) {
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const showing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    showing.current = previewId !== null
  }, [previewId])
  useEffect(() => () => clearTimeout(timer.current), [])

  const onNoteHover = useCallback((id: string | null) => {
    clearTimeout(timer.current)
    if (id !== null && showing.current) {
      setPreviewId(id)
      return
    }
    timer.current = setTimeout(() => setPreviewId(id), id === null ? RELEASE_MS : PREVIEW_MS)
  }, [])

  // A pin that scrolled out of the window has nothing left to say.
  useEffect(() => {
    if (pinnedId && !notes.some((note) => note.id === pinnedId)) setPinnedId(null)
  }, [notes, pinnedId])

  const shownId = previewId ?? pinnedId
  const shown = shownId ? (notes.find((note) => note.id === shownId) ?? null) : null

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && pinnedId) {
      e.stopPropagation()
      setPinnedId(null)
    }
  }

  return (
    <div className="space-y-1.5" onKeyDown={onKeyDown}>
      <div
        className={cn(
          'h-[6.75rem] overflow-hidden rounded-md border px-2 py-1.5 text-[10px] leading-[15px]',
          pinnedId && shown?.id === pinnedId
            ? 'border-foreground/35 bg-muted/40'
            : 'border-border/70 bg-muted/20',
        )}
        aria-live="polite"
      >
        {shown ? (
          <NoteDetails
            note={shown}
            pinned={shown.id === pinnedId}
            onUnpin={() => setPinnedId(null)}
            onOpenObject={onOpenObject}
            onOpenThread={onOpenThread}
          />
        ) : (
          <Legend here={here} ptrBytes={ptrBytes} arch={arch} />
        )}
      </div>
      <HexView
        chip={chip}
        addressBase={chip.baseAddr}
        dimErased={false}
        notes={notes}
        sections={sections}
        noteColumn={noteColumn}
        activeNote={shownId}
        selectedNote={pinnedId}
        onNoteHover={onNoteHover}
        onNoteSelect={(id) => {
          clearTimeout(timer.current)
          setPinnedId(id)
          setPreviewId(null)
        }}
      />
    </div>
  )
}

function Badge({ tone, children }: { tone: NoteTone; children: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm px-1 font-mono text-[9px]',
        TONE_CLASSES[tone].badge,
        TONE_CLASSES[tone].text,
      )}
    >
      {children}
    </span>
  )
}

/** What the strip holds while nothing is inspected: where you are, and the key. */
function Legend({
  here,
  ptrBytes,
  arch,
}: {
  here: ResolvedAddress | null
  ptrBytes: 4 | 8
  arch: string | null
}) {
  const follow = isMacPlatform() ? '⌘-click' : 'Ctrl-click'
  const name = here ? targetName({ target: here }) : null
  return (
    <div className="flex h-full flex-col justify-between">
      <p className="flex min-w-0 items-center gap-1.5 font-mono">
        <span className="shrink-0 font-sans text-muted-foreground">Window starts in</span>
        {here && name ? (
          <>
            <Badge tone={here.kind === 'object' ? 'object' : 'data'}>{badgeFor(here)}</Badge>
            <span className="flex min-w-0 text-foreground">
              <span className="min-w-0 truncate">{name.head}</span>
              {name.tail && <span className="shrink-0">{name.tail}</span>}
            </span>
            {here.size != null && (
              <span className="shrink-0 text-muted-foreground">{formatStackSize(here.size)}</span>
            )}
          </>
        ) : (
          <span className="font-sans text-muted-foreground/70">nothing the image names</span>
        )}
      </p>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted-foreground">
        {LEGEND.map(([tone, word]) => (
          <span key={tone} className="flex items-center gap-1">
            <span
              aria-hidden
              className={cn(
                'inline-block h-0 w-2.5 border-b',
                TONE_CLASSES[tone].underline,
              )}
            />
            {word}
          </span>
        ))}
      </p>
      <p className="text-muted-foreground">
        {ptrBytes}-byte little-endian pointers{arch ? ` (${arch})` : ''}.
      </p>
      <p className="truncate text-muted-foreground/80">
        Hover a marked word for details, click it to pin. Click a name or {follow} the bytes to
        follow; double-click a byte to edit.
      </p>
    </div>
  )
}

function NoteDetails({
  note,
  pinned,
  onUnpin,
  onOpenObject,
  onOpenThread,
}: {
  note: MemoryNote
  pinned: boolean
  onUnpin: () => void
  onOpenObject?: (addr: number) => void
  onOpenThread?: (addr: number) => void
}) {
  const info = note.info
  return (
    <div className="flex h-full flex-col justify-between">
      <PointerDetails info={info} tone={note.tone} />
      <div className="flex items-center gap-1.5">
        {note.onFollow && (
          <StripButton onClick={note.onFollow} title="Show the memory it points at">
            Follow
          </StripButton>
        )}
        <OpenButton info={info} onOpenObject={onOpenObject} onOpenThread={onOpenThread} />
        <StripButton
          onClick={() => void navigator.clipboard?.writeText(`0x${info.value.toString(16)}`)}
          title="Copy the value"
        >
          Copy 0x{info.value.toString(16)}
        </StripButton>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          {pinned ? (
            <>
              <Pin className="size-3" aria-hidden />
              pinned
              <button
                type="button"
                className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                aria-label="Unpin (Esc)"
                title="Unpin (Esc)"
                onClick={onUnpin}
              >
                <X className="size-3" aria-hidden />
              </button>
            </>
          ) : (
            'click to pin'
          )}
        </span>
      </div>
    </div>
  )
}

function PointerDetails({ info, tone }: { info: PointerInfo; tone: NoteTone }) {
  const name = targetName(info)
  const code = info.target.typeCode?.replace(/_+$/, '')
  const fields = info.target.fields ?? []
  return (
    <>
      <p className="flex min-w-0 items-center gap-1.5 font-mono">
        <span className="shrink-0 text-muted-foreground">
          0x{info.addr.toString(16)}
          {info.self ? '' : ' →'}
        </span>
        {!info.self && (
          <>
            <Badge tone={tone}>{badgeFor(info.target)}</Badge>
            <span className={cn('flex min-w-0', TONE_CLASSES[tone].text)}>
              <span className="min-w-0 truncate">{name.head}</span>
              {name.tail && <span className="shrink-0">{name.tail}</span>}
            </span>
          </>
        )}
        {code && (
          <span className="ml-auto shrink-0 text-muted-foreground/70" title="Object-core type ID">
            {code}
          </span>
        )}
      </p>
      <p className="truncate font-mono text-muted-foreground">
        {storedAs(info.bytes)} = 0x{info.value.toString(16)}
      </p>
      <p className="line-clamp-2 text-foreground/80">{explainPointer(info)}</p>
      {fields.length > 0 && (
        <p className="truncate font-mono text-muted-foreground">
          {fields.map((field) => `${field.label} ${field.value}`).join(' · ')}
        </p>
      )}
    </>
  )
}

/** Kernel objects have a better view than their bytes: offer it. */
function OpenButton({
  info,
  onOpenObject,
  onOpenThread,
}: {
  info: PointerInfo
  onOpenObject?: (addr: number) => void
  onOpenThread?: (addr: number) => void
}) {
  const target = info.target
  if (info.self) return null
  if (target.typeCode === 'THRD' && target.kind === 'object' && onOpenThread) {
    return (
      <StripButton onClick={() => onOpenThread(target.base)} title="Show this thread in Threads">
        Open in Threads
      </StripButton>
    )
  }
  const objectAddr =
    target.kind === 'object' ? target.base : target.kind === 'objectCore' ? target.objectAddr : undefined
  if (objectAddr === undefined || !onOpenObject) return null
  return (
    <StripButton onClick={() => onOpenObject(objectAddr)} title="Show this object in Objects">
      Open in Objects
    </StripButton>
  )
}

function StripButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="h-5 shrink-0 rounded border border-border bg-background px-1.5 text-[10px] text-foreground/85 hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}
