import { cn } from '@/lib/utils'
import type { BackendStatus } from '@/backends'

const LABELS: Record<BackendStatus, string> = {
  idle: 'Idle',
  loading: 'Loading',
  running: 'Running',
  exited: 'Exited',
  error: 'Error',
}

const DOT: Record<BackendStatus, string> = {
  idle: 'bg-muted-foreground',
  loading: 'bg-warning animate-pulse',
  running: 'bg-success',
  exited: 'bg-muted-foreground',
  error: 'bg-destructive',
}

export function StatusPill({ status, detail }: { status: BackendStatus; detail?: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs"
      // Errors carry the real message; keep it reachable without a tooltip lib.
      title={detail}
    >
      <span className={cn('size-1.5 rounded-full', DOT[status])} />
      <span className="font-medium">{LABELS[status]}</span>
      {detail && (
        <span
          className="hidden max-w-[22ch] truncate text-muted-foreground lg:inline"
          aria-label="status detail"
        >
          {detail}
        </span>
      )}
    </span>
  )
}
