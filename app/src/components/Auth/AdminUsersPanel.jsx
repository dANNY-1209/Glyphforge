// app/src/components/Auth/AdminUsersPanel.jsx
//
// Admin-only panel for managing whitelist + admin role + pending requests.
// Mounted as its own top-level "Users" tab, visible only to admins.

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'

function defaultAvatarUrl(discordId) {
  if (!discordId) return null
  // Discord embed default avatars: 6 colored silhouettes keyed by ID mod 6.
  // For new-style usernames (Discord ID-based), the formula is (id >> 22) % 6.
  // We use BigInt to handle the 64-bit snowflake safely.
  try {
    const idx = Number((BigInt(discordId) >> 22n) % 6n)
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`
  } catch {
    return `https://cdn.discordapp.com/embed/avatars/0.png`
  }
}
function avatarUrl(u) {
  if (!u || !u.discordId) return defaultAvatarUrl(u?.discordId)
  const av = u.profile?.avatar || u.avatar
  if (!av) return defaultAvatarUrl(u.discordId)
  return `https://cdn.discordapp.com/avatars/${u.discordId}/${av}.png?size=64`
}
function displayName(u) {
  return u.profile?.globalName || u.profile?.username || u.username || u.globalName || `User ${String(u.discordId || '').slice(-4)}`
}

