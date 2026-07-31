import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { detectQemuAssets } from './backends'
import { claimStashed } from './guestImage'
import { claimStashed as claimStashedLiveElf } from './liveImage'
import { claimStashedDts, clearStashedDts } from './devicetree'
import { resolveModeConfig } from './lib/modeStore'
import { installProfile } from './display/profile'
import './index.css'

installProfile()

/*
 * A user-supplied guest image (and optional zephyr.dts) lives in IndexedDB for
 * the session so Reload / refresh keeps it. Claim both before the first render,
 * since the backend starts as soon as the terminal mounts and would otherwise
 * fetch the board's stock image instead. A DTS without its ELF is cleared so a
 * stock sample cannot inherit a leftover tree. `finally` because a failed claim
 * must not stop the app from starting — the stock image is a perfectly good
 * fallback.
 *
 * A Live board session claims its symbol ELF instead and leaves the Simulator
 * stash untouched, so switching back restores the previous custom-ELF state.
 *
 * The emulator probe rides along for the same reason: the default backend has
 * to be settled before the terminal mounts and starts one.
 */
Promise.all([
  resolveModeConfig().mode === 'live'
    ? claimStashedLiveElf()
    : claimStashed().then(async (image) => {
        if (image) await claimStashedDts()
        else await clearStashedDts()
      }),
  detectQemuAssets(),
]).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
