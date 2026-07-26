/** Vite entry: mount the React app. */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RegisterMapPreview } from './components/RegisterMapPreview'
import { LittlefsPreview } from './components/LittlefsPreview'
import { detectQemuAssets } from './backends'
import { claimStashed } from './guestImage'
import { claimStashedDts } from './devicetree'
import { installProfile } from './display/profile'
import './index.css'

installProfile()

const preview = new URLSearchParams(location.search).get('preview')

/*
 * Claim IndexedDB handoffs before the terminal mounts; QEMU reloads need the
 * custom ELF/DTS and backend choice ready before the first session starts.
 */
Promise.all([claimStashed(), claimStashedDts(), detectQemuAssets()]).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {preview === 'regmap' ? (
        <RegisterMapPreview />
      ) : preview === 'littlefs' ? (
        <LittlefsPreview />
      ) : (
        <App />
      )}
    </StrictMode>,
  )
})
