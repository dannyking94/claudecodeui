import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
import { isWebKitEngine } from './utils/browserEngine'
import './index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'

// Engine class for CSS that must never apply on WebKit regardless of what
// @supports reports (see `.chat-message` in index.css).
if (isWebKitEngine()) {
  document.documentElement.classList.add('engine-webkit');
}

// Panels are code-split, and a rebuild replaces every hashed chunk. A tab
// opened before the rebuild (iOS keeps them around for days) would fail to
// import a panel it has not loaded yet; reload once to pick up the new build
// instead of showing the error boundary. The timestamp guard stops a loop if
// the chunk is genuinely unreachable.
window.addEventListener('vite:preloadError', (event) => {
  const RELOAD_KEY = 'cloudcli-chunk-reload-at'
  const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
  if (Date.now() - last < 60_000) return
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
