/**
 * Tiny patient-monitor heart: a lub-dub SVG beat + scrolling ECG strip,
 * both locked to the BPM the peer advertises. Kept deliberately small for
 * the Bluetooth inspector — denser than a badge, quieter than a card.
 */

import { useEffect, useId, useRef } from 'react'
import { cn } from '@/lib/utils'

const ECG_W = 112
const ECG_H = 22
const HEART_SIZE = 14
/** Horizontal scroll speed in CSS px/s — a few complexes stay visible at rest. */
const PX_PER_SEC = 48

/** Clamp BPM into the GATT-ish range the slider already uses. */
function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 72
  return Math.max(40, Math.min(200, Math.round(bpm)))
}

/**
 * One cardiac cycle as an amplitude in [-1, 1] for phase ∈ [0, 1).
 * Shaped like a lead-II sketch: small P, sharp QRS, softer T, then rest.
 */
export function ecgSample(phase: number): number {
  const p = ((phase % 1) + 1) % 1
  // P wave
  if (p >= 0.04 && p < 0.12) {
    const t = (p - 0.04) / 0.08
    return 0.18 * Math.sin(Math.PI * t)
  }
  // Q dip
  if (p >= 0.16 && p < 0.18) {
    const t = (p - 0.16) / 0.02
    return -0.22 * t
  }
  // R spike
  if (p >= 0.18 && p < 0.205) {
    const t = (p - 0.18) / 0.025
    return -0.22 + 1.22 * t
  }
  if (p >= 0.205 && p < 0.23) {
    const t = (p - 0.205) / 0.025
    return 1 - 1.35 * t
  }
  // S recovery
  if (p >= 0.23 && p < 0.27) {
    const t = (p - 0.23) / 0.04
    return -0.35 * (1 - t)
  }
  // T wave
  if (p >= 0.34 && p < 0.52) {
    const t = (p - 0.34) / 0.18
    return 0.32 * Math.sin(Math.PI * t)
  }
  return 0
}

/**
 * Heart scale envelope for one RR interval: lub (strong) then dub (softer),
 * matching the QRS / early diastole feel rather than a single bounce.
 */
export function heartScale(phase: number): number {
  const p = ((phase % 1) + 1) % 1
  const lub = envelope(p, 0.18, 0.075, 1)
  const dub = envelope(p, 0.3, 0.055, 0.55)
  return 1 + 0.28 * Math.max(lub, dub * 0.85)
}

function envelope(phase: number, center: number, width: number, peak: number): number {
  const d = Math.abs(phase - center)
  if (d >= width) return 0
  const t = 1 - d / width
  return peak * t * t * (3 - 2 * t)
}

function phaseAt(seconds: number, bpm: number): number {
  const period = 60 / clampBpm(bpm)
  return ((seconds / period) % 1 + 1) % 1
}

export function HeartRatePulse({
  bpm,
  className,
  muted = false,
}: {
  bpm: number
  className?: string
  /** Dim when the peer is stopped / not advertising. */
  muted?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const heartRef = useRef<SVGSVGElement | null>(null)
  const bpmRef = useRef(clampBpm(bpm))
  bpmRef.current = clampBpm(bpm)
  const uid = useId().replace(/:/g, '')
  const fillId = `hrm-heart-fill-${uid}`
  const glowId = `hrm-heart-glow-${uid}`

  useEffect(() => {
    const canvas = canvasRef.current
    const heart = heartRef.current
    if (!canvas) return

    const reduce =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(ECG_W * dpr)
    canvas.height = Math.round(ECG_H * dpr)
    canvas.style.width = `${ECG_W}px`
    canvas.style.height = `${ECG_H}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const cols = ECG_W
    const samples = new Float32Array(cols)
    let write = 0
    let simTime = 0
    let pixelCarry = 0
    let last = performance.now()
    let raf = 0

    const paintStatic = () => {
      for (let x = 0; x < cols; x++) {
        const local = (x - cols * 0.35) / cols
        samples[x] = local >= 0 && local < 0.55 ? ecgSample(local / 0.55) : 0
      }
      drawTrace(ctx, samples, 0, muted)
      if (heart) heart.style.transform = 'scale(1)'
    }

    if (reduce) {
      paintStatic()
      return
    }

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      simTime += dt
      pixelCarry += dt * PX_PER_SEC
      const advance = Math.floor(pixelCarry)
      pixelCarry -= advance

      for (let i = 0; i < advance; i++) {
        // Backdate each column so multi-pixel steps stay phase-correct.
        const colTime = simTime - ((advance - 1 - i) / PX_PER_SEC)
        samples[write] = ecgSample(phaseAt(colTime, bpmRef.current))
        write = (write + 1) % cols
      }

      drawTrace(ctx, samples, write, muted)
      if (heart) {
        const s = heartScale(phaseAt(simTime, bpmRef.current))
        heart.style.transform = `scale(${s.toFixed(3)})`
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [muted])

  return (
    <div
      className={cn('flex items-center gap-1.5', muted && 'opacity-45', className)}
      aria-hidden
    >
      <svg
        ref={heartRef}
        width={HEART_SIZE}
        height={HEART_SIZE}
        viewBox="0 0 24 24"
        className="origin-center text-rose-500 will-change-transform"
        style={{ transformOrigin: '50% 55%' }}
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fb7185" />
            <stop offset="100%" stopColor="#e11d48" />
          </linearGradient>
          <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="1.1" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          filter={`url(#${glowId})`}
          fill={`url(#${fillId})`}
          d="M12 21s-6.7-4.35-9.33-7.6C.3 10.55.7 6.9 3.55 5.2 5.4 4.1 7.85 4.45 9.4 6.05L12 8.8l2.6-2.75c1.55-1.6 4-1.95 5.85-.85 2.85 1.7 3.25 5.35.88 8.2C18.7 16.65 12 21 12 21z"
        />
      </svg>
      <canvas
        ref={canvasRef}
        width={ECG_W}
        height={ECG_H}
        className="rounded-[3px] bg-black/35 ring-1 ring-emerald-500/15"
      />
    </div>
  )
}

function drawTrace(
  ctx: CanvasRenderingContext2D,
  samples: Float32Array,
  write: number,
  muted: boolean,
) {
  const w = ECG_W
  const h = ECG_H
  ctx.clearRect(0, 0, w, h)

  // Soft grid — one horizontal isoelectric + faint verticals.
  ctx.strokeStyle = 'rgba(52, 211, 153, 0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h * 0.58)
  ctx.lineTo(w, h * 0.58)
  for (let x = 14; x < w; x += 14) {
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, h)
  }
  ctx.stroke()

  const mid = h * 0.58
  const amp = h * 0.42
  ctx.beginPath()
  for (let i = 0; i < samples.length; i++) {
    const idx = (write + i) % samples.length
    const x = i
    const y = mid - samples[idx]! * amp
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = muted ? 'rgba(52, 211, 153, 0.35)' : 'rgba(52, 211, 153, 0.95)'
  ctx.lineWidth = 1.25
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()

  // Bright tip on the newest sample.
  const tipY = mid - samples[(write + samples.length - 1) % samples.length]! * amp
  ctx.fillStyle = muted ? 'rgba(167, 243, 208, 0.4)' : 'rgba(167, 243, 208, 0.95)'
  ctx.beginPath()
  ctx.arc(w - 1.5, tipY, 1.4, 0, Math.PI * 2)
  ctx.fill()
}
