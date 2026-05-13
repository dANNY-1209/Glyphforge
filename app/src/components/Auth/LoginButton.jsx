// app/src/components/Auth/LoginButton.jsx
//
// Unified header auth widget. Three visual states:
//   - anon       → "Log in with Discord"
//   - logged-in  → "👤 <name>" with a hover menu (Logout)
//                  Plus, if isAdmin: "🔓/🔒 Admin Mode" toggle.
//
// Owns its own dropdown state. Designed to drop in wherever the old
// `admin-toggle-btn` lived; the prop API matches what App.jsx expects.

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'

export default function LoginButton({ adminMode, onAdminModeToggle }) {
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click
  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  // Anonymous: tap once to reveal a small explainer + the OAuth button,
  // so users understand login is the gateway to requesting access rather
  // than instant entry.
  if (!auth.isLoggedIn) {
    return (
      <div className="auth-widget" ref={ref}>
        <button
          className="admin-toggle-btn"
          onClick={() => setOpen((v) => !v)}
          title="Sign in / request access"
        >
          🔐 Log in with Discord
        </button>
        {open && (
          <div className="auth-menu">
            <div className="auth-menu-header" style={{ fontSize: '0.78rem', lineHeight: 1.4 }}>
              Signing in with Discord lets you view content beyond the LoRA tab.<br/>
              If you are not yet whitelisted, you can submit a
              <strong> Request Access </strong>
              form on any restricted page after logging in.
            </div>
            <button
              className="auth-menu-item"
              style={{ fontWeight: 600 }}
              onClick={() => { setOpen(false); auth.login() }}
            >
              Continue with Discord →
            </button>
          </div>
        )}
      </div>
    )
  }

  const displayName = auth.user?.globalName || auth.user?.username || 'User'
  const avatarUrl = auth.user?.avatar && auth.user?.discordId
    ? `https://cdn.discordapp.com/avatars/${auth.user.discordId}/${auth.user.avatar}.png?size=64`
    : null

  return (
    <div className="auth-widget" ref={ref}>
      {auth.isAdmin && (
        <button
          className={`admin-toggle-btn ${adminMode ? 'active' : ''}`}
          onClick={() => onAdminModeToggle && onAdminModeToggle()}
          title={adminMode ? 'Exit Admin Mode' : 'Enter Admin Mode'}
        >
          {adminMode ? '🔓 Admin Mode' : '🔒 Admin'}
        </button>
      )}
      <button
        className="user-chip"
        onClick={() => setOpen((v) => !v)}
        title={displayName}
      >
        {avatarUrl
          ? <img src={avatarUrl} alt="" className="user-chip-avatar" />
          : <span className="user-chip-avatar user-chip-avatar-fallback">👤</span>}
        <span className="user-chip-name">{displayName}</span>
        {!auth.isWhitelisted && <span className="user-chip-badge" title="Not whitelisted">!</span>}
      </button>
      {open && (
        <div className="auth-menu">
          <div className="auth-menu-header">
            <div className="auth-menu-name">{displayName}</div>
            <div className="auth-menu-id">{auth.user?.discordId}</div>
            <div className="auth-menu-flags">
              {auth.isSuperAdmin ? <span className="auth-flag flag-super">Super-admin</span>
                : auth.isAdmin ? <span className="auth-flag flag-admin">Admin</span>
                : auth.isWhitelisted ? <span className="auth-flag flag-member">Whitelisted</span>
                : <span className="auth-flag flag-pending">Limited access</span>}
            </div>
          </div>
          <button className="auth-menu-item" onClick={() => { setOpen(false); auth.logout() }}>
            Log out
          </button>
        </div>
      )}
    </div>
  )
}
