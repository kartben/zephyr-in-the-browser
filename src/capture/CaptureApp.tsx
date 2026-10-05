/**
 * The Magic Wand capture page: guided takes of each gesture, recorded from the
 * phone's motion sensor and exported as a training file.
 *
 * A round asks for five of each gesture in random order, then free movement and
 * stillness; or the reader picks one motion and records it as many times as
 * they like. Each gesture take records a three second countdown (the phone held
 * still) and three seconds after the cue, which is more than the model's 5.12 s
 * window needs around a one to two second gesture. Nothing leaves the phone
 * until the reader exports it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { orientationNeedsPermission, requestOrientationPermission } from '@/virtio/devices/sensors/liveSource'
import { MotionCapture } from './recorder'
import {
  COUNTDOWN_MS,
  HOLDS,
  clearSession,
  countTakes,
  isGesture,
  loadSession,
  newSession,
  planRound,
  saveSession,
  takeSpec,
  serializeSession,
  sessionFileName,
  type CaptureSession,
  type DeviceInfo,
  type Hold,
  type Take,
  type TakeLabel,
  type TakeSpec,
} from './session'

const TITLES: Record<TakeLabel, string> = {
  wing: 'Wing',
  ring: 'Ring',
  slope: 'Slope',
  negative: 'Anything but a gesture',
  idle: 'Hold still',
}

const SHORT_TITLES: Record<TakeLabel, string> = {
  wing: 'Wing',
  ring: 'Ring',
  slope: 'Slope',
  negative: 'Free movement',
  idle: 'Still',
}

const HOW: Record<TakeLabel, string> = {
  wing: 'Draw a big W in the air, starting at the top left: down, up, down, up.',
  ring: 'Draw a big clockwise circle, starting at the top.',
  slope: 'From the top right, go diagonally down to the bottom left, then straight right.',
  negative:
    'Move however you like: walk, turn around, pick the phone up and put it down, wave it about. Just do not draw a W, a circle or an angle.',
  idle: 'Keep the phone still, in any position.',
}

const HOLD_CHOICES: Record<Hold, { title: string; detail: string }> = {
  recommended: { title: 'Flat', detail: 'Screen up, charging port on your left' },
  natural: { title: 'Your way', detail: 'However you would naturally hold it' },
}

type Phase =
  | { kind: 'intro' }
  | { kind: 'setup' }
  | { kind: 'prompt'; index: number }
  | { kind: 'countdown'; index: number; left: number }
  | { kind: 'recording'; index: number; endsAt: number }
  | { kind: 'review'; index: number; take: Take }
  | { kind: 'round-done' }

function deviceInfo(): DeviceInfo {
  return {
    userAgent: navigator.userAgent,
    platform: null,
    model: null,
    mobile: null,
    screen: [screen.width, screen.height],
    pixelRatio: devicePixelRatio,
  }
}

/** Chromium names the phone model through User-Agent Client Hints. */
async function withClientHints(info: DeviceInfo): Promise<DeviceInfo> {
  type UAData = {
    getHighEntropyValues?: (hints: string[]) => Promise<{ platform?: string; model?: string; mobile?: boolean }>
  }
  const uaData = (navigator as Navigator & { userAgentData?: UAData }).userAgentData
  try {
    const hints = await uaData?.getHighEntropyValues?.(['platform', 'model', 'mobile'])
    if (!hints) return info
    return { ...info, platform: hints.platform ?? null, model: hints.model || null, mobile: hints.mobile ?? null }
  } catch {
    return info
  }
}

function useCues() {
  const audio = useRef<AudioContext | null>(null)
  const unlock = useCallback(() => {
    try {
      audio.current ??= new AudioContext()
      void audio.current.resume()
    } catch {
      audio.current = null
    }
  }, [])
  const beep = useCallback((hz: number, ms: number) => {
    const ctx = audio.current
    if (ctx) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = hz
      gain.gain.value = 0.12
      osc.connect(gain).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + ms / 1000)
    }
    navigator.vibrate?.(ms)
  }, [])
  return { unlock, beep }
}

/** Keep the screen on during a session; phones dim it mid-round otherwise. */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    type Lock = { release(): Promise<void> }
    const wake = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Lock> } }).wakeLock
    let lock: Lock | null = null
    const acquire = () => {
      if (document.visibilityState !== 'visible') return
      wake
        ?.request('screen')
        .then((l) => {
          lock = l
        })
        .catch(() => {})
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release().catch(() => {})
    }
  }, [active])
}

