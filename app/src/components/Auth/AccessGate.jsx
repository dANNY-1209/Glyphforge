// app/src/components/Auth/AccessGate.jsx
//
// Renders one of three states when a non-LoRA tab is requested:
//   - Anonymous          → "Log in with Discord to see this section"
//   - Logged in, pending → "⏳ Your access request is pending review"
//   - Logged in, no req  → form to submit a whitelist request
//   - Logged in, denied  → form with "re-request" affordance
//
// Hidden entirely if auth.isWhitelisted (callers should short-circuit
// before this even renders).

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../../auth/AuthContext'

export default function AccessGate() {
  const auth = useAuth()
  const [request, setRequest] = useState(null)
  const [loading, setLoading] = useState(true)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  const refreshRequest = useCallback(async () => {
    if (!auth.isLoggedIn) { setRequest(null); setLoading(false); return }
    setLoading(true)
    const data = await auth.getMyAccessRequest()
    setRequest(data)
    setLoading(false)
  }, [auth])

  useEffect(() => { refreshRequest() }, [refreshRequest])

  if (!auth.isLoggedIn) {
    return (
      <div className="access-gate">
        <div className="access-gate-icon">🔒</div>
        <h2>Sign-in required</h2>
        <p>This section is whitelist-only. Log in with Discord first, then submit an access request from here.</p>
        <button className="access-gate-cta" onClick={() => auth.login()}>
          Log in with Discord
        </button>
      </div>
    )
  }

  if (loading) {
    return <div className="access-gate"><p>Loading…</p></div>
  }

  // Pending request
  if (request && request.status === 'pending') {
    return (
      <div className="access-gate">
        <div className="access-gate-icon">⏳</div>
        <h2>Request pending review</h2>
        <p>Your access request has been submitted and is awaiting admin review. You will see the full content here once it is approved.</p>
        {request.reason && (
          <blockquote className="access-gate-reason">
            <strong>Your stated reason:</strong>
            <p>{request.reason}</p>
          </blockquote>
        )}
        <button
          className="access-gate-cta secondary"
          onClick={async () => {
            if (!confirm('Cancel this request? You can resubmit afterwards.')) return
            const ok = await auth.cancelMyAccessRequest()
            if (ok) { setRequest(null); auth.refresh() }
          }}
        >
          Cancel request
        </button>
      </div>
    )
  }

  // No request OR previously denied/cancelled — show submission form
  const previouslyDenied = request && request.status === 'denied'
  const previouslyCancelled = request && request.status === 'cancelled'

  const submit = async (e) => {
    e.preventDefault()
    setSubmitError(null)
    setSubmitting(true)
    const res = await auth.submitAccessRequest({ reason: reason.trim() })
    setSubmitting(false)
    if (res.ok) {
      setReason('')
      await refreshRequest()
      auth.refresh()  // pick up isWhitelisted if it changed
    } else {
      setSubmitError(res.data?.error || `Submission failed (HTTP ${res.status})`)
    }
  }

  return (
    <div className="access-gate">
      <div className="access-gate-icon">🙋</div>
      <h2>Request access</h2>
      <p>Briefly introduce yourself or explain why you would like access, so the admin can review your request.</p>
      {previouslyDenied && (
        <div className="access-gate-warning">
          Your previous request was denied
          {request.reviewNote && <>: <em>“{request.reviewNote}”</em></>}
          . You are welcome to submit a new request.
        </div>
      )}
      {previouslyCancelled && (
        <div className="access-gate-note">
          Your previous request was cancelled. You can submit a new one anytime.
        </div>
      )}
      <form onSubmit={submit} className="access-gate-form">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="e.g. I'm a friend of Discord ID xxx / I'd like to browse LoRAs for reference…"
        />
        {submitError && <div className="access-gate-error">{submitError}</div>}
        <button className="access-gate-cta" type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit request'}
        </button>
      </form>
    </div>
  )
}
