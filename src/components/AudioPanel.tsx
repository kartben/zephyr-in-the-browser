import { useSyncExternalStore } from 'react'
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  getSnapshot as getAudioSnapshot,
  subscribe as subscribeAudio,
  toggle as toggleAudio,
} from '@/hostAudio'
import {
  getSnapshot as getMicSnapshot,
  subscribe as subscribeMic,
  toggle as toggleMic,
} from '@/hostMic'

/** Speaker body for qemu,host-audio. Starts muted (browser autoplay policy). */
export function SpeakerBody() {
  const audio = useSyncExternalStore(subscribeAudio, getAudioSnapshot, getAudioSnapshot)

  return (
    <div className="space-y-3 px-3 py-3">
      <Channel
        label={
          audio.rate > 0
            ? `Speaker — ${(audio.rate / 1000).toFixed(0)} kHz ${
                audio.channels === 2 ? 'stereo' : 'mono'
              }`
            : 'Speaker'
        }
        enabled={audio.enabled}
        level={audio.level}
        enableLabel="Enable sound"
        disableLabel="Mute"
        enabledIcon={<VolumeX className="size-3.5" aria-hidden />}
        disabledIcon={<Volume2 className="size-3.5" aria-hidden />}
        onToggle={toggleAudio}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        In the guest:{' '}
        <code className="font-mono text-foreground">hostaudio beep 440 500</code>{' '}
        queues a tone,{' '}
        <code className="font-mono text-foreground">hostaudio melody</code> a short tune.
      </p>
    </div>
  )
}

/** Mic body for qemu,host-mic. Starts off (getUserMedia permission). */
export function MicBody() {
  const mic = useSyncExternalStore(subscribeMic, getMicSnapshot, getMicSnapshot)

  return (
    <div className="space-y-3 px-3 py-3">
      <Channel
        label={mic.rate > 0 ? `Microphone — ${(mic.rate / 1000).toFixed(0)} kHz mono` : 'Microphone'}
        enabled={mic.enabled}
        level={mic.level}
        enableLabel="Enable mic"
        disableLabel="Stop mic"
        enabledIcon={<MicOff className="size-3.5" aria-hidden />}
        disabledIcon={<Mic className="size-3.5" aria-hidden />}
        onToggle={toggleMic}
        error={mic.error}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        In the guest: <code className="font-mono text-foreground">dmic vu dmic0</code>{' '}
        meters the mic.
      </p>
    </div>
  )
}

function Channel({
  label,
  enabled,
  level,
  enableLabel,
  disableLabel,
  enabledIcon,
  disabledIcon,
  onToggle,
  error,
}: {
  label: string
  enabled: boolean
  level: number
  enableLabel: string
  disableLabel: string
  enabledIcon: React.ReactNode
  disabledIcon: React.ReactNode
  onToggle: () => void
  error?: string | null
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Button
          variant={enabled ? 'secondary' : 'default'}
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11px]"
          aria-pressed={enabled}
          onClick={onToggle}
        >
          {enabled ? enabledIcon : disabledIcon}
          {enabled ? disableLabel : enableLabel}
        </Button>
        <div
          role="meter"
          aria-label={`${label} level`}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={level}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-100"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