export function CaptureApp() {
  const captureRef = useRef<MotionCapture | null>(null)
  captureRef.current ??= new MotionCapture()
  const capture = captureRef.current
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' })
  const [session, setSession] = useState<CaptureSession | null>(() => loadSession())
  const [plan, setPlan] = useState<TakeSpec[]>(() => planRound())
  // One motion, taken again and again until the reader is done, instead of a round.
  const [single, setSingle] = useState<TakeLabel | null>(null)
  const [hold, setHold] = useState<Hold>('recommended')
  const [motionError, setMotionError] = useState<string | null>(null)
  const [saved, setSaved] = useState(true)
  const { unlock, beep } = useCues()
  useWakeLock(phase.kind !== 'intro')

  useEffect(() => () => capture.stop(), [capture])

  const commit = (next: CaptureSession) => {
    setSession(next)
    setSaved(saveSession(next))
  }

  const begin = async (fresh: boolean) => {
    unlock()
    if (orientationNeedsPermission() && (await requestOrientationPermission()) !== 'granted') {
      setMotionError('Motion access was denied. Allow it in Settings > Safari > Motion & Orientation Access, then reload.')
      return
    }
    capture.start()
    if (fresh || !session) {
      const created = newSession(deviceInfo())
      commit(created)
      void withClientHints(created.device).then((device) => {
        setSession((current) => {
          if (!current || current.id !== created.id) return current
          const next = { ...current, device }
          setSaved(saveSession(next))
          return next
        })
      })
    }
    setPhase({ kind: 'setup' })
  }

  const startTake = (index: number) => {
    const spec = plan[index]!
    unlock()
    capture.beginTake(spec.label, hold)
    if (isGesture(spec.label)) {
      setPhase({ kind: 'countdown', index, left: COUNTDOWN_MS / 1000 })
    } else {
      beep(660, 150)
      setPhase({ kind: 'recording', index, endsAt: performance.now() + spec.durationMs })
    }
  }

  // The countdown: a tick each second, then the cue and the gesture window.
  useEffect(() => {
    if (phase.kind !== 'countdown') return
    beep(440, 80)
    const timer = setTimeout(() => {
      if (phase.left > 1) {
        setPhase({ ...phase, left: phase.left - 1 })
        return
      }
      capture.markCue()
      beep(880, 250)
      setPhase({ kind: 'recording', index: phase.index, endsAt: performance.now() + plan[phase.index]!.durationMs })
    }, 1000)
    return () => clearTimeout(timer)
  }, [phase, beep, capture, plan])

  // The end of a recording.
  useEffect(() => {
    if (phase.kind !== 'recording') return
    const timer = setTimeout(() => {
      beep(330, 150)
      const take = capture.endTake()
      if (take) setPhase({ kind: 'review', index: phase.index, take })
    }, Math.max(0, phase.endsAt - performance.now()))
    return () => clearTimeout(timer)
  }, [phase, beep, capture])

  const keep = (index: number, take: Take) => {
    if (!session) return
    commit({
      ...session,
      normalization: capture.normalization,
      motionIntervalMs: capture.intervalMs(),
      takes: [...session.takes, take],
    })
    if (single) setPhase({ kind: 'prompt', index: 0 })
    else setPhase(index + 1 < plan.length ? { kind: 'prompt', index: index + 1 } : { kind: 'round-done' })
  }

  const counts = session ? countTakes(session) : null
  const total = session?.takes.length ?? 0
  const progress = (index: number) =>
    single ? `take ${(counts?.[single] ?? 0) + 1}` : `${index + 1} / ${plan.length}`

  const beginRound = () => {
    setSingle(null)
    setPlan(planRound())
    setPhase({ kind: 'prompt', index: 0 })
  }
  const beginSingle = (label: TakeLabel) => {
    setSingle(label)
    setPlan([takeSpec(label)])
    setPhase({ kind: 'prompt', index: 0 })
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-5">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-base font-semibold">Train the Magic Wand</h1>
        {session && total > 0 && phase.kind !== 'intro' && <ExportButtons session={session} compact />}
      </header>

      {phase.kind === 'intro' && (
        <Intro
          resumable={session && session.takes.length > 0 ? session.takes.length : 0}
          onStart={(fresh) => void begin(fresh)}
          error={motionError}
        />
      )}

      {phase.kind === 'setup' && (
        <Setup
          capture={capture}
          hold={hold}
          onHold={setHold}
          handedness={session?.contributor.handedness ?? null}
          onHandedness={(handedness) => session && commit({ ...session, contributor: { handedness } })}
          onRound={beginRound}
          onSingle={beginSingle}
        />
      )}

      {phase.kind === 'prompt' && (
        <Prompt
          spec={plan[phase.index]!}
          progress={progress(phase.index)}
          hold={hold}
          onGo={() => startTake(phase.index)}
          onDone={single ? () => setPhase({ kind: 'setup' }) : undefined}
        />
      )}

      {phase.kind === 'countdown' && (
        <Card>
          <TakeHeader spec={plan[phase.index]!} progress={progress(phase.index)} />
          <p className="text-muted-foreground text-sm">Hold still</p>
          <div className="text-primary py-6 text-center text-7xl font-bold tabular-nums">{phase.left}</div>
        </Card>
      )}

      {phase.kind === 'recording' && (
        <Recording spec={plan[phase.index]!} progress={progress(phase.index)} endsAt={phase.endsAt} />
      )}

      {phase.kind === 'review' && (
        <Card>
          <TakeHeader spec={plan[phase.index]!} progress={progress(phase.index)} />
          <TakePlot take={phase.take} />
          <p className="text-muted-foreground text-xs">
            {phase.take.samples.length < 20
              ? 'Almost no readings arrived. Is the screen still on?'
              : 'Keep it if you did the move as asked; redo it if you fumbled.'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 flex-1" onClick={() => setPhase({ kind: 'prompt', index: phase.index })}>
              Redo
            </Button>
            <Button
              className="h-11 flex-1"
              disabled={phase.take.samples.length < 20}
              onClick={() => keep(phase.index, phase.take)}
            >
              Keep
            </Button>
          </div>
        </Card>
      )}

      {phase.kind === 'round-done' && session && counts && (
        <Card>
          <h2 className="text-sm font-semibold">Round done, thank you!</h2>
          <Counts counts={counts} />
          <p className="text-muted-foreground text-xs">
            Another round helps, especially in the other hold. When you are done, export the file and send it to whoever
            asked you to record.
          </p>
          <div className="flex flex-col gap-2">
            <Button className="h-11" onClick={() => setPhase({ kind: 'setup' })}>
              Another round, or one motion
            </Button>
            <ExportButtons session={session} />
          </div>
        </Card>
      )}

      {session && total > 0 && phase.kind !== 'intro' && phase.kind !== 'round-done' && counts && (
        <footer className="text-muted-foreground mt-auto text-xs">
          <Counts counts={counts} />
          {!saved && <p className="text-warning mt-1">This browser cannot keep a backup: export before you leave.</p>}
        </footer>
      )}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">{children}</section>
}

function Intro({
  resumable,
  onStart,
  error,
}: {
  resumable: number
  onStart: (fresh: boolean) => void
  error: string | null
}) {
  return (
    <Card>
      <p className="text-sm">
        The Magic Wand sample in Zephyr in the Browser recognizes gestures with a tiny TensorFlow Lite Micro model. It
        was trained on seven people waving a circuit board, so it struggles with phones. Recording your gestures helps
        it work for everyone.
      </p>
      <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
        <li>
          A round takes about three minutes: five of each gesture, then some free movement. Or record any one motion as
          many times as you like.
        </li>
        <li>
          The page records your phone&apos;s motion sensor readings, your phone model and browser, and nothing else.
        </li>
        <li>Recordings stay on this phone until you export them.</li>
      </ul>
      {error && <p className="text-destructive text-sm">{error}</p>}
      {resumable > 0 && (
        <Button className="h-11" onClick={() => onStart(false)}>
          Continue ({resumable} takes so far)
        </Button>
      )}
      <Button className="h-11" variant={resumable > 0 ? 'outline' : 'default'} onClick={() => onStart(true)}>
        {resumable > 0 ? 'Start a new session' : 'Start'}
      </Button>
    </Card>
  )
}

function useMotion(capture: MotionCapture) {
  return useSyncExternalStore(
    useCallback((fn) => capture.subscribe(fn), [capture]),
    () => capture.latest,
  )
}

function Setup({
  capture,
  hold,
  onHold,
  handedness,
  onHandedness,
  onRound,
  onSingle,
}: {
  capture: MotionCapture
  hold: Hold
  onHold: (hold: Hold) => void
  handedness: 'right' | 'left' | null
  onHandedness: (handedness: 'right' | 'left') => void
  onRound: () => void
  onSingle: (label: TakeLabel) => void
}) {
  const latest = useMotion(capture)
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 3000)
    return () => clearTimeout(timer)
  }, [])
  const interval = capture.intervalMs()
  const screenUp = latest !== null && latest[2] > 7.5

  return (
    <Card>
      <h2 className="text-sm font-semibold">How to hold the phone</h2>
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(HOLDS) as Hold[]).map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => onHold(h)}
            className={`rounded-md border p-2 text-left text-xs ${hold === h ? 'border-primary text-foreground' : 'border-border text-muted-foreground'}`}
          >
            <span className="block font-medium">{HOLD_CHOICES[h].title}</span>
            {HOLD_CHOICES[h].detail}
          </button>
        ))}
      </div>
      {hold === 'recommended' && <HoldPicture />}
      <p className="text-muted-foreground text-xs">
        Move the whole phone with your arm, like a wand, and keep it in that hold while you draw.
      </p>

      <div className="text-xs">
        <span className="font-medium">Motion sensor: </span>
        {latest ? (
          <span>
            {interval ? `${Math.round(1000 / interval)} readings per second` : 'reading'}
            {hold === 'recommended' && (screenUp ? ', screen up' : ', tilt the screen up')}
          </span>
        ) : waited ? (
          <span className="text-destructive">no readings. This browser may not share motion data.</span>
        ) : (
          <span className="text-muted-foreground">waiting for readings...</span>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">You hold it in your</span>
        {(['right', 'left'] as const).map((hand) => (
          <button
            key={hand}
            type="button"
            onClick={() => onHandedness(hand)}
            className={`rounded-md border px-2 py-1 ${handedness === hand ? 'border-primary text-foreground' : 'border-border text-muted-foreground'}`}
          >
            {hand} hand
          </button>
        ))}
      </div>

      <Button className="h-11" disabled={!capture.ready} onClick={onRound}>
        {capture.ready ? 'Begin a round' : 'Waiting for the sensor...'}
      </Button>
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">Or record one motion as many times as you like:</span>
        <div className="grid grid-cols-3 gap-1.5">
          {(['wing', 'ring', 'slope', 'negative', 'idle'] as const).map((label) => (
            <Button
              key={label}
              variant="outline"
              className="h-10"
              disabled={!capture.ready}
              onClick={() => onSingle(label)}
            >
              {SHORT_TITLES[label]}
            </Button>
          ))}
        </div>
      </div>
    </Card>
  )
}

