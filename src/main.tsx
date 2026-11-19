import React from 'react'
import ReactDOM from 'react-dom/client'
import { scan } from 'react-scan'

import App from '@/App'
import { isIOSBrowserTab, isWebKitEngine } from '@/shared/browserEngine'
import '@/index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import '@/modules/i18n'

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload.
scan({ enabled: import.meta.env.DEV && localStorage.getItem('react-scan') === 'on' })

// Engine class for CSS that must never apply on WebKit regardless of what
// @supports reports (see `.chat-message` in index.css).
if (isWebKitEngine()) {
  document.documentElement.classList.add('engine-webkit')
}

// Browser-tab layout on iPhone/iPad: the workspace shell is laid out in flow
// instead of `fixed`, so Safari draws it behind its own bars (see
// `.ios-browser-tab` in index.css). Home Screen web apps keep the fixed shell.
if (isIOSBrowserTab()) {
  document.documentElement.classList.add('ios-browser-tab')
}

// `?layoutDebug=1`: on-screen viewport/safe-area dump for diagnosing how the
// page sits behind a phone browser's own bars (src/shared/layoutDebug.ts). Kept
// for the browser session so it survives the login redirect; `?layoutDebug=0`
// clears it. The panel is a separate chunk, fetched only when asked for.
function isLayoutDebugRequested(): boolean {
  const STORAGE_KEY = 'cloudcli:layout-debug'
  try {
    const param = new URLSearchParams(window.location.search).get('layoutDebug')
    if (param !== null) {
      if (param === '0' || param === 'false' || param === 'off') {
        window.sessionStorage.removeItem(STORAGE_KEY)
      } else {
        window.sessionStorage.setItem(STORAGE_KEY, '1')
      }
    }
    return window.sessionStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

if (isLayoutDebugRequested()) {
  void import('@/shared/layoutDebug').then(({ mountLayoutDebugOverlay }) => mountLayoutDebugOverlay())
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

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Unable to mount the app: #root is missing from the document')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
