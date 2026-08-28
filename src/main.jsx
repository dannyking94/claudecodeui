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
