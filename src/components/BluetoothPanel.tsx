import { useSyncExternalStore } from 'react'
import { available, getSnapshot, startController, subscribe, type BtSnapshot } from '@/hostBt'

function phaseLabel(phase: BtSnapshot['phase']): string {
  switch (phase) {
    case 'idle':
      return 'Idle'
    case 'loading':
      return 'Loading Bumble…'
    case 'ready':
      return 'Controller ready'
    case 'error':
      return 'Error'
  }
}

/** Dock / window body for the in-page Bumble HCI controller. */
export function BluetoothBody() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const live = useSyncExternalStore(subscribe, available, () => false)

  return (
    <div className="space-y-2 px-3 py-2.5 text-[12px]">
      {!live && (
        <p className="text-muted-foreground">
          No <code className="font-mono text-[11px]">hci0</code> chardev — rebuild qemu-wasm with
          the HCI patches, or pick a Bluetooth sample once the emulator lists{' '}
          <code className="font-mono text-[11px]">hci</code> in{' '}
          <code className="font-mono text-[11px]">features.json</code>.
        </p>
      )}

      {live && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{phaseLabel(snap.phase)}</span>
            {snap.controllerName && (
              <span className="font-mono text-[11px] text-muted-foreground">{snap.controllerName}</span>
            )}
          </div>
          {snap.detail && <p className="text-muted-foreground">{snap.detail}</p>}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
            <dt className="text-muted-foreground">Host → controller</dt>
            <dd>{snap.rxPackets} pkts</dd>
            <dt className="text-muted-foreground">Controller → host</dt>
            <dd>{snap.txPackets} pkts</dd>
          </dl>
          {snap.phase === 'error' && (
            <button
              type="button"
              className="rounded border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
              onClick={() => void startController()}
            >
              Retry controller
            </button>
          )}
          {snap.phase === 'idle' && (
            <button
              type="button"
              className="rounded border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
              onClick={() => void startController()}
            >
              Start Bumble controller
            </button>
          )}
          <p className="text-[11px] text-muted-foreground">
            Hive peers (Scanner, HRM, Speaker) can join once a WebSocket HCI
            endpoint is exposed — see the Bluetooth feasibility note.
          </p>
        </>
      )}
    </div>
  )
}