/** A phone seen from above: screen up, charging port on the left. */
function HoldPicture() {
  return (
    <svg viewBox="0 0 200 90" className="text-muted-foreground h-20 w-full" aria-label="Phone held flat, charging port on the left">
      <rect x="30" y="15" width="140" height="60" rx="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="44" y="22" width="112" height="46" rx="4" fill="currentColor" opacity="0.15" />
      <rect x="31" y="38" width="5" height="14" rx="2" fill="currentColor" />
      <text x="8" y="49" fontSize="9" fill="currentColor">port</text>
      <text x="74" y="49" fontSize="10" fill="currentColor">screen up</text>
    </svg>
  )
}

function TakeHeader({ spec, progress }: { spec: TakeSpec; progress: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-lg font-semibold">{TITLES[spec.label]}</h2>
      <span className="text-muted-foreground text-xs tabular-nums">{progress}</span>
    </div>
  )
}

function Prompt({
  spec,
  progress,
  hold,
  onGo,
  onDone,
}: {
  spec: TakeSpec
  progress: string
  hold: Hold
  onGo: () => void
  /** One-motion mode: back to the choice of motions. */
  onDone?: () => void
}) {
  const gesture = isGesture(spec.label)
  return (
    <Card>
      <TakeHeader spec={spec} progress={progress} />
      {gesture && <GestureIcon label={spec.label} />}
      <p className="text-sm">{HOW[spec.label]}</p>
      <p className="text-muted-foreground text-xs">
        {gesture
          ? `After the countdown you have three seconds. Hold: ${HOLDS[hold].toLowerCase()}.`
          : `This one lasts ${Math.round(spec.durationMs / 1000)} seconds.`}
      </p>
      <Button className="h-14 text-base" onClick={onGo}>
        {gesture ? 'Ready' : 'Start'}
      </Button>
      {onDone && (
        <Button variant="outline" className="h-11" onClick={onDone}>
          Done with {TITLES[spec.label].toLowerCase()}
        </Button>
      )}
    </Card>
  )
}

