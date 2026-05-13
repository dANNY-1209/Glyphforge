// app/src/components/Auth/AdminUsersPanel.jsx
//
// Admin-only panel for managing whitelist + admin role + pending requests.
// Mounted as its own top-level "Users" tab, visible only to admins.

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'

function avatarUrl(u) {
  if (!u || !u.discordId) return null
  const av = u.profile?.avatar || u.avatar
  if (!av) return null
  return `https://cdn.discordapp.com/avatars/${u.discordId}/${av}.png?size=64`
}
function displayName(u) {
  return u.profile?.globalName || u.profile?.username || u.username || u.globalName || u.discordId
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
      ? (prompt('Optional note for the user (visible to them):') || '')
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
      <h2>Pending requests <span className="muted">({requests.length})</span></h2>
      {requests.length === 0 ? (
        <p className="muted">No pending requests.</p>
      ) : (
        <ul className="request-list">
          {requests.map((r) => (
            <li key={r.id} className="request-card">
              <div className="request-card-head">
                {avatarUrl({ discordId: r.discordId, profile: r.profile }) && (
                  <img src={avatarUrl({ discordId: r.discordId, profile: r.profile })} alt="" className="avatar" />
                )}
                <div>
                  <div className="name">{displayName({ discordId: r.discordId, profile: r.profile })}</div>
                  <div className="muted small">{r.discordId} · {new Date(r.createdAt).toLocaleString()}</div>
                </div>
              </div>
              {r.reason && <blockquote>{r.reason}</blockquote>}
              <div className="actions">
                <button disabled={!!reviewing[r.id]} onClick={() => review(r.id, 'approved')}>✅ Approve</button>
                <button disabled={!!reviewing[r.id]} className="danger" onClick={() => review(r.id, 'denied')}>⛔ Deny</button>
              </div>
            </li>
          ))}
        </ul>
      )}

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
      <ul className="user-list">
        {users.map((u) => (
          <li key={u.discordId} className="user-card">
            <div className="user-card-head">
              {avatarUrl(u) && <img src={avatarUrl(u)} alt="" className="avatar" />}
              <div>
                <div className="name">
                  {displayName(u)}
                  {u.isSuperAdmin && <span className="badge super">Super-admin</span>}
                  {!u.isSuperAdmin && u.isAdmin && <span className="badge admin">Admin</span>}
                  {!u.isAdmin && u.isWhitelisted && <span className="badge member">Member</span>}
                </div>
                <div className="muted small">{u.discordId}{u.profile?.lastSeen ? ` · last seen ${new Date(u.profile.lastSeen).toLocaleDateString()}` : ''}</div>
              </div>
            </div>
            <div className="actions">
              {!u.isAdmin && (
                <button disabled={busy} onClick={() => promote(u.discordId)}>👑 Promote</button>
              )}
              {u.isAdmin && !u.isSuperAdmin && (
                <button disabled={busy} className="danger" onClick={() => demote(u.discordId)}>⬇️ Demote</button>
              )}
              {!u.isSuperAdmin && (
                <button disabled={busy} className="danger" onClick={() => revoke(u.discordId)}>🚫 Revoke</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
