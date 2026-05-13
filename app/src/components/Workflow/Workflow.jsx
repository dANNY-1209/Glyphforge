import { useState, useEffect, useRef } from 'react'
import AdminLogin from '../Gallery/Admin/AdminLogin'
import './Workflow.css'

const API_BASE = '/api'

export default function Workflow({ isLoggedIn, adminMode, onAdminLoginSuccess, onAdminLogout, onAdminModeToggle }) {
  const [workflows, setWorkflows] = useState([])
  const [loading, setLoading] = useState(true)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingWorkflow, setEditingWorkflow] = useState(null)
  const [formData, setFormData] = useState({ name: '', description: '' })
  const [pendingFiles, setPendingFiles] = useState({ workflow: null, attachments: [] })
  const [filesToDelete, setFilesToDelete] = useState([]) // Files marked for deletion
  const [currentWorkflowFile, setCurrentWorkflowFile] = useState(null) // Track current workflow file state
  const [currentAttachments, setCurrentAttachments] = useState([]) // Track current attachments state
  const [dragOverArea, setDragOverArea] = useState(null)
  const [draggingId, setDraggingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [editNote, setEditNote] = useState('')
  
  const fileInputRef = useRef(null)
  const attachmentInputRef = useRef(null)

  // Fetch workflows
  useEffect(() => {
    fetchWorkflows()
  }, [])

  const fetchWorkflows = async () => {
    try {
      setLoading(true)
      const res = await fetch(`${API_BASE}/workflows`)
      const data = await res.json()
      setWorkflows(data)
    } catch (error) {
      console.error('Failed to fetch workflows:', error)
    } finally {
      setLoading(false)
    }
  }

  const getAuthHeaders = () => {
    const token = localStorage.getItem('adminToken')
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  // Open modal for new workflow
  const handleAddWorkflow = () => {
    setEditingWorkflow(null)
    setFormData({ name: '', description: '' })
    setPendingFiles({ workflow: null, attachments: [] })
    setFilesToDelete([])
    setCurrentWorkflowFile(null)
    setCurrentAttachments([])
    setShowModal(true)
  }

  // Open modal for editing
  const handleEditWorkflow = (workflow) => {
    setEditingWorkflow(workflow)
    setFormData({ name: workflow.name, description: workflow.description || '' })
    setPendingFiles({ workflow: null, attachments: [] })
    setFilesToDelete([])
    setCurrentWorkflowFile(workflow.workflowFile || null)
    setCurrentAttachments(workflow.attachments || [])
    setEditNote('')
    setShowModal(true)
  }

  // Close modal
  const handleCloseModal = () => {
    setShowModal(false)
    setEditingWorkflow(null)
    setFormData({ name: '', description: '' })
    setPendingFiles({ workflow: null, attachments: [] })
    setFilesToDelete([])
    setCurrentWorkflowFile(null)
    setCurrentAttachments([])
    setEditNote('')
  }

  // Handle file selection
  const handleWorkflowFileSelect = (e) => {
    const file = e.target.files[0]
    if (file) {
      setPendingFiles(prev => ({ ...prev, workflow: file }))
    }
  }

  const handleAttachmentSelect = (e) => {
    const files = Array.from(e.target.files)
    setPendingFiles(prev => ({
      ...prev,
      attachments: [...prev.attachments, ...files]
    }))
  }

  // Remove pending file
  const removePendingWorkflow = () => {
    setPendingFiles(prev => ({ ...prev, workflow: null }))
  }

  const removePendingAttachment = (index) => {
    setPendingFiles(prev => ({
      ...prev,
      attachments: prev.attachments.filter((_, i) => i !== index)
    }))
  }

  // Save workflow
  const handleSaveWorkflow = async () => {
    if (!formData.name.trim()) return

    setSaving(true)
    try {
      let workflowId = editingWorkflow?.id

      // Create or update workflow
      if (editingWorkflow) {
        await fetch(`${API_BASE}/workflows/${workflowId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ ...formData, editNote })
        })
      } else {
        const res = await fetch(`${API_BASE}/workflows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify(formData)
        })
        const newWorkflow = await res.json()
        workflowId = newWorkflow.id
      }

      // Delete files marked for deletion
      for (const filename of filesToDelete) {
        try {
          await fetch(`${API_BASE}/workflows/${workflowId}/file/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
          })
        } catch (error) {
          console.error(`Failed to delete file ${filename}:`, error)
        }
      }

      // Upload workflow file
      if (pendingFiles.workflow) {
        const formDataUpload = new FormData()
        formDataUpload.append('file', pendingFiles.workflow)
        formDataUpload.append('fileType', 'workflow')
        await fetch(`${API_BASE}/workflows/${workflowId}/upload`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formDataUpload
        })
      }

      // Upload attachments
      for (const file of pendingFiles.attachments) {
        const formDataUpload = new FormData()
        formDataUpload.append('file', file)
        formDataUpload.append('fileType', 'attachment')
        await fetch(`${API_BASE}/workflows/${workflowId}/upload`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formDataUpload
        })
      }

      handleCloseModal()
      fetchWorkflows()
    } catch (error) {
      console.error('Failed to save workflow:', error)
    } finally {
      setSaving(false)
    }
  }

  // Delete workflow
  const handleDeleteWorkflow = async (id) => {
    if (!confirm('Are you sure you want to delete this workflow?')) return

    try {
      await fetch(`${API_BASE}/workflows/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      })
      fetchWorkflows()
    } catch (error) {
      console.error('Failed to delete workflow:', error)
    }
  }

  // Mark file for deletion (will be deleted on save)
  const handleMarkFileForDeletion = (filename, isWorkflowFile = false) => {
    setFilesToDelete(prev => [...prev, filename])
    if (isWorkflowFile) {
      setCurrentWorkflowFile(null)
    } else {
      setCurrentAttachments(prev => prev.filter(f => f !== filename))
    }
  }

  // Restore a file marked for deletion
  const handleRestoreFile = (filename, isWorkflowFile = false) => {
    setFilesToDelete(prev => prev.filter(f => f !== filename))
    if (isWorkflowFile && editingWorkflow?.workflowFile === filename) {
      setCurrentWorkflowFile(filename)
    } else if (!isWorkflowFile && editingWorkflow?.attachments?.includes(filename)) {
      setCurrentAttachments(prev => [...prev, filename])
    }
  }

  // Handle admin button click
  const handleAdminClick = () => {
    if (isLoggedIn) {
      onAdminModeToggle()
    } else {
      setShowLoginModal(true)
    }
  }

  // Handle login success
  const handleLoginSuccess = (token) => {
    setShowLoginModal(false)
    onAdminLoginSuccess(token)
  }

  // Drag and drop for reordering
  const handleDragStart = (e, id) => {
    if (!adminMode) return
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e, id) => {
    e.preventDefault()
    if (!adminMode || id === draggingId) return
  }

  const handleDrop = async (e, targetId) => {
    e.preventDefault()
    if (!adminMode || !draggingId || draggingId === targetId) return

    const dragIndex = workflows.findIndex(w => w.id === draggingId)
    const dropIndex = workflows.findIndex(w => w.id === targetId)
    
    const newWorkflows = [...workflows]
    const [removed] = newWorkflows.splice(dragIndex, 1)
    newWorkflows.splice(dropIndex, 0, removed)
    
    setWorkflows(newWorkflows)
    setDraggingId(null)

    // Save new order
    try {
      await fetch(`${API_BASE}/workflows/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ orderedIds: newWorkflows.map(w => w.id) })
      })
    } catch (error) {
      console.error('Failed to reorder:', error)
      fetchWorkflows()
    }
  }

  const handleDragEnd = () => {
    setDraggingId(null)
  }

  // Get file extension icon
  const getFileIcon = (filename) => {
    const ext = filename.split('.').pop().toLowerCase()
    if (ext === 'json') return '📋'
    if (['safetensors', 'pt', 'pth', 'ckpt'].includes(ext)) return '🎨'
    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return '🖼️'
    if (['txt', 'yaml', 'yml'].includes(ext)) return '📝'
    return '📦'
  }

  return (
    <div className="workflow-container">
      <div className="workflow-header">
        <div className="workflow-header-info">
          <h2>Workflow Library</h2>
          <p>ComfyUI workflows and associated files</p>
        </div>
        <div className="workflow-header-actions">
          {adminMode && (
            <button className="admin-toggle-btn active" onClick={handleAddWorkflow}>
              + New Workflow
            </button>
          )}
          <button
            className={`admin-toggle-btn ${adminMode ? 'active' : ''}`}
            onClick={handleAdminClick}
            title={isLoggedIn ? (adminMode ? 'Exit Admin Mode' : 'Enter Admin Mode') : 'Admin Login'}
          >
            {adminMode ? '🔓 Admin Mode' : (isLoggedIn ? '🔒 Admin' : '🔐 Login')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="workflow-loading">Loading workflows...</div>
      ) : workflows.length === 0 ? (
        <div className="workflow-empty">
          <div className="workflow-empty-icon">🔧</div>
          <p>No workflows yet</p>
        </div>
      ) : (
        <div className="workflow-list">
          {workflows.map(workflow => (
            <div
              key={workflow.id}
              className={`workflow-card ${draggingId === workflow.id ? 'dragging' : ''}`}
              draggable={adminMode}
              onDragStart={(e) => handleDragStart(e, workflow.id)}
              onDragOver={(e) => handleDragOver(e, workflow.id)}
              onDrop={(e) => handleDrop(e, workflow.id)}
              onDragEnd={handleDragEnd}
            >
              {adminMode && (
                <div className="workflow-drag-handle">⋮⋮</div>
              )}
              
              <div className="workflow-icon">🔧</div>
              
              <div className="workflow-info">
                <h3 className="workflow-name">{workflow.name}</h3>
                {workflow.description && (
                  <p className="workflow-description">{workflow.description}</p>
                )}
                
                <div className="workflow-files">
                  {/* Main Workflow File */}
                  {workflow.workflowFile && (
                    <div className="workflow-files-section">
                      <a
                        href={`${API_BASE}/workflows/${workflow.id}/download/${encodeURIComponent(workflow.workflowFile)}`}
                        className="workflow-file-card main-workflow"
                        title="Download workflow file"
                      >
                        <span className="file-card-icon">{getFileIcon(workflow.workflowFile)}</span>
                        <span className="file-card-name">{workflow.workflowFile}</span>
                        <span className="file-card-download">⬇</span>
                      </a>
                    </div>
                  )}
                  
                  {/* Attachment Files */}
                  {workflow.attachments?.length > 0 && (
                    <div className="workflow-files-section attachments">
                      {workflow.attachments.map((file, index) => (
                        <a
                          key={index}
                          href={`${API_BASE}/workflows/${workflow.id}/download/${encodeURIComponent(file)}`}
                          className="workflow-file-card"
                          title="Download attachment"
                        >
                          <span className="file-card-icon">{getFileIcon(file)}</span>
                          <span className="file-card-name">{file}</span>
                          <span className="file-card-download">⬇</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              
              {adminMode && (
                <div className="workflow-actions">
                  <button
                    className="workflow-action-btn edit"
                    onClick={() => handleEditWorkflow(workflow)}
                  >
                    ✏️ Edit
                  </button>
                  <button
                    className="workflow-action-btn delete"
                    onClick={() => handleDeleteWorkflow(workflow.id)}
                  >
                    🗑️ Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="workflow-modal-overlay" onClick={handleCloseModal}>
          <div className="workflow-modal" onClick={e => e.stopPropagation()}>
            <button className="workflow-modal-close" onClick={handleCloseModal}>×</button>
            
            <h2>{editingWorkflow ? 'Edit Workflow' : 'New Workflow'}</h2>
            
            <div className="workflow-form">
              <div className="form-field">
                <label>
                  Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Workflow name"
                />
              </div>
              
              <div className="form-field">
                <label>Description</label>
                <textarea
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Optional description"
                />
              </div>
              
              {/* Workflow File */}
              <div className="file-upload-section">
                <h3>Workflow File (.json)</h3>
                
                {/* Show current workflow file (not marked for deletion) */}
                {currentWorkflowFile && !pendingFiles.workflow && (
                  <div className="uploaded-files">
                    <div className="uploaded-file-item">
                      <div className="uploaded-file-info">
                        <span className="uploaded-file-icon">📋</span>
                        <span className="uploaded-file-name">{currentWorkflowFile}</span>
                        <span className="uploaded-file-type">CURRENT</span>
                      </div>
                      <button
                        className="uploaded-file-delete"
                        onClick={() => handleMarkFileForDeletion(currentWorkflowFile, true)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}
                
                {/* Show new pending workflow file */}
                {pendingFiles.workflow ? (
                  <div className="uploaded-files">
                    <div className="uploaded-file-item">
                      <div className="uploaded-file-info">
                        <span className="uploaded-file-icon">📄</span>
                        <span className="uploaded-file-name">{pendingFiles.workflow.name}</span>
                        <span className="uploaded-file-type">NEW</span>
                      </div>
                      <button className="uploaded-file-delete" onClick={removePendingWorkflow}>
                        ×
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className={`file-drop-area ${dragOverArea === 'workflow' ? 'dragover' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragOverArea('workflow') }}
                    onDragLeave={() => setDragOverArea(null)}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDragOverArea(null)
                      const file = e.dataTransfer.files[0]
                      if (file) setPendingFiles(prev => ({ ...prev, workflow: file }))
                    }}
                  >
                    <div className="drop-icon">📄</div>
                    <p>Drop workflow file here or click to browse</p>
                    <small>Accepts .json files</small>
                  </div>
                )}
                
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleWorkflowFileSelect}
                  style={{ display: 'none' }}
                />
              </div>
              
              {/* Attachments */}
              <div className="file-upload-section">
                <h3>Attachments</h3>
                
                {/* Current attachments (not marked for deletion) */}
                {currentAttachments.length > 0 && (
                  <div className="uploaded-files">
                    <h4>Current files:</h4>
                    {currentAttachments.map((file, index) => (
                      <div key={index} className="uploaded-file-item">
                        <div className="uploaded-file-info">
                          <span className="uploaded-file-icon">{getFileIcon(file)}</span>
                          <span className="uploaded-file-name">{file}</span>
                          <span className="uploaded-file-type">CURRENT</span>
                        </div>
                        <button
                          className="uploaded-file-delete"
                          onClick={() => handleMarkFileForDeletion(file, false)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                
                {/* Files marked for deletion (show with restore option) */}
                {filesToDelete.length > 0 && (
                  <div className="uploaded-files files-to-delete">
                    <h4>Will be deleted on save:</h4>
                    {filesToDelete.map((file, index) => (
                      <div key={index} className="uploaded-file-item marked-delete">
                        <div className="uploaded-file-info">
                          <span className="uploaded-file-icon">{getFileIcon(file)}</span>
                          <span className="uploaded-file-name">{file}</span>
                          <span className="uploaded-file-type delete">DELETE</span>
                        </div>
                        <button
                          className="uploaded-file-restore"
                          onClick={() => handleRestoreFile(file, editingWorkflow?.workflowFile === file)}
                          title="Restore file"
                        >
                          ↩
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                
                {/* Pending attachments */}
                {pendingFiles.attachments.length > 0 && (
                  <div className="uploaded-files">
                    <h4>New files to upload:</h4>
                    {pendingFiles.attachments.map((file, index) => (
                      <div key={index} className="uploaded-file-item">
                        <div className="uploaded-file-info">
                          <span className="uploaded-file-icon">{getFileIcon(file.name)}</span>
                          <span className="uploaded-file-name">{file.name}</span>
                          <span className="uploaded-file-type">NEW</span>
                        </div>
                        <button
                          className="uploaded-file-delete"
                          onClick={() => removePendingAttachment(index)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                
                <div
                  className={`file-drop-area ${dragOverArea === 'attachment' ? 'dragover' : ''}`}
                  onClick={() => attachmentInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOverArea('attachment') }}
                  onDragLeave={() => setDragOverArea(null)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOverArea(null)
                    const files = Array.from(e.dataTransfer.files)
                    setPendingFiles(prev => ({
                      ...prev,
                      attachments: [...prev.attachments, ...files]
                    }))
                  }}
                >
                  <div className="drop-icon">📎</div>
                  <p>Drop files here or click to browse</p>
                  <small>.safetensors, images, or any other files</small>
                </div>
                
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  onChange={handleAttachmentSelect}
                  style={{ display: 'none' }}
                />
              </div>
              
              {editingWorkflow && (
                <div className="edit-note-block">
                  <label className="edit-note-label" htmlFor="edit-note-workflow">Change note (optional)</label>
                  <div className="edit-note-hint">
                    Shown in the Discord notification. Leave blank to auto-list the changed fields.
                  </div>
                  <textarea
                    id="edit-note-workflow"
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    maxLength={500}
                    placeholder="Describe what you changed and why…"
                  />
                </div>
              )}

              <div className="form-actions">
                <button className="btn-cancel" onClick={handleCloseModal}>
                  Cancel
                </button>
                <button
                  className="btn-save"
                  onClick={handleSaveWorkflow}
                  disabled={!formData.name.trim() || saving}
                >
                  {saving ? 'Saving...' : (editingWorkflow ? 'Save Changes' : 'Create Workflow')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Admin Login Modal */}
      {showLoginModal && (
        <AdminLogin
          onLoginSuccess={handleLoginSuccess}
          onClose={() => setShowLoginModal(false)}
        />
      )}
    </div>
  )
}
