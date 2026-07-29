import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueueGraphMock } from '@/mocks/QueueGraphMock'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueueGraphMock />
  </StrictMode>,
)
