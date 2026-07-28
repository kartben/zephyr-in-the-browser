import { useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CheckControl,
  ControlRow,
  SelectControl,
  SliderControl,
} from '@/components/controls/ControlRow'
import {
  BODY_SENSOR_LOCATIONS,
  BT_PEER_TYPES,
  addPeer,
  available,
  getSnapshot,
  removePeer,
  selectPeer,
  setPeerParam,
  startController,
  subscribe,
  type BtPeerSnapshot,
  type BtSnapshot,
} from '@/hostBt'
import {
  disable as disableSpeakerAudio,
  enable as enableSpeakerAudio,
  getSnapshot as getSpeakerAudioSnapshot,
  subscribe as subscribeSpeakerAudio,
} from '@/bt/speakerAudio'

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

/** Dock / window body for the in-page Bumble HCI controller + LocalLink peers. */
export function BluetoothBody() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const live = useSyncExternalStore(subscribe, available, () => false)
  return <BluetoothView snap={snap} live={live} />
}

/**
 * Panel over plain data — same split as {@link ./CanPanel} so roster copy can
 * be asserted without the store. Select-one inspector: docs/bluetooth-peer-ui-spec.md.
 */
export function BluetoothView({ snap, live }: { snap: BtSnapshot; live: boolean }) {
  const selected = snap.peers.find((p) => p.id === snap.selectedPeerId && !p.local) ?? null

  return (
    <div className="space-y-3 px-3 py-2.5 text-[12px]">
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

          {snap.phase === 'ready' && (
            <>
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-muted-foreground">On the air</span>
                <ul className="space-y-1">
                  {snap.peers.length === 0 && (
                    <li className="text-[11px] text-muted-foreground">Nothing on the LocalLink yet.</li>
                  )}
                  {snap.peers.map((peer) => (
                    <PeerRow
                      key={peer.id}
                      peer={peer}
                      selected={snap.selectedPeerId === peer.id}
                    />
                  ))}
                </ul>
              </div>

              {selected && <PeerInspector peer={selected} />}

              <AddPeerRow />
              <p className="text-[11px] text-muted-foreground">
                Select a peer to configure it. Peers share this tab&apos;s LocalLink —
                external Hive remains optional.
              </p>
            </>
          )}
        </>
      )}
    </div>
  )
}

function PeerRow({ peer, selected }: { peer: BtPeerSnapshot; selected: boolean }) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1.5',
        peer.local && 'border-border bg-muted/50',
        !peer.local && !selected && 'border-border/60 bg-muted/30',
        selected && 'border-primary/50 bg-primary/5',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        title={peer.local ? "This board's HCI controller" : `Configure ${peer.name}`}
        aria-pressed={selected}
        onClick={() => selectPeer(peer.local ? 'local' : peer.id)}
      >
        <span className={cn('truncate text-[11px]', peer.local && 'font-mono')}>{peer.name}</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">{peer.detail}</span>
      </button>
      {!peer.local && (
        <button
          type="button"
          aria-label={`Remove ${peer.name}`}
          title="Remove from the LocalLink"
          onClick={(e) => {
            e.stopPropagation()
            void removePeer(peer.id)
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
        >
          <X className="size-3" />
        </button>
      )}
    </li>
  )
}

