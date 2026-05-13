import React, { useState, useEffect, useRef } from 'react'
import './Request.css'
import LoginButton from '../Auth/LoginButton'

function Request({ isLoggedIn, adminMode, onAdminLogout, onAdminModeToggle }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [showRequestModal, setShowRequestModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingRequest, setEditingRequest] = useState(null)
  const [requestType, setRequestType] = useState('lora')

  // Discord OAuth state
  const [discordUser, setDiscordUser] = useState(null)
  const [discordRequired, setDiscordRequired] = useState(false)
  const [discordConfigured, setDiscordConfigured] = useState(false)
  const [discordLoading, setDiscordLoading] = useState(true)

  // Detail modal
  const [showDetailModal, setShowDetailModal] = useState(false)
  const [selectedRequest, setSelectedRequest] = useState(null)

  // Submitter info modal
  const [showSubmitterModal, setShowSubmitterModal] = useState(false)
  const [selectedSubmitter, setSelectedSubmitter] = useState(null)

  // Owner edit modal (for Discord users editing their own requests)
  const [showOwnerEditModal, setShowOwnerEditModal] = useState(false)
  const [ownerEditingRequest, setOwnerEditingRequest] = useState(null)

  // Reject reason modal
  const [showRejectReasonModal, setShowRejectReasonModal] = useState(false)
  const [rejectReasonRequest, setRejectReasonRequest] = useState(null)
  const [rejectReasonInput, setRejectReasonInput] = useState('')

  // Admin edit note — included in PUT body so Discord notification can quote
  // the change description verbatim. Empty string = backend auto-generates
  // a "Changed: <fields>" message from the diff.
  const [editNote, setEditNote] = useState('')

  // Category collapse state (persisted in localStorage)
  const [collapsedCategories, setCollapsedCategories] = useState(() => {
    try {
      const saved = localStorage.getItem('request-collapsed-categories')
      return saved ? new Set(JSON.parse(saved)) : new Set()
    } catch {
      return new Set()
    }
  })

  // Status filter
  const [statusFilter, setStatusFilter] = useState('all')

  // Form states
  const [formData, setFormData] = useState({
    characterName: '',
    outfit: '',
    livestreamArchive: '',
    channelLink: '',
    socialMediaLink: ''
  })
  const [formErrors, setFormErrors] = useState({})

  // Persist collapsed categories
  useEffect(() => {
    localStorage.setItem('request-collapsed-categories', JSON.stringify([...collapsedCategories]))
  }, [collapsedCategories])

  // Load requests on mount
  useEffect(() => {
    loadRequests()
  }, [])

  // Check Discord OAuth status and handle callback
  useEffect(() => {
    const initDiscord = async () => {
      setDiscordLoading(true)
      
      // Check if Discord OAuth is configured
      try {
        const statusRes = await fetch('/api/auth/discord/status')
        const status = await statusRes.json()
        setDiscordConfigured(status.configured)
        setDiscordRequired(status.required && status.configured)
      } catch (error) {
        console.error('Failed to check Discord status:', error)
      }

      // Check for Discord token in URL (OAuth callback)
      const urlParams = new URLSearchParams(window.location.search)
      const discordToken = urlParams.get('discord_token')
      if (discordToken) {
        localStorage.setItem('discordToken', discordToken)
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname)
      }

      // Check for existing Discord token
      const storedToken = localStorage.getItem('discordToken')
      if (storedToken) {
        try {
          const userRes = await fetch('/api/auth/discord/me', {
            headers: { Authorization: `Bearer ${storedToken}` }
          })
          if (userRes.ok) {
            const userData = await userRes.json()
            setDiscordUser(userData)
          } else {
            // Token invalid, remove it
            localStorage.removeItem('discordToken')
          }
        } catch (error) {
          console.error('Failed to verify Discord token:', error)
          localStorage.removeItem('discordToken')
        }
      }

      setDiscordLoading(false)
    }

    initDiscord()
  }, [])

  const loadRequests = async () => {
    setLoading(true)
    try {
      const headers = {}
      // Include admin token if logged in to get submittedBy info
      const adminToken = localStorage.getItem('discordToken')
      const discordToken = localStorage.getItem('discordToken')
      
      if (adminToken) {
        headers['Authorization'] = `Bearer ${adminToken}`
      } else if (discordToken) {
        // Include Discord token so user can see their own submittedBy info
        headers['Authorization'] = `Bearer ${discordToken}`
      }
      
      const response = await fetch('/api/requests', { headers })
      const data = await response.json()
      setRequests(data)
    } catch (error) {
      console.error('Failed to load requests:', error)
    } finally {
      setLoading(false)
    }
  }

  // Reload requests when admin mode or Discord user changes (to get/hide submittedBy)
  useEffect(() => {
    if (!loading) {
      loadRequests()
    }
  }, [isLoggedIn, discordUser])

  const handleOpenModal = () => {
    setShowRequestModal(true)
    setFormData({
      characterName: '',
      outfit: '',
      livestreamArchive: '',
      channelLink: '',
      socialMediaLink: ''
    })
    setFormErrors({})
  }

  const handleCloseModal = () => {
    setShowRequestModal(false)
    setFormData({
      characterName: '',
      outfit: '',
      livestreamArchive: '',
      channelLink: '',
      socialMediaLink: ''
    })
    setFormErrors({})
  }

  const validateForm = () => {
    const errors = {}

    if (!formData.characterName.trim()) {
      errors.characterName = 'Character name is required'
    }

    if (!formData.outfit.trim()) {
      errors.outfit = 'Outfit name is required'
    }

    if (!formData.livestreamArchive.trim()) {
      errors.livestreamArchive = 'Livestream archive link is required'
    }

    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleDiscordLogin = async () => {
    try {
      const response = await fetch('/api/auth/discord')
      const data = await response.json()
      if (data.authUrl) {
        window.location.href = data.authUrl
      }
    } catch (error) {
      console.error('Failed to start Discord login:', error)
      alert('Failed to start Discord login')
    }
  }

  const handleDiscordLogout = () => {
    localStorage.removeItem('discordToken')
    setDiscordUser(null)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    // Check if Discord login is required
    if (discordRequired && !discordUser) {
      alert('Please login with Discord to submit a request')
      return
    }

    try {
      const headers = {
        'Content-Type': 'application/json'
      }

      // Add Discord token if logged in
      const discordToken = localStorage.getItem('discordToken')
      if (discordToken) {
        headers['Authorization'] = `Bearer ${discordToken}`
      }

      const response = await fetch('/api/requests', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: requestType,
          ...formData,
          status: 'pending',
          createdAt: new Date().toISOString()
        })
      })

      if (response.ok) {
        handleCloseModal()
        loadRequests()
      } else {
        const error = await response.json()
        if (response.status === 401) {
          alert('Please login with Discord to submit a request')
        } else {
          alert(error.error || 'Failed to submit request')
        }
      }
    } catch (error) {
      console.error('Failed to submit request:', error)
      alert('Failed to submit request')
    }
  }

  const handleStatusChange = async (requestId, newStatus) => {
    try {
      const token = localStorage.getItem('discordToken')
      const response = await fetch(`/api/requests/${requestId}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: newStatus })
      })

      if (response.ok) {
        loadRequests()
      } else {
        alert('Failed to update status')
      }
    } catch (error) {
      console.error('Failed to update status:', error)
      alert('Failed to update status')
    }
  }

  const handleOpenEditModal = (request) => {
    setEditingRequest(request)
    setRequestType(request.type)
    setFormData({
      characterName: request.characterName,
      outfit: request.outfit,
      livestreamArchive: request.livestreamArchive || '',
      channelLink: request.channelLink || '',
      socialMediaLink: request.socialMediaLink || ''
    })
    setFormErrors({})
    setShowEditModal(true)
  }

  const handleCloseEditModal = () => {
    setShowEditModal(false)
    setEditingRequest(null)
    setEditNote('')
    setFormData({
      characterName: '',
      outfit: '',
      livestreamArchive: '',
      channelLink: '',
      socialMediaLink: ''
    })
    setFormErrors({})
  }

  const handleEditSubmit = async (e) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    try {
      const token = localStorage.getItem('discordToken')
      const response = await fetch(`/api/requests/${editingRequest.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          type: requestType,
          ...formData,
          status: editingRequest.status,
          editNote
        })
      })

      if (response.ok) {
        handleCloseEditModal()
        loadRequests()
      } else {
        alert('Failed to update request')
      }
    } catch (error) {
      console.error('Failed to update request:', error)
      alert('Failed to update request')
    }
  }

  const handleDelete = async (requestId) => {
    if (!window.confirm('Are you sure you want to delete this request?')) {
      return
    }

    try {
      const token = localStorage.getItem('discordToken')
      const response = await fetch(`/api/requests/${requestId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.ok) {
        loadRequests()
      } else {
        alert('Failed to delete request')
      }
    } catch (error) {
      console.error('Failed to delete request:', error)
      alert('Failed to delete request')
    }
  }

  const handleMoveUp = async (index) => {
    if (index === 0) return

    const newRequests = [...requests]
    const temp = newRequests[index]
    newRequests[index] = newRequests[index - 1]
    newRequests[index - 1] = temp

    await updateOrder(newRequests)
  }

  const handleMoveDown = async (index) => {
    if (index === requests.length - 1) return

    const newRequests = [...requests]
    const temp = newRequests[index]
    newRequests[index] = newRequests[index + 1]
    newRequests[index + 1] = temp

    await updateOrder(newRequests)
  }

  const updateOrder = async (newRequests) => {
    try {
      const token = localStorage.getItem('discordToken')
      const orderedIds = newRequests.map(r => r.id)

      const response = await fetch('/api/requests/reorder', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ orderedIds })
      })

      if (response.ok) {
        setRequests(newRequests)
      } else {
        alert('Failed to reorder requests')
      }
    } catch (error) {
      console.error('Failed to reorder requests:', error)
      alert('Failed to reorder requests')
    }
  }

  const handleAdminClick = () => {
    if (isLoggedIn) {
      onAdminModeToggle()
    }
  }

  const handleLogout = () => {
    onAdminLogout()
  }

  // Owner edit modal handlers
  const handleOpenOwnerEditModal = (request) => {
    setOwnerEditingRequest(request)
    setRequestType(request.type)
    setFormData({
      characterName: request.characterName,
      outfit: request.outfit,
      livestreamArchive: request.livestreamArchive || '',
      channelLink: request.channelLink || '',
      socialMediaLink: request.socialMediaLink || ''
    })
    setFormErrors({})
    setShowOwnerEditModal(true)
  }

  const handleCloseOwnerEditModal = () => {
    setShowOwnerEditModal(false)
    setOwnerEditingRequest(null)
    setFormData({
      characterName: '',
      outfit: '',
      livestreamArchive: '',
      channelLink: '',
      socialMediaLink: ''
    })
    setFormErrors({})
  }

  const handleOwnerEditSubmit = async (e) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    try {
      const discordToken = localStorage.getItem('discordToken')
      if (!discordToken) {
        alert('Please login with Discord to edit your request')
        return
      }

      const response = await fetch(`/api/requests/${ownerEditingRequest.id}/owner`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${discordToken}`
        },
        body: JSON.stringify({
          type: requestType,
          ...formData
        })
      })

      if (response.ok) {
        handleCloseOwnerEditModal()
        loadRequests()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to update request')
      }
    } catch (error) {
      console.error('Failed to update request:', error)
      alert('Failed to update request')
    }
  }

  // Reject reason handlers
  const handleOpenRejectReasonModal = (request) => {
    setRejectReasonRequest(request)
    setRejectReasonInput(request.rejectReason || '')
    setShowRejectReasonModal(true)
  }

  const handleCloseRejectReasonModal = () => {
    setShowRejectReasonModal(false)
    setRejectReasonRequest(null)
    setRejectReasonInput('')
  }

  const handleSaveRejectReason = async () => {
    try {
      const token = localStorage.getItem('discordToken')
      const response = await fetch(`/api/requests/${rejectReasonRequest.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          rejectReason: rejectReasonInput
        })
      })

      if (response.ok) {
        handleCloseRejectReasonModal()
        loadRequests()
      } else {
        alert('Failed to save reject reason')
      }
    } catch (error) {
      console.error('Failed to save reject reason:', error)
      alert('Failed to save reject reason')
    }
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending': return 'var(--text-secondary)'
      case 'in-progress': return 'var(--accent-primary)'
      case 'completed': return 'var(--success-green)'
      case 'rejected': return 'var(--chart-costume)'
      default: return 'var(--text-secondary)'
    }
  }

  const getStatusText = (status) => {
    switch (status) {
      case 'pending': return 'Pending'
      case 'in-progress': return 'In Progress'
      case 'completed': return 'Completed'
      case 'rejected': return 'Rejected'
      default: return status
    }
  }

  // Open detail modal
  const handleOpenDetailModal = (request) => {
    setSelectedRequest(request)
    setShowDetailModal(true)
  }

  const handleCloseDetailModal = () => {
    setShowDetailModal(false)
    setSelectedRequest(null)
  }

  // Toggle category collapse
  const toggleCategory = (categoryKey) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(categoryKey)) {
        next.delete(categoryKey)
      } else {
        next.add(categoryKey)
      }
      return next
    })
  }

  // Filter requests by status, sort by date (earliest first), completed and rejected always last
  const sortRequests = (list) => {
    const byDate = (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    const active = list.filter(r => r.status !== 'completed' && r.status !== 'rejected').sort(byDate)
    const completed = list.filter(r => r.status === 'completed').sort(byDate)
    const rejected = list.filter(r => r.status === 'rejected').sort(byDate)
    return [...active, ...completed, ...rejected]
  }

  const filteredRequests = sortRequests(
    statusFilter === 'all'
      ? requests
      : requests.filter(r => r.status === statusFilter)
  )

  // Group by type
  const requestTypes = [
    { key: 'lora', label: 'LoRA Requests', icon: '🎨' }
    // Future types can be added here:
    // { key: 'prompt', label: 'Prompt Requests', icon: '📝' },
  ]

  // Get status counts for filter chips
  const statusCounts = {
    all: requests.length,
    pending: requests.filter(r => r.status === 'pending').length,
    'in-progress': requests.filter(r => r.status === 'in-progress').length,
    completed: requests.filter(r => r.status === 'completed').length,
    rejected: requests.filter(r => r.status === 'rejected').length
  }

  // Render a compact request card
  const renderRequestCard = (request, index) => {
    const isCompleted = request.status === 'completed'
    const isRejected = request.status === 'rejected'
    const isDimmed = isCompleted || isRejected

    return (
      <div
        key={request.id}
        className={`request-card compact ${isCompleted ? 'completed' : ''} ${isRejected ? 'rejected' : ''}`}
        onClick={() => !adminMode && handleOpenDetailModal(request)}
      >
        {/* Completed/Rejected overlay */}
        {isDimmed && <div className="request-card-completed-overlay" />}

        {/* Compact view - always visible */}
        <div className="request-card-compact">
          <div className="request-card-header">
            <span
              className="request-status-badge"
              style={{ backgroundColor: getStatusColor(request.status) }}
            >
              {getStatusText(request.status)}
            </span>
          </div>

          <div className="request-card-summary">
            <h3>{request.characterName}</h3>
            <p className="request-outfit">{request.outfit}</p>
          </div>
        </div>

        {/* Admin controls */}
        {adminMode && (
          <div className="request-card-admin" onClick={(e) => e.stopPropagation()}>
            <div className="request-admin-controls">
              <select
                value={request.status}
                onChange={(e) => handleStatusChange(request.id, e.target.value)}
                className="status-select"
              >
                <option value="pending">Pending</option>
                <option value="in-progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="rejected">Rejected</option>
              </select>
              {request.status === 'rejected' && (
                <button
                  className="admin-button reject-reason-button"
                  onClick={() => handleOpenRejectReasonModal(request)}
                  title="Edit reject reason"
                >
                  💬
                </button>
              )}
              <button
                className="admin-button edit-button"
                onClick={() => handleOpenEditModal(request)}
                title="Edit request"
              >
                ✎
              </button>
              {request.submittedBy && (
                <button
                  className="admin-button"
                  onClick={() => {
                    setSelectedSubmitter(request.submittedBy)
                    setShowSubmitterModal(true)
                  }}
                  title="View submitter Discord profile"
                >
                  👤
                </button>
              )}
              <button
                className="admin-button delete-button"
                onClick={() => handleDelete(request.id)}
                title="Delete request"
              >
                🗑
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="request-container">
      <div className="request-header">
        <div>
          <h2>Request Management</h2>
          <p>Submit or view LoRA and Prompt requests</p>
        </div>
        <div className="request-header-actions">
          {/* Discord login + admin toggle */}
          <LoginButton adminMode={adminMode} onAdminModeToggle={onAdminModeToggle} />
          <button className="submit-request-button" onClick={handleOpenModal}>
            + New Request
          </button>
        </div>
      </div>

      {/* Status Filter Chips */}
      {!loading && requests.length > 0 && (
        <div className="request-status-filters">
          {[
            { key: 'all', label: 'All' },
            { key: 'pending', label: 'Pending' },
            { key: 'in-progress', label: 'In Progress' },
            { key: 'completed', label: 'Completed' },
            { key: 'rejected', label: 'Rejected' }
          ].map(({ key, label }) => (
            <button
              key={key}
              className={`status-chip ${statusFilter === key ? 'active' : ''} ${key !== 'all' ? `status-chip-${key}` : ''}`}
              onClick={() => setStatusFilter(key)}
            >
              {label}
              <span className="status-chip-count">{statusCounts[key]}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="request-loading">Loading requests...</div>
      ) : requests.length === 0 ? (
        <div className="request-empty">
          <p>No requests yet. Be the first to submit one!</p>
        </div>
      ) : (
        <div className="request-categories">
          {requestTypes.map(({ key, label, icon }) => {
            const typeRequests = filteredRequests.filter(r => r.type === key)
            const totalTypeRequests = requests.filter(r => r.type === key).length
            const isCollapsed = collapsedCategories.has(key)

            if (totalTypeRequests === 0) return null

            return (
              <div key={key} className="request-category-section">
                <div
                  className="request-category-header"
                  onClick={() => toggleCategory(key)}
                >
                  <span className={`request-category-arrow ${isCollapsed ? '' : 'expanded'}`}>
                    ▶
                  </span>
                  <h3 className="request-category-title">
                    <span className="request-category-icon">{icon}</span>
                    {label}
                  </h3>
                  <span className="request-category-count">
                    {statusFilter !== 'all' ? `${typeRequests.length} / ${totalTypeRequests}` : totalTypeRequests}
                  </span>
                </div>

                {!isCollapsed && (
                  <div className="request-grid-list">
                    {typeRequests.length > 0 ? (
                      typeRequests.map((request, index) => renderRequestCard(request, index))
                    ) : (
                      <div className="request-category-empty">
                        No {statusFilter} requests
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Request Modal */}
      {showRequestModal && (
        <div className="request-modal-overlay" onClick={handleCloseModal}>
          <div className="request-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="request-modal-close" onClick={handleCloseModal}>×</button>

            <h2>New Request</h2>

            <div className="request-type-selector">
              <button
                className={`type-button ${requestType === 'lora' ? 'active' : ''}`}
                onClick={() => setRequestType('lora')}
              >
                LoRA Request
              </button>
              <button
                className={`type-button ${requestType === 'prompt' ? 'active' : ''}`}
                onClick={() => setRequestType('prompt')}
                disabled
                title="Coming soon"
              >
                Prompt Request (Coming Soon)
              </button>
            </div>

            <form onSubmit={handleSubmit} className="request-form">
              <div className="form-group">
                <label htmlFor="characterName">
                  Character Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  id="characterName"
                  value={formData.characterName}
                  onChange={(e) => setFormData({ ...formData, characterName: e.target.value })}
                  className={formErrors.characterName ? 'error' : ''}
                  placeholder="Enter character name"
                />
                {formErrors.characterName && (
                  <span className="error-message">{formErrors.characterName}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="outfit">
                  Outfit Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  id="outfit"
                  value={formData.outfit}
                  onChange={(e) => setFormData({ ...formData, outfit: e.target.value })}
                  className={formErrors.outfit ? 'error' : ''}
                  placeholder="Enter outfit name"
                />
                {formErrors.outfit && (
                  <span className="error-message">{formErrors.outfit}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="livestreamArchive">
                  Livestream Archive <span className="required">*</span>
                </label>
                <input
                  type="url"
                  id="livestreamArchive"
                  value={formData.livestreamArchive}
                  onChange={(e) => setFormData({ ...formData, livestreamArchive: e.target.value })}
                  className={formErrors.livestreamArchive ? 'error' : ''}
                  placeholder="https://..."
                />
                {formErrors.livestreamArchive && (
                  <span className="error-message">{formErrors.livestreamArchive}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="channelLink">Channel Link</label>
                <input
                  type="url"
                  id="channelLink"
                  value={formData.channelLink}
                  onChange={(e) => setFormData({ ...formData, channelLink: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="form-group">
                <label htmlFor="socialMediaLink">Social Media Link</label>
                <input
                  type="url"
                  id="socialMediaLink"
                  value={formData.socialMediaLink}
                  onChange={(e) => setFormData({ ...formData, socialMediaLink: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="form-actions">
                <button type="button" onClick={handleCloseModal} className="cancel-button">
                  Cancel
                </button>
                <button type="submit" className="submit-button">
                  Submit Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && editingRequest && (
        <div className="request-modal-overlay" onClick={handleCloseEditModal}>
          <div className="request-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="request-modal-close" onClick={handleCloseEditModal}>×</button>

            <h2>Edit Request</h2>

            <div className="request-type-selector">
              <button
                className={`type-button ${requestType === 'lora' ? 'active' : ''}`}
                onClick={() => setRequestType('lora')}
              >
                LoRA Request
              </button>
              <button
                className={`type-button ${requestType === 'prompt' ? 'active' : ''}`}
                onClick={() => setRequestType('prompt')}
                disabled
                title="Coming soon"
              >
                Prompt Request (Coming Soon)
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="request-form">
              <div className="form-group">
                <label htmlFor="edit-characterName">
                  Character Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  id="edit-characterName"
                  value={formData.characterName}
                  onChange={(e) => setFormData({ ...formData, characterName: e.target.value })}
                  className={formErrors.characterName ? 'error' : ''}
                  placeholder="Enter character name"
                />
                {formErrors.characterName && (
                  <span className="error-message">{formErrors.characterName}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="edit-outfit">
                  Outfit Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  id="edit-outfit"
                  value={formData.outfit}
                  onChange={(e) => setFormData({ ...formData, outfit: e.target.value })}
                  className={formErrors.outfit ? 'error' : ''}
                  placeholder="Enter outfit name"
                />
                {formErrors.outfit && (
                  <span className="error-message">{formErrors.outfit}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="edit-livestreamArchive">
                  Livestream Archive <span className="required">*</span>
                </label>
                <input
                  type="url"
                  id="edit-livestreamArchive"
                  value={formData.livestreamArchive}
                  onChange={(e) => setFormData({ ...formData, livestreamArchive: e.target.value })}
                  className={formErrors.livestreamArchive ? 'error' : ''}
                  placeholder="https://..."
                />
                {formErrors.livestreamArchive && (
                  <span className="error-message">{formErrors.livestreamArchive}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="edit-channelLink">Channel Link</label>
                <input
                  type="url"
                  id="edit-channelLink"
                  value={formData.channelLink}
                  onChange={(e) => setFormData({ ...formData, channelLink: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="form-group">
                <label htmlFor="edit-socialMediaLink">Social Media Link</label>
                <input
                  type="url"
                  id="edit-socialMediaLink"
                  value={formData.socialMediaLink}
                  onChange={(e) => setFormData({ ...formData, socialMediaLink: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="edit-note-block">
                <label className="edit-note-label" htmlFor="edit-note-request">Change note (optional)</label>
                <div className="edit-note-hint">
                  Shown in the Discord notification. Leave blank to auto-list the changed fields.
                </div>
                <textarea
                  id="edit-note-request"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  maxLength={500}
                  placeholder="Describe what you changed and why…"
                />
              </div>

              <div className="form-actions">
                <button type="button" onClick={handleCloseEditModal} className="cancel-button">
                  Cancel
                </button>
                <button type="submit" className="submit-button">
                  Update Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Request Detail Modal */}
      {showDetailModal && selectedRequest && (
        <div className="request-modal-overlay" onClick={handleCloseDetailModal}>
          <div className="request-detail-modal" onClick={(e) => e.stopPropagation()}>
            <button className="request-modal-close" onClick={handleCloseDetailModal}>×</button>

            {/* Header with status */}
            <div className="detail-modal-header">
              <span
                className="request-status-badge large"
                style={{ backgroundColor: getStatusColor(selectedRequest.status) }}
              >
                {getStatusText(selectedRequest.status)}
              </span>
              <span className="detail-modal-date">
                {new Date(selectedRequest.createdAt).toLocaleDateString()}
              </span>
            </div>

            {/* Main info */}
            <div className="detail-modal-main">
              <h2>{selectedRequest.characterName}</h2>
              <p className="detail-modal-outfit">{selectedRequest.outfit}</p>
            </div>

            {/* Reject reason - shown for rejected requests */}
            {selectedRequest.status === 'rejected' && selectedRequest.rejectReason && (
              <div className="detail-modal-reject-reason">
                <strong>Reject Reason:</strong>
                <p>{selectedRequest.rejectReason}</p>
              </div>
            )}

            {/* Links section */}
            <div className="detail-modal-links">
              <div className="detail-link-item">
                <span className="detail-link-label">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z"/>
                  </svg>
                  Livestream Archive
                </span>
                {selectedRequest.livestreamArchive ? (
                  <a
                    href={selectedRequest.livestreamArchive}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {selectedRequest.livestreamArchive}
                  </a>
                ) : (
                  <span className="detail-link-empty">Not provided</span>
                )}
              </div>
              <div className="detail-link-item">
                <span className="detail-link-label">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                  </svg>
                  Channel Link
                </span>
                {selectedRequest.channelLink ? (
                  <a
                    href={selectedRequest.channelLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {selectedRequest.channelLink}
                  </a>
                ) : (
                  <span className="detail-link-empty">Not provided</span>
                )}
              </div>
              <div className="detail-link-item">
                <span className="detail-link-label">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                  </svg>
                  Social Media
                </span>
                {selectedRequest.socialMediaLink ? (
                  <a
                    href={selectedRequest.socialMediaLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {selectedRequest.socialMediaLink}
                  </a>
                ) : (
                  <span className="detail-link-empty">Not provided</span>
                )}
              </div>
            </div>

            {/* Admin-only: Submitter info — click to open full submitter modal */}
            {isLoggedIn && selectedRequest.submittedBy && (
              <div
                className="detail-modal-submitter"
                onClick={() => {
                  setSelectedSubmitter(selectedRequest.submittedBy)
                  setShowSubmitterModal(true)
                }}
                style={{ cursor: 'pointer' }}
                title="Click to view full Discord profile"
              >
                <div className="detail-submitter-header">Submitted by</div>
                <div className="detail-submitter-info">
                  {selectedRequest.submittedBy.avatar ? (
                    <img
                      src={`https://cdn.discordapp.com/avatars/${selectedRequest.submittedBy.discordId}/${selectedRequest.submittedBy.avatar}.png?size=64`}
                      alt=""
                      className="detail-submitter-avatar"
                    />
                  ) : (
                    <div className="detail-submitter-avatar-placeholder">
                      {selectedRequest.submittedBy.globalName?.charAt(0) || selectedRequest.submittedBy.username?.charAt(0) || '?'}
                    </div>
                  )}
                  <div className="detail-submitter-text">
                    <span className="detail-submitter-name">
                      {selectedRequest.submittedBy.globalName || selectedRequest.submittedBy.username}
                    </span>
                    <span className="detail-submitter-id">
                      @{selectedRequest.submittedBy.username} • {selectedRequest.submittedBy.discordId}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Owner edit button */}
            {discordUser && selectedRequest.submittedBy?.discordId === discordUser.discordId && selectedRequest.status === 'pending' && (
              <button
                className="owner-edit-btn modal-edit-btn"
                onClick={() => {
                  handleCloseDetailModal()
                  handleOpenOwnerEditModal(selectedRequest)
                }}
              >
                ✎ Edit My Request
              </button>
            )}
          </div>
        </div>
      )}

      {/* Submitter Info Modal (Admin Only) */}
      {showSubmitterModal && selectedSubmitter && (
        <div className="submitter-modal-overlay" onClick={() => setShowSubmitterModal(false)}>
          <div className="submitter-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="submitter-modal-close" onClick={() => setShowSubmitterModal(false)}>×</button>
            <h3>Submitter Information</h3>
            <div className="submitter-modal-body">
              <div className="submitter-modal-avatar">
                {selectedSubmitter.avatar ? (
                  <img
                    src={`https://cdn.discordapp.com/avatars/${selectedSubmitter.discordId}/${selectedSubmitter.avatar}.png?size=128`}
                    alt=""
                  />
                ) : (
                  <div className="submitter-modal-avatar-placeholder">
                    {selectedSubmitter.globalName?.charAt(0) || selectedSubmitter.username?.charAt(0) || '?'}
                  </div>
                )}
              </div>
              <div className="submitter-modal-details">
                <div className="submitter-detail-row">
                  <span className="submitter-detail-label">Display Name</span>
                  <span className="submitter-detail-value">{selectedSubmitter.globalName || selectedSubmitter.username}</span>
                </div>
                <div className="submitter-detail-row">
                  <span className="submitter-detail-label">Username</span>
                  <span className="submitter-detail-value">@{selectedSubmitter.username}</span>
                </div>
                <div className="submitter-detail-row">
                  <span className="submitter-detail-label">Discord ID</span>
                  <span className="submitter-detail-value submitter-id-mono">{selectedSubmitter.discordId}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Owner Edit Modal (for Discord users editing their own requests) */}
      {showOwnerEditModal && ownerEditingRequest && (
        <div className="request-modal-overlay" onClick={handleCloseOwnerEditModal}>
          <div className="request-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="request-modal-close" onClick={handleCloseOwnerEditModal}>×</button>

            <h2>Edit Your Request</h2>

            <form onSubmit={handleOwnerEditSubmit} className="request-form">
              <div className="form-group">
                <label htmlFor="owner-characterName">
                  Character Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  id="owner-characterName"
                  value={formData.characterName}
                  onChange={(e) => setFormData({ ...formData, characterName: e.target.value })}
                  className={formErrors.characterName ? 'error' : ''}
                  placeholder="Enter character name"
                />
                {formErrors.characterName && (
                  <span className="error-message">{formErrors.characterName}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="owner-outfit">
                  Outfit Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  id="owner-outfit"
                  value={formData.outfit}
                  onChange={(e) => setFormData({ ...formData, outfit: e.target.value })}
                  className={formErrors.outfit ? 'error' : ''}
                  placeholder="Enter outfit name"
                />
                {formErrors.outfit && (
                  <span className="error-message">{formErrors.outfit}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="owner-livestreamArchive">
                  Livestream Archive <span className="required">*</span>
                </label>
                <input
                  type="url"
                  id="owner-livestreamArchive"
                  value={formData.livestreamArchive}
                  onChange={(e) => setFormData({ ...formData, livestreamArchive: e.target.value })}
                  className={formErrors.livestreamArchive ? 'error' : ''}
                  placeholder="https://..."
                />
                {formErrors.livestreamArchive && (
                  <span className="error-message">{formErrors.livestreamArchive}</span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="owner-channelLink">Channel Link</label>
                <input
                  type="url"
                  id="owner-channelLink"
                  value={formData.channelLink}
                  onChange={(e) => setFormData({ ...formData, channelLink: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="form-group">
                <label htmlFor="owner-socialMediaLink">Social Media Link</label>
                <input
                  type="url"
                  id="owner-socialMediaLink"
                  value={formData.socialMediaLink}
                  onChange={(e) => setFormData({ ...formData, socialMediaLink: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="form-actions">
                <button type="button" onClick={handleCloseOwnerEditModal} className="cancel-button">
                  Cancel
                </button>
                <button type="submit" className="submit-button">
                  Update Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject Reason Modal (Admin Only) */}
      {showRejectReasonModal && rejectReasonRequest && (
        <div className="submitter-modal-overlay" onClick={handleCloseRejectReasonModal}>
          <div className="submitter-modal-content reject-reason-modal" onClick={(e) => e.stopPropagation()}>
            <button className="submitter-modal-close" onClick={handleCloseRejectReasonModal}>×</button>
            <h3>Reject Reason</h3>
            <div className="reject-reason-modal-body">
              <p className="reject-reason-info">
                Explain why this request was rejected. This will be visible to the submitter.
              </p>
              <textarea
                className="reject-reason-textarea"
                value={rejectReasonInput}
                onChange={(e) => setRejectReasonInput(e.target.value)}
                placeholder="Enter the reason for rejection..."
                rows={4}
              />
              <div className="reject-reason-actions">
                <button className="cancel-button" onClick={handleCloseRejectReasonModal}>
                  Cancel
                </button>
                <button className="submit-button" onClick={handleSaveRejectReason}>
                  Save Reason
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Request
