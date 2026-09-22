/**
 * Probe for WebAssembly JavaScript Promise Integration (JSPI).
 *
 * The emulator builds switch coroutines through JSPI rather than Asyncify, so
 * a browser without it fails inside the emulator's worker at the first switch,
 * with an error that names neither the feature nor the fix. Checking up front
 * lets the page say what is missing before anything is fetched.
 *
 * JSPI is on by default in Chrome and Edge 137, Firefox 153 and Safari 27
 * (macOS and iOS). It adds two entry points to the `WebAssembly` namespace,
 * `Suspending` and `promising`, and their presence is the detection.
 */

/** The two entry points JSPI adds. Structural, since the TS libs lack them. */
interface JspiHost {
  WebAssembly?: { Suspending?: unknown; promising?: unknown }
}

/**
 * Whether `host` exposes JSPI. Defaults to the running environment; the
 * parameter exists so the check can be exercised without a browser.
 */
export function supportsJspi(host: object = globalThis): boolean {
  const wasm = (host as JspiHost).WebAssembly
  if (!wasm) return false
  return typeof wasm.Suspending === 'function' && typeof wasm.promising === 'function'
}

/** Shown when the probe fails. Names the first releases that ship JSPI. */
export const JSPI_UNSUPPORTED_MESSAGE =
  'This browser does not support WebAssembly JavaScript Promise Integration ' +
  '(JSPI), which the emulator needs. Use Chrome or Edge 137, Firefox 153, or ' +
  'Safari 27 (macOS and iOS) or newer.'