export default function AdminUsersPanel() {
  const auth = useAuth()
  const [users, setUsers] = useState([])
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reviewing, setReviewing] = useState({})   // requestId → boolean
  const [addId, setAddId] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [usersResp, reqResp] = await Promise.all([
        auth.authFetch('/api/admin/users'),
        auth.authFetch('/api/admin/whitelist-requests?status=pending'),
      ])
      if (!usersResp.ok) throw new Error(`users: HTTP ${usersResp.status}`)
      if (!reqResp.ok) throw new Error(`requests: HTTP ${reqResp.status}`)
      const u = await usersResp.json()
      const r = await reqResp.json()
      setUsers(u.users || [])
      setRequests(r.requests || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [auth])

  useEffect(() => { load() }, [load])

  const review = async (id, decision) => {
    const note = decision === 'denied'
      ? (prompt('Optional note to the user (they will see this):') || '')
      : ''
    setReviewing((s) => ({ ...s, [id]: true }))
    try {
      const resp = await auth.authFetch(`/api/admin/whitelist-requests/${id}/${decision === 'approved' ? 'approve' : 'deny'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        alert(`Review failed: ${data.error || resp.status}`)
      } else {
        await load()
      }
    } finally {
      setReviewing((s) => ({ ...s, [id]: false }))
    }
  }

  const promote = async (discordId) => {
    setBusy(true)
    try {
      const resp = await auth.authFetch('/api/admin/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordId }),
      })
      if (!resp.ok) { const d = await resp.json().catch(() => ({})); alert(`Promote failed: ${d.error || resp.status}`) }
      await load()
    } finally { setBusy(false) }
  }
  const demote = async (discordId) => {
    if (!confirm('Demote this admin?')) return
    setBusy(true)
    try {
      const resp = await auth.authFetch(`/api/admin/admins/${discordId}`, { method: 'DELETE' })
      if (!resp.ok) { const d = await resp.json().catch(() => ({})); alert(`Demote failed: ${d.error || resp.status}`) }
      await load()
    } finally { setBusy(false) }
  }
  const revoke = async (discordId) => {
    if (!confirm('Revoke whitelist for this user? This also demotes them from admin if applicable.')) return
    setBusy(true)
    try {
      const resp = await auth.authFetch(`/api/admin/whitelist/${discordId}`, { method: 'DELETE' })
      if (!resp.ok) { const d = await resp.json().catch(() => ({})); alert(`Revoke failed: ${d.error || resp.status}`) }
      await load()
    } finally { setBusy(false) }
  }

  const addDirect = async (e) => {
    e.preventDefault()
    const id = addId.trim()
    if (!/^\d{17,20}$/.test(id)) { alert('Invalid Discord ID'); return }
    setBusy(true)
    try {
      const resp = await auth.authFetch('/api/admin/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordId: id }),
      })
      if (!resp.ok) { const d = await resp.json().catch(() => ({})); alert(`Add failed: ${d.error || resp.status}`) }
      else { setAddId(''); await load() }
    } finally { setBusy(false) }
  }

  if (loading) return <div className="admin-users-panel"><p>Loading users…</p></div>
  if (error) return <div className="admin-users-panel"><p>Error: {error}</p></div>

  return (
    <div className="admin-users-panel">
      <div className="admin-columns">
        <section className="admin-column">
          <h2>Pending requests <span className="muted">({requests.length})</span></h2>
          {requests.length === 0 ? (
            <p className="muted">No pending requests.</p>
          ) : (
            <div className="scroll-list-wrap">
              <ul className="request-list">
                {requests.map((r) => (
                  <li key={r.id} className="request-card">
                    <div className="request-card-head">
                      {avatarUrl({ discordId: r.discordId, profile: r.profile }) && (
                        <img src={avatarUrl({ discordId: r.discordId, profile: r.profile })} alt="" className="avatar" />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="name">
                          {r.profile?.globalName || r.profile?.username || r.discordId}
                          {r.profile?.username && r.profile?.globalName && r.profile.username !== r.profile.globalName && (
                            <span className="muted small" style={{ marginLeft: 8, fontWeight: 'normal' }}>@{r.profile.username}</span>
                          )}
                        </div>
                        <div className="muted small" style={{ wordBreak: 'break-all' }}>
                          ID: <code>{r.discordId}</code>
                        </div>
                        <div className="muted small">
                          {new Date(r.createdAt).toLocaleString()}
                        </div>
                        <div className="muted small" style={{ marginTop: 2 }}>
                          <a
                            href={`discord://-/users/${r.discordId}`}
                            onClick={(e) => { e.preventDefault(); navigator.clipboard?.writeText(r.discordId); }}
                            style={{ color: 'var(--accent-primary, #66ccff)', cursor: 'pointer' }}
                            title="Click to copy Discord ID"
                          >
                            Copy ID
                          </a>
                        </div>
                      </div>
                    </div>
                    {r.reason && <blockquote>{r.reason}</blockquote>}
                    <div className="actions">
                      <button className="primary" disabled={!!reviewing[r.id]} onClick={() => review(r.id, 'approved')}>Approve</button>
                      <button disabled={!!reviewing[r.id]} className="danger" onClick={() => review(r.id, 'denied')}>Deny</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="admin-column">
          <h2>Whitelist <span className="muted">({users.length})</span></h2>
          <form className="add-direct-form" onSubmit={addDirect}>
            <input
              type="text"
              value={addId}
              onChange={(e) => setAddId(e.target.value)}
              placeholder="Discord ID"
              maxLength={20}
            />
            <button type="submit" disabled={busy}>Add directly</button>
          </form>
          <div className="scroll-list-wrap">
            <ul className="user-list">
              {users.map((u) => (
                <li key={u.discordId} className="user-card">
                  <div className="user-card-head">
                    {avatarUrl(u) && <img src={avatarUrl(u)} alt="" className="avatar" />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="name">
                        {displayName(u)}
                        {u.isSuperAdmin && <span className="badge super">Super-admin</span>}
                        {!u.isSuperAdmin && u.isAdmin && <span className="badge admin">Admin</span>}
                        {!u.isAdmin && u.isWhitelisted && <span className="badge member">Member</span>}
                      </div>
                      <div className="muted small" style={{ wordBreak: 'break-all' }}>{u.discordId}</div>
                      {u.profile?.lastSeen && (
                        <div className="muted small">last seen {new Date(u.profile.lastSeen).toLocaleDateString()}</div>
                      )}
                    </div>
                  </div>
                  <div className="actions">
                    {!u.isAdmin && (
                      <button disabled={busy} onClick={() => promote(u.discordId)}>Promote</button>
                    )}
                    {u.isAdmin && !u.isSuperAdmin && (
                      <button disabled={busy} className="danger" onClick={() => demote(u.discordId)}>Demote</button>
                    )}
                    {!u.isSuperAdmin && (
                      <button disabled={busy} className="danger" onClick={() => revoke(u.discordId)}>Revoke</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  )
}
