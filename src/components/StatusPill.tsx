import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { BackendStatus } from '@/backends'

const DOT: Record<BackendStatus, string> = {
  idle: 'bg-muted-foreground',
  loading: 'bg-warning animate-pulse',
  running: 'bg-success',
  exited: 'bg-muted-foreground',
  error: 'bg-destructive',
}

export function StatusPill({ status, detail }: { status: BackendStatus; detail?: string }) {
  const { t } = useTranslation()
  return (
    <span
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border px-2 py-1 text-xs sm:px-2.5"
      // Errors carry the real message; keep it reachable without a tooltip lib.
      title={detail}
    >
      <span className={cn('size-1.5 rounded-full', DOT[status])} />
      {/* On a phone the dot alone carries it; the label is in the aria name. */}
      <span className="sr-only sm:not-sr-only sm:font-medium">{t(`status.${status}`)}</span>
      {detail && (
        <span
          className="hidden max-w-[22ch] truncate text-muted-foreground lg:inline"
          aria-label={t('topBar.statusDetail')}
        >
          {detail}
        </span>
      )}
    </span>
  )
}
