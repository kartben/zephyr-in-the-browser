import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CaptureApp } from './CaptureApp'
import '../index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CaptureApp />
  </StrictMode>,
)
