import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { claimStashed } from './guestImage'
import './index.css'

/*
 * A guest image dropped while QEMU was already running is handed across the
 * reload through IndexedDB. Claim it before the first render, since the backend
 * starts as soon as the terminal mounts and would otherwise fetch the board's
 * stock image instead. `finally` because a failed claim must not stop the app
 * from starting — the stock image is a perfectly good fallback.
 */
claimStashed().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
