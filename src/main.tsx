import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { captureConsole } from './editor/core/log'
import App from './App.tsx'

// Before anything runs, so that nothing printed is missed
captureConsole()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
