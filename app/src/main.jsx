import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AuthProvider } from './auth/AuthContext'
import './index.css'

// Build version sentinel — if the build time embedded in this bundle differs
// from the one stored in localStorage, we know a new deploy has happened and
// the user is loading a fresh bundle. We wipe all caches (localStorage cache_*
// + sessionStorage + Cache API) so stale data from the previous version cannot
// poison the new app shell. Mobile browsers cling to old bundles aggressively;
// this guard makes that harmless instead of requiring a manual hard refresh.
{
  const BUILD_KEY = 'app_build_time'
  // eslint-disable-next-line no-undef
  const currentBuild = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : ''
  try {
    const stored = localStorage.getItem(BUILD_KEY)
    if (currentBuild && stored && stored !== currentBuild) {
      // New build detected — wipe data caches (but KEEP auth token & build key)
      const PRESERVE = new Set(['app_build_time', 'discord_token', 'cache_schema_version'])
      const removeKeys = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && !PRESERVE.has(k) && k.startsWith('cache_')) removeKeys.push(k)
      }
      removeKeys.forEach((k) => localStorage.removeItem(k))
      // Best-effort: clear Cache API entries the browser may have stored
      if (window.caches && caches.keys) {
        caches.keys().then((names) => names.forEach((n) => caches.delete(n))).catch(() => {})
      }
      console.log(`[app] New build detected (${stored} → ${currentBuild}). Wiped ${removeKeys.length} cache entries.`)
    }
    if (currentBuild) localStorage.setItem(BUILD_KEY, currentBuild)
  } catch (_e) { /* localStorage unavailable — ignore */ }
}

// Global fetch interceptor: auto-attach the Discord OAuth Bearer token to
// every same-origin /api/* request. Reads localStorage live so token changes
// (login/logout) take effect immediately without any subscription dance.
//
// Explicit Authorization headers passed by the caller always win, so the
// auth probe in AuthContext that already sets its own header is unaffected.
{
  const TOKEN_KEY = 'discordToken'
  const originalFetch = window.fetch.bind(window)
  window.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      // Match relative /api/... or same-origin absolute URLs.
      const isApi = url.startsWith('/api/')
        || url.startsWith(window.location.origin + '/api/')
      if (isApi) {
        const token = localStorage.getItem(TOKEN_KEY)
        if (token) {
          const headers = new Headers(
            (init && init.headers) || (input && input.headers) || {}
          )
          if (!headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${token}`)
          }
          init = { ...(init || {}), headers }
        }
      }
    } catch (_e) { /* fall through to original fetch */ }
    return originalFetch(input, init)
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
)
