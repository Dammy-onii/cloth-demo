import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Workshop from './outfits/Workshop'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname.replace(/\/$/, '') === '/outfits' ? <Workshop /> : <App />}
  </StrictMode>,
)
