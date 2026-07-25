/**
 * Dock body for a gpio-buzzer: Lucide Vibrate icon with CSS shake while the
 * guest drives the pin active, plus browser Vibration API (and a Web Audio
 * buzz fallback when vibrate is unavailable).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Vibrate } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getBuzzers,
  isBuzzerOn,
  subscribe,
  type BuzzerPin,
} from '@/hostGpio'

const VIBRATE_PREF_KEY = 'zephyr.buzzer.vibrateEnabled'

function readVibratePref(): boolean {
  try {
    return localStorage.getItem(VIBRATE_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function writeVibratePref(on: boolean) {
  try {
    localStorage.setItem(VIBRATE_PREF_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function vibrationSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
}

/** Short repeating buzz pattern while the GPIO line is active. */
const VIBRATE_PATTERN = [80, 40]

/**
 * Page-local square-wave buzz for desktops where navigator.vibrate is a no-op.
 * Not routed through the I2S host-audio bridge.
 */
function createBuzzAudio(): { start: () => void; stop: () => void; dispose: () => void } {
  let ctx: AudioContext | null = null
  let osc: OscillatorNode | null = null
  let gain: GainNode | null = null

  const ensure = () => {
    if (ctx) return ctx
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new AC()
    return ctx
  }

  return {
    start() {
      const audio = ensure()
      void audio.resume()
      if (osc) return
      gain = audio.createGain()
      gain.gain.value = 0.04
      gain.connect(audio.destination)
      osc = audio.createOscillator()
      osc.type = 'square'
      osc.frequency.value = 2400
      osc.connect(gain)
      osc.start()
    },
    stop() {
      try {
        osc?.stop()
      } catch {
        /* already stopped */
      }
      osc?.disconnect()
      gain?.disconnect()
      osc = null
      gain = null
    },
    dispose() {
      this.stop()
      void ctx?.close()
      ctx = null
    },
  }
}

export function BuzzerBody() {
  const buzzers = useSyncExternalStore(subscribe, getBuzzers, () => [])
  if (buzzers.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No <code className="font-mono text-foreground">gpio-buzzer</code> in this
        build&apos;s devicetree.
      </div>
    )
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {buzzers.map((buzzer) => (
        <BuzzerCard key={buzzer.id} buzzer={buzzer} />
      ))}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Stock Zephyr{' '}
        <code className="font-mono text-foreground">gpio-buzzer</code> — the guest
        toggles a GPIO line; frequency args are on/off only. Try{' '}
        <code className="font-mono text-foreground">samples/drivers/buzzer/tone</code>.
      </p>
    </div>
  )
}

function BuzzerCard({ buzzer }: { buzzer: BuzzerPin }) {
  const on = useSyncExternalStore(
    subscribe,
    useCallback(() => isBuzzerOn(buzzer), [buzzer]),
    () => false,
  )
  const [enabled, setEnabled] = useState(readVibratePref)
  const [canVibrate, setCanVibrate] = useState(false)
  const audioRef = useRef<ReturnType<typeof createBuzzAudio> | null>(null)
  const vibrateTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => {
    setCanVibrate(vibrationSupported())
  }, [])

  useEffect(() => {
    audioRef.current ??= createBuzzAudio()
    return () => {
      audioRef.current?.dispose()
      audioRef.current = null
      if (vibrateTimer.current !== undefined) clearInterval(vibrateTimer.current)
      navigator.vibrate?.(0)
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!enabled) {
      audio?.stop()
      if (vibrateTimer.current !== undefined) clearInterval(vibrateTimer.current)
      vibrateTimer.current = undefined
      navigator.vibrate?.(0)
      return
    }

    if (on) {
      audio?.start()
      if (canVibrate) {
        navigator.vibrate?.(VIBRATE_PATTERN)
        if (vibrateTimer.current === undefined) {
          vibrateTimer.current = setInterval(() => {
            navigator.vibrate?.(VIBRATE_PATTERN)
          }, 120)
        }
      }
    } else {
      audio?.stop()
      if (vibrateTimer.current !== undefined) clearInterval(vibrateTimer.current)
      vibrateTimer.current = undefined
      navigator.vibrate?.(0)
    }
  }, [on, enabled, canVibrate])

  const enable = () => {
    // User gesture: unlock vibration + AudioContext.
    setEnabled(true)
    writeVibratePref(true)
    setCanVibrate(vibrationSupported())
    if (vibrationSupported()) navigator.vibrate?.(VIBRATE_PATTERN)
    audioRef.current ??= createBuzzAudio()
    // Prime the context on the click even if the pin is currently idle.
    audioRef.current.start()
    audioRef.current.stop()
  }

  const disable = () => {
    setEnabled(false)
    writeVibratePref(false)
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'relative flex size-12 items-center justify-center rounded-md border border-border bg-background',
            on && 'border-amber-500/50 text-amber-400',
            !on && 'text-muted-foreground',
          )}
          aria-hidden
        >
          {on && (
            <span className="buzzer-pulse pointer-events-none absolute inset-0 rounded-md border border-amber-400/40" />
          )}
          <Vibrate
            className={cn('size-6', on && 'buzzer-shake')}
            strokeWidth={1.75}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{buzzer.label}</div>
          <div className="font-mono text-[10px] text-muted-foreground">
            pin {buzzer.id} · {buzzer.activeHigh ? 'active-high' : 'active-low'}
          </div>
          <div
            className={cn(
              'mt-0.5 text-[11px] font-medium',
              on ? 'text-amber-400' : 'text-muted-foreground',
            )}
          >
            {on ? 'Buzzing' : 'Idle'}
          </div>
        </div>
      </div>

      {!enabled ? (
        <button
          type="button"
          onClick={enable}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-[11px] text-foreground hover:bg-secondary"
        >
          Enable vibration / buzz sound
        </button>
      ) : (
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>
            {canVibrate
              ? 'Vibration + sound unlocked'
              : 'Sound unlocked (Vibration API unavailable here)'}
          </span>
          <button
            type="button"
            onClick={disable}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            Disable
          </button>
        </div>
      )}
    </div>
  )
}