function PeerInspector({ peer }: { peer: BtPeerSnapshot }) {
  const params = peer.params ?? {}

  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/20 px-2 py-2">
      <div className="flex items-center gap-2">
        <span className="truncate text-[11px] font-medium">{peer.name}</span>
        <button
          type="button"
          aria-label={`Remove ${peer.name}`}
          title="Remove from the LocalLink"
          onClick={() => void removePeer(peer.id)}
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
        >
          <X className="size-3" />
        </button>
      </div>

      {peer.typeId === 'hrm' && (
        <>
          <SliderControl
            label="Heart rate"
            unit="BPM"
            min={40}
            max={200}
            step={1}
            value={Number(params.bpm ?? 72)}
            format={(v) => String(Math.round(v))}
            onChange={(v) => void setPeerParam(peer.id, 'bpm', v)}
          />
          <SelectControl
            label="Body location"
            value={Number(params.bodyLocation ?? 1)}
            options={BODY_SENSOR_LOCATIONS}
            onChange={(v) => void setPeerParam(peer.id, 'bodyLocation', v)}
          />
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <CheckControl
              label="Advertising"
              checked={Boolean(params.advertising)}
              onChange={(v) => void setPeerParam(peer.id, 'advertising', v)}
            />
          </div>
        </>
      )}

      {peer.typeId === 'advertiser' && (
        <>
          <ControlRow label="Local name">
            <input
              aria-label="Local name"
              value={String(params.localName ?? peer.name)}
              onChange={(e) => void setPeerParam(peer.id, 'localName', e.target.value.slice(0, 24))}
              className="col-span-2 rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none"
            />
          </ControlRow>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <CheckControl
              label="Advertising"
              checked={Boolean(params.advertising)}
              onChange={(v) => void setPeerParam(peer.id, 'advertising', v)}
            />
            <CheckControl
              label="Connectable"
              checked={Boolean(params.connectable)}
              onChange={(v) => void setPeerParam(peer.id, 'connectable', v)}
            />
          </div>
        </>
      )}

      {peer.typeId === 'scanner' && (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
            <dt className="text-muted-foreground">Adv reports</dt>
            <dd>{Number(params.advCount ?? 0)}</dd>
          </dl>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <CheckControl
              label="Scanning"
              checked={Boolean(params.scanning)}
              onChange={(v) => void setPeerParam(peer.id, 'scanning', v)}
            />
            <CheckControl
              label="Active scan"
              checked={Boolean(params.active)}
              onChange={(v) => void setPeerParam(peer.id, 'active', v)}
            />
          </div>
          <div className="space-y-1 pt-1">
            <span className="text-[10px] font-medium text-muted-foreground">Recent</span>
            <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
              <li className="truncate">F0:11:22:33:44:55 · Zephyr Peripheral · −47 dBm</li>
              <li className="truncate">F0:AA:BB:CC:DD:EE · Heart rate 1 · −55 dBm</li>
              <li className="truncate">F0:12:34:56:78:9A · (no name) · −61 dBm</li>
            </ul>
          </div>
        </>
      )}

      {peer.typeId === 'speaker' && (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
            <dt className="text-muted-foreground">Stream</dt>
            <dd className="capitalize">{String(params.streamState ?? 'idle')}</dd>
            <dt className="text-muted-foreground">Codec</dt>
            <dd>{String(params.codec ?? 'sbc').toUpperCase()}</dd>
            <dt className="text-muted-foreground">RTP</dt>
            <dd>
              {Number(params.packets ?? 0)} pkts · {formatBytes(Number(params.bytes ?? 0))}
            </dd>
          </dl>
          <SpeakerAudioControls peerId={peer.id} muted={Boolean(params.muted)} />
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <CheckControl
              label="Muted"
              checked={Boolean(params.muted)}
              onChange={(v) => void setPeerParam(peer.id, 'muted', v)}
            />
            <CheckControl
              label="Discoverable"
              checked={Boolean(params.discoverable)}
              onChange={(v) => void setPeerParam(peer.id, 'discoverable', v)}
            />
            <CheckControl
              label="Connectable"
              checked={Boolean(params.connectable)}
              onChange={(v) => void setPeerParam(peer.id, 'connectable', v)}
            />
          </div>
          <p className="pt-1 text-[10px] text-muted-foreground">
            Classic A2DP sink (SBC → PCM via vendored libsbc). Needs a BR/EDR source on
            this LocalLink — BLE peripheral samples will not stream here. Click Enable
            sound once so the browser allows Web Audio.
          </p>
        </>
      )}
    </div>
  )
}

function SpeakerAudioControls({ peerId, muted }: { peerId: string; muted: boolean }) {
  const audio = useSyncExternalStore(
    subscribeSpeakerAudio,
    getSpeakerAudioSnapshot,
    getSpeakerAudioSnapshot,
  )
  void peerId
  void muted

  return (
    <div className="flex flex-wrap items-center gap-1.5 py-0.5">
      <button
        type="button"
        className="rounded-md border border-input bg-secondary px-2 py-1 text-[11px] text-foreground hover:bg-background"
        onClick={() => {
          if (audio.enabled) disableSpeakerAudio()
          else void enableSpeakerAudio()
        }}
      >
        {audio.enabled ? 'Disable sound' : 'Enable sound'}
      </button>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {audio.enabled ? `lvl ${(audio.level * 100).toFixed(0)}% · ${audio.framesDecoded} frm` : 'silent'}
      </span>
      {audio.lastError && (
        <span className="text-[10px] text-destructive">{audio.lastError}</span>
      )}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
}

function AddPeerRow() {
  const [typeId, setTypeId] = useState(BT_PEER_TYPES[0]!.id)
  const [busy, setBusy] = useState(false)

  const onAdd = async () => {
    setBusy(true)
    try {
      await addPeer(typeId)
    } catch (err) {
      console.error('[bt] add peer failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">Add peer</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={typeId}
          aria-label="Peer type"
          onChange={(e) => setTypeId(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground outline-none"
        >
          {BT_PEER_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onAdd()}
          className="rounded-md border border-input bg-secondary px-2 py-1 text-[11px] text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  )
}
