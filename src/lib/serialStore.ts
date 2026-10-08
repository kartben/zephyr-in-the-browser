/**
 * Which real serial port each pipeable emulated UART is plugged into, saved so
 * the pipe comes back after an emulator restart (a restart reloads the page).
 *
 * Web Serial identifies a port by its USB vendor and product IDs and nothing
 * more, so that pair is what gets saved: navigator.serial.getPorts() hands
 * back a port the user granted earlier without asking again, and the pipe
 * reopens whichever one matches. Two identical adapters are indistinguishable;
 * the first match wins.
 *
 * Its own localStorage key (`zephyr.serial`), like `zephyr.net`: a host port
 * is neither dock layout nor a per-sample seed, so it survives both "Reset
 * layout" and switching samples. Keyed by UART so a second pipe can join
 * uart1 later without a version bump.
 */

import { DEFAULT_BAUD_RATE } from '@/serial/webSerial'

const STORAGE_KEY = 'zephyr.serial'
const VERSION = 1

export type PipedUart = 'uart1'

export interface UartPipeSettings {
  /** USB IDs of the port last connected; absent until one is. */
  vid?: number
  pid?: number
  baudRate: number
  /** Reopen the port after a restart, or wait for it to be plugged in. */
  autoReconnect: boolean
}

export interface SerialSettings {
  uarts: Partial<Record<PipedUart, UartPipeSettings>>
}

export function defaultPipe(baudRate = DEFAULT_BAUD_RATE): UartPipeSettings {
  return { baudRate, autoReconnect: true }
}

function usbId(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff
    ? (value as number)
    : undefined
}

function sanitize(raw: unknown): UartPipeSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const baud = r.baudRate
  if (!Number.isInteger(baud) || (baud as number) < 50 || (baud as number) > 10_000_000) {
    return undefined
  }
  const vid = usbId(r.vid)
  const pid = usbId(r.pid)
  return {
    // Both IDs or neither: half an identity matches nothing.
    ...(vid !== undefined && pid !== undefined ? { vid, pid } : {}),
    baudRate: baud as number,
    autoReconnect: r.autoReconnect !== false,
  }
}

function load(): SerialSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { uarts: {} }
    const parsed = JSON.parse(raw) as { v?: number; uarts?: Record<string, unknown> }
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return { uarts: {} }
    const uart1 = sanitize(parsed.uarts?.uart1)
    return { uarts: uart1 ? { uart1 } : {} }
  } catch {
    return { uarts: {} }
  }
}

function save(next: SerialSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, uarts: next.uarts }))
  } catch {
    /* storage full or blocked: the pipe just won't come back after a restart */
  }
}

let state: SerialSettings = load()
const listeners = new Set<() => void>()

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Immutable snapshot; a new object on every change (useSyncExternalStore). */
export function getSettings(): SerialSettings {
  return state
}

export function getPipe(uart: PipedUart): UartPipeSettings | undefined {
  return state.uarts[uart]
}

/** Replace one UART's record; undefined clears it. */
export function setPipe(uart: PipedUart, next: UartPipeSettings | undefined): void {
  const uarts = { ...state.uarts }
  if (next) uarts[uart] = next
  else delete uarts[uart]
  state = { uarts }
  save(state)
  for (const fn of listeners) fn()
}

/** Re-read localStorage. For tests, and after external storage edits. */
export function reloadFromStorage(): void {
  state = load()
  for (const fn of listeners) fn()
}
