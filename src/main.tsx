import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { captureConsole } from './editor/core/log'
import { reportState } from './editor/core/report'
import App from './App.tsx'

// Before anything runs, so that nothing printed is missed
captureConsole()
reportState()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