function Recording({ spec, progress, endsAt }: { spec: TakeSpec; progress: string; endsAt: number }) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 100)
    return () => clearInterval(timer)
  }, [])
  const left = Math.max(0, endsAt - now)
  const gesture = isGesture(spec.label)
  return (
    <Card>
      <TakeHeader spec={spec} progress={progress} />
      <div className="text-primary py-4 text-center text-5xl font-bold">{gesture ? 'Go!' : `${Math.ceil(left / 1000)} s`}</div>
      {gesture && <GestureIcon label={spec.label} />}
      <div className="bg-muted h-2 overflow-hidden rounded">
        <div className="bg-primary h-full" style={{ width: `${(100 * left) / spec.durationMs}%` }} />
      </div>
    </Card>
  )
}

/** The three gestures as a path with a start dot and arrowheads. */
function GestureIcon({ label }: { label: TakeLabel }) {
  const paths: Partial<Record<TakeLabel, string>> = {
    wing: 'M 15 25 L 40 95 L 60 45 L 80 95 L 105 25',
    ring: 'M 60 20 A 40 40 0 1 1 36.5 27.6',
    slope: 'M 100 20 L 20 100 L 105 100',
  }
  const start: Partial<Record<TakeLabel, [number, number]>> = { wing: [15, 25], ring: [60, 20], slope: [100, 20] }
  const d = paths[label]
  const s = start[label]
  if (!d || !s) return null
  return (
    <svg viewBox="0 0 120 120" className="text-primary mx-auto h-36 w-36" aria-hidden>
      <defs>
        <marker id={`arrow-${label}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
        strokeLinecap="round"
        markerEnd={`url(#arrow-${label})`}
      />
      <circle cx={s[0]} cy={s[1]} r="6" fill="currentColor" />
    </svg>
  )
}

/** The take's three axes over time, with the cue marked. */
function TakePlot({ take }: { take: Take }) {
  const w = 300
  const h = 120
  const last = take.samples[take.samples.length - 1]?.[0] ?? 1
  const x = (t: number) => (t / Math.max(1, last)) * w
  const y = (v: number) => h / 2 - (Math.max(-20, Math.min(20, v)) / 20) * (h / 2 - 4)
  const line = (axis: 1 | 2 | 3) => take.samples.map((row) => `${x(row[0]).toFixed(1)},${y(row[axis]).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="bg-muted/40 w-full rounded" aria-label="The recorded motion">
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} stroke="currentColor" opacity="0.2" />
      {take.cueMs !== null && <line x1={x(take.cueMs)} x2={x(take.cueMs)} y1="0" y2={h} stroke="currentColor" opacity="0.4" strokeDasharray="3 3" />}
      <polyline points={line(1)} fill="none" stroke="#e5484d" strokeWidth="1.5" />
      <polyline points={line(2)} fill="none" stroke="#30a46c" strokeWidth="1.5" />
      <polyline points={line(3)} fill="none" stroke="#3e63dd" strokeWidth="1.5" />
    </svg>
  )
}

function Counts({ counts }: { counts: Record<TakeLabel, number> }) {
  return (
    <p className="tabular-nums">
      Wing {counts.wing} · Ring {counts.ring} · Slope {counts.slope} · Free {counts.negative} · Still {counts.idle}
    </p>
  )
}

function ExportButtons({ session, compact = false }: { session: CaptureSession; compact?: boolean }) {
  const [status, setStatus] = useState<string | null>(null)
  const file = () => new File([serializeSession(session)], sessionFileName(session), { type: 'application/json' })
  // Whether this browser can share a JSON file at all; the real one is built on click.
  const [canShare] = useState(
    () =>
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File(['{}'], 'probe.json', { type: 'application/json' })] }),
  )

  const download = () => {
    const url = URL.createObjectURL(file())
    const a = document.createElement('a')
    a.href = url
    a.download = sessionFileName(session)
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    setStatus('Saved to your downloads.')
  }
  const share = async () => {
    try {
      await navigator.share({ files: [file()], title: 'Magic Wand gestures' })
      setStatus('Shared.')
    } catch (err) {
      if ((err as Error).name !== 'AbortError') download()
    }
  }

  if (compact) {
    return (
      <Button size="sm" variant="outline" onClick={() => void (canShare ? share() : download())}>
        Export
      </Button>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {canShare && (
        <Button className="h-11" variant="secondary" onClick={() => void share()}>
          Share the file
        </Button>
      )}
      <Button className="h-11" variant="outline" onClick={download}>
        Download the file
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          if (confirm('Delete every take in this session? Export first if you want to keep them.')) {
            clearSession()
            location.reload()
          }
        }}
      >
        Delete this session
      </Button>
      {status && <p className="text-muted-foreground text-xs">{status}</p>}
    </div>
  )
}
