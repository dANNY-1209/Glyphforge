// app/src/auth/AuthContext.jsx
//
// Single source of truth for the user's Discord identity + permission flags.
// Wraps the Discord OAuth token in localStorage and the /api/auth/me probe.
//
// Three derived states:
//   - loading      — initial probe in flight
//   - user / null  — Discord profile (if any valid token)
//   - flags        — { isWhitelisted, isAdmin, isSuperAdmin }
//
// Consumers can call:
//   - login()              — kick the OAuth redirect
//   - logout()             — clear token + state
//   - refresh()            — re-fetch /api/auth/me (e.g. after approval)
//   - authFetch(url, opt)  — fetch wrapper that attaches Bearer token
//   - submitAccessRequest({ reason })
//   - getMyAccessRequest() — null | request object

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const TOKEN_KEY = 'discordToken'
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
  })
  const [user, setUser] = useState(null)
  const [flags, setFlags] = useState({ isWhitelisted: false, isAdmin: false, isSuperAdmin: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Handle OAuth callback param on first mount: ?discord_token=...
  useEffect(() => {
    const url = new URL(window.location.href)
    const cbToken = url.searchParams.get('discord_token')
    if (cbToken) {
      try { localStorage.setItem(TOKEN_KEY, cbToken) } catch {}
      setToken(cbToken)
      // Clean it out of the URL so a refresh doesn't re-trigger anything.
      url.searchParams.delete('discord_token')
      window.history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash)
    }
    // Legacy cleanup: retire the old admin-password token.
    try {
      localStorage.removeItem('adminToken')
      localStorage.removeItem('adminTokenExpiry')
    } catch {}
  }, [])

  const probe = useCallback(async () => {
    setLoading(true)
    setError(null)
    if (!token) {
      setUser(null)
      setFlags({ isWhitelisted: false, isAdmin: false, isSuperAdmin: false })
      setLoading(false)
      return
    }
    try {
      const resp = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (resp.status === 401) {
        // Stale / invalid token — wipe and continue as anonymous.
        try { localStorage.removeItem(TOKEN_KEY) } catch {}
        setToken(null)
        setUser(null)
        setFlags({ isWhitelisted: false, isAdmin: false, isSuperAdmin: false })
      } else if (resp.ok) {
        const data = await resp.json()
        setUser({
          discordId: data.discordId,
          username: data.username,
          globalName: data.globalName,
          avatar: data.avatar,
        })
        setFlags({
          isWhitelisted: !!data.isWhitelisted,
          isAdmin: !!data.isAdmin,
          isSuperAdmin: !!data.isSuperAdmin,
        })
      } else {
        setError(`auth probe failed: ${resp.status}`)
      }
    } catch (err) {
      setError(err.message || 'auth probe failed')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { probe() }, [probe])

  const login = useCallback(async () => {
    try {
      const resp = await fetch('/api/auth/discord')
      const data = await resp.json()
      if (data.authUrl) {
        window.location.href = data.authUrl
      } else {
        setError(data.error || 'Login URL unavailable')
      }
    } catch (err) {
      setError(err.message || 'Login failed')
    }
  }, [])

  const logout = useCallback(() => {
    try { localStorage.removeItem(TOKEN_KEY) } catch {}
    setToken(null)
    setUser(null)
    setFlags({ isWhitelisted: false, isAdmin: false, isSuperAdmin: false })
  }, [])

  const authFetch = useCallback((url, options = {}) => {
    const headers = { ...(options.headers || {}) }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(url, { ...options, headers })
  }, [token])

  const submitAccessRequest = useCallback(async ({ reason }) => {
    const resp = await authFetch('/api/auth/whitelist-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    const data = await resp.json().catch(() => ({}))
    return { ok: resp.ok, status: resp.status, data }
  }, [authFetch])

  const getMyAccessRequest = useCallback(async () => {
    const resp = await authFetch('/api/auth/whitelist-request/mine')
    if (!resp.ok) return null
    return resp.json()
  }, [authFetch])

  const cancelMyAccessRequest = useCallback(async () => {
    const resp = await authFetch('/api/auth/whitelist-request/mine', { method: 'DELETE' })
    return resp.ok
  }, [authFetch])

  const value = useMemo(() => ({
    loading,
    error,
    token,
    user,
    isLoggedIn: !!user,
    isWhitelisted: flags.isWhitelisted,
    isAdmin: flags.isAdmin,
    isSuperAdmin: flags.isSuperAdmin,
    login,
    logout,
    refresh: probe,
    authFetch,
    submitAccessRequest,
    getMyAccessRequest,
    cancelMyAccessRequest,
  }), [loading, error, token, user, flags, login, logout, probe, authFetch, submitAccessRequest, getMyAccessRequest, cancelMyAccessRequest])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
