import { memo, useEffect, useRef } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { openpty } from 'xterm-pty'
import type { Slave } from '@/backends'
import '@xterm/xterm/css/xterm.css'

export interface TerminalSession {
  xterm: XTerm
  slave: Slave
}

interface Props {
  /** Called once per mount, after xterm and the pty are wired together. */
  onSession: (session: TerminalSession) => void
  /** Called on unmount, before disposal, so the caller can abort its backend. */
  onTeardown: () => void
}

const DARK: ITheme = {
  background: '#09090b', // zinc-950
  foreground: '#e4e4e7', // zinc-200
  cursor: '#a78bfa',
  cursorAccent: '#09090b',
  selectionBackground: '#3f3f46',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d4d8',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
}

const LIGHT: ITheme = {
  ...DARK,
  background: '#ffffff',
  foreground: '#27272a', // zinc-800
  cursor: '#7c3aed',
  cursorAccent: '#ffffff',
  selectionBackground: '#e4e4e7',
  brightBlack: '#a1a1aa',
}

const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)').matches

/**
 * Owns the xterm.js instance imperatively.
 *
 * Mounted exactly once and memoised so React state changes upstream never touch
 * it — xterm renders into DOM that React does not manage, and re-creating it
 * would drop the pty the backend is attached to. Everything reactive (theme,
 * sizing) is handled inside the effect via listeners rather than props.
 */
function XTerminalImpl({ onSession, onTeardown }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  // Keep callbacks reachable from the mount-once effect without listing them as
  // dependencies.
  const cbRef = useRef({ onSession, onTeardown })
  cbRef.current = { onSession, onTeardown }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const xterm = new XTerm({
      theme: prefersLight() ? LIGHT : DARK,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10_000,
      convertEol: false, // the pty line discipline already applies ONLCR
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(host)

    const { master, slave } = openpty()
    xterm.loadAddon(master)

    // Fit once the element has been laid out, then on every size change.
    let raf = 0
    const refit = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // Throws if the host is display:none or zero-sized; harmless to skip.
        try {
          fit.fit()
        } catch {
          /* not measurable yet */
        }
      })
    }
    refit()

    const ro = new ResizeObserver(refit)
    ro.observe(host)
    window.addEventListener('resize', refit)

    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onScheme = () => {
      xterm.options.theme = mq.matches ? LIGHT : DARK
    }
    mq.addEventListener('change', onScheme)

    cbRef.current.onSession({ xterm, slave })

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', refit)
      mq.removeEventListener('change', onScheme)
      cbRef.current.onTeardown()
      xterm.dispose() // also disposes the loaded master addon
    }
  }, [])

  return <div ref={hostRef} className="h-full w-full" />
}

export const XTerminal = memo(XTerminalImpl)
