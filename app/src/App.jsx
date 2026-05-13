import React, { useState, useEffect, useRef, useMemo } from 'react'
import './App.css'
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import Gallery from './components/Gallery/Gallery'
import Request from './components/Request/Request'
import Changelog from './components/Changelog/Changelog'
import Workflow from './components/Workflow/Workflow'
import AdminUsersPanel from './components/Auth/AdminUsersPanel'
import LoginButton from './components/Auth/LoginButton'
import AccessGate from './components/Auth/AccessGate'
import { useAuth } from './auth/AuthContext'
import { useDataCache } from './hooks/useDataCache'
import { ToastProvider } from './components/Toast/ToastContext'

// Helper to get CSS variable value
const getCSSVar = (name) => {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Theme colors hook
const useThemeColors = () => {
  const [colors, setColors] = useState({})
  
  useEffect(() => {
    const updateColors = () => {
      setColors({
        textPrimary: getCSSVar('--text-primary') || '#E0E0E0',
        textSecondary: getCSSVar('--text-secondary') || '#909090',
        textMuted: getCSSVar('--text-muted') || '#666666',
        chartPrimary: getCSSVar('--chart-primary') || '#A0A0A0',
        chartSecondary: getCSSVar('--chart-secondary') || '#707070',
        chartGrid: getCSSVar('--chart-grid') || 'rgba(255, 255, 255, 0.1)',
        chartAxis: getCSSVar('--chart-axis') || '#808080',
        chartBar1: getCSSVar('--chart-bar-1') || '#909090',
        chartBar2: getCSSVar('--chart-bar-2') || '#707070',
        chartPie1: getCSSVar('--chart-pie-1') || '#A0A0A0',
        chartPie2: getCSSVar('--chart-pie-2') || '#808080',
        chartPie3: getCSSVar('--chart-pie-3') || '#606060',
        chartPie4: getCSSVar('--chart-pie-4') || '#909090',
        chartPie5: getCSSVar('--chart-pie-5') || '#505050',
        chartCostume: getCSSVar('--chart-costume') || '#c0a090',
        tooltipBg: getCSSVar('--tooltip-bg') || 'rgba(30, 30, 30, 0.98)',
        tooltipBorder: getCSSVar('--tooltip-border') || 'rgba(80, 80, 80, 0.5)',
        successGreen: getCSSVar('--success-green') || '#4ade80',
        warningOrange: getCSSVar('--warning-orange') || '#fb923c',
        errorRed: getCSSVar('--error-red') || '#f87171',
      })
    }
    
    updateColors()
    // Re-read colors if theme changes
    const observer = new MutationObserver(updateColors)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    
    return () => observer.disconnect()
  }, [])
  
  return colors
}

function App() {
  // Theme colors for charts
  const themeColors = useThemeColors()
  
  const [activeTab, setActiveTab] = useState(() => {
    // Load from localStorage, default to 'lora' for new users
    return localStorage.getItem('activeTab') || 'lora'
  })
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [selectedPrompt, setSelectedPrompt] = useState(null)
  const [selectedCostume, setSelectedCostume] = useState(null)
  const [selectedLora, setSelectedLora] = useState(null)
  const [selectedLoraVersion, setSelectedLoraVersion] = useState(null)
  const [isVersionDropdownOpen, setIsVersionDropdownOpen] = useState(false)
  const [statistics, setStatistics] = useState(null)
  const [sensitivityFilter, setSensitivityFilter] = useState(() => {
    // Load from localStorage, default to 'sfw' for new users
    return localStorage.getItem('sensitivityFilter') || 'sfw'
  })
  const [characterFilter, setCharacterFilter] = useState('all')
  const [placeFilter, setPlaceFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [viewFilter, setViewFilter] = useState('all')
  const [nudityFilter, setNudityFilter] = useState('all')
  const [openDropdown, setOpenDropdown] = useState(null)
  const [isFilterExpanded, setIsFilterExpanded] = useState(false)

  // LoRA filters
  const [loraGenderFilter, setLoraGenderFilter] = useState('all')
  const [loraModelFilter, setLoraModelFilter] = useState('all')
  const [loraCompanyFilter, setLoraCompanyFilter] = useState('all')
  const [loraGroupFilter, setLoraGroupFilter] = useState('all')
  const [loraCharacterFilter, setLoraCharacterFilter] = useState('all')
  const [loraCharacterCountFilter, setLoraCharacterCountFilter] = useState('all')
  const [isLoraFilterExpanded, setIsLoraFilterExpanded] = useState(false)
  const [collapsedLoraCompanies, setCollapsedLoraCompanies] = useState(new Set())

  // Sort options
  const [promptSortBy, setPromptSortBy] = useState('default')
  const [loraSortBy, setLoraSortBy] = useState('default')

  // Help modal
  const [showHelpModal, setShowHelpModal] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState('')

  // Prompt edit mode
  const [isEditingPrompt, setIsEditingPrompt] = useState(false)
  const [isCreatingPrompt, setIsCreatingPrompt] = useState(false)
  const [editPromptData, setEditPromptData] = useState(null)

  // Shared "change note" for any edit modal. Sent as `editNote` in PUT bodies
  // so the Discord notification can describe what changed in the admin's
  // own words. Cleared on every modal close.
  const [editNote, setEditNote] = useState('')

  // Costume edit mode
  const [isEditingCostume, setIsEditingCostume] = useState(false)
  const [isCreatingCostume, setIsCreatingCostume] = useState(false)
  const [editCostumeData, setEditCostumeData] = useState(null)
  const [pendingCostumeImages, setPendingCostumeImages] = useState([null, null])

  // LoRA edit mode
  const [isEditingLora, setIsEditingLora] = useState(false)
  const [isCreatingLora, setIsCreatingLora] = useState(false)
  const [editLoraData, setEditLoraData] = useState(null)
  const [pendingLoraThumbnail, setPendingLoraThumbnail] = useState(null) // 0.png (shared)
  const [pendingLoraVersionImages, setPendingLoraVersionImages] = useState({}) // { 'illustrious': [file1, file2], 'haruka': [file1, file2] }
  const [pendingLoraSafetensors, setPendingLoraSafetensors] = useState({}) // { versionName: File }
  const [editLoraSelectedVersion, setEditLoraSelectedVersion] = useState(0) // index of selected model version
  const loraImageInputRef = useRef(null)
  const loraSafetensorsInputRef = useRef(null)
  const [uploadingLoraImageIndex, setUploadingLoraImageIndex] = useState(null)

  // Fn LoRA state
  const [fnLoraTypeFilter, setFnLoraTypeFilter] = useState('all')
  const [fnLoraModelFilter, setFnLoraModelFilter] = useState('all')
  const [isFnLoraFilterExpanded, setIsFnLoraFilterExpanded] = useState(false)
  const [selectedFnLora, setSelectedFnLora] = useState(null)
  const [selectedFnLoraVersion, setSelectedFnLoraVersion] = useState(0)

  // Fn LoRA edit mode
  const [isEditingFnLora, setIsEditingFnLora] = useState(false)
  const [isCreatingFnLora, setIsCreatingFnLora] = useState(false)
  const [editFnLoraData, setEditFnLoraData] = useState(null)
  const [pendingFnLoraThumbnail, setPendingFnLoraThumbnail] = useState(null)
  const [pendingFnLoraVersionImages, setPendingFnLoraVersionImages] = useState({})
  const [pendingFnLoraSafetensors, setPendingFnLoraSafetensors] = useState({}) // { versionName: File }
  const [editFnLoraSelectedVersion, setEditFnLoraSelectedVersion] = useState(0)
  const fnLoraImageInputRef = useRef(null)
  const fnLoraSafetensorsInputRef = useRef(null)

  // Background upload tracking for Fn LoRA
  const [backgroundUploads, setBackgroundUploads] = useState({}) // { fnLoraId: { status: 'uploading'|'done'|'error', fileName: string, progress?: number } }

  // Costume category state
  const [collapsedCostumeTypes, setCollapsedCostumeTypes] = useState(() => {
    try {
      const saved = localStorage.getItem('costume-collapsed-types')
      return saved ? new Set(JSON.parse(saved)) : new Set()
    } catch {
      return new Set()
    }
  })
  const [draggingCostumeType, setDraggingCostumeType] = useState(null)
  const [draggingCostume, setDraggingCostume] = useState(null)
  const [draggingCostumeFromType, setDraggingCostumeFromType] = useState(null)
  const costumeImageInputRef = useRef(null)
  const [uploadingCostumeImageIndex, setUploadingCostumeImageIndex] = useState(null)
  // Retained for any legacy references; no longer used (Discord OAuth via <LoginButton>).
  const [showPromptLogin, setShowPromptLogin] = useState(false)
  
  // Notification state
  const [notifications, setNotifications] = useState({ version: 0, updates: [] })
  const [showNotifications, setShowNotifications] = useState(false)
  const [lastSeenVersion, setLastSeenVersion] = useState(() => {
    return parseInt(localStorage.getItem('glyphforge_notifications_seen') || '0', 10)
  })
  const notificationRef = useRef(null)
  
  const imageInputRef = useRef(null)
  const [uploadingImageIndex, setUploadingImageIndex] = useState(null)
  const [pendingImages, setPendingImages] = useState([null, null]) // Store File objects for upload

  // Track if mousedown started on overlay (for proper drag-to-close prevention)
  const overlayMouseDownRef = useRef(false)
  const handleOverlayMouseDown = (e) => {
    overlayMouseDownRef.current = e.target === e.currentTarget
  }
  const handleOverlayClick = (e, closeFunc) => {
    if (e.target === e.currentTarget && overlayMouseDownRef.current) {
      closeFunc()
    }
    overlayMouseDownRef.current = false
  }
  const [promptFieldOptions, setPromptFieldOptions] = useState({
    place: [],
    type: [],
    view: [],
    nudity: []
  })

  // Scroll to top button visibility
  const [showScrollTop, setShowScrollTop] = useState(false)

  // Auth — Discord OAuth + whitelist. `isLoggedIn` here means "is admin"
  // so we can keep the legacy admin-mode UI affordances. Non-admin logged-in
  // users are gated by AccessGate, not by this flag.
  const auth = useAuth()
  const isLoggedIn = auth.isAdmin
  const [adminMode, setAdminMode] = useState(false)

  // Defensive: if the user lost admin (server demotion / token expiry),
  // drop adminMode immediately so write UIs disappear.
  useEffect(() => {
    if (!auth.isAdmin && adminMode) setAdminMode(false)
  }, [auth.isAdmin, adminMode])

  // Use data cache for prompts and loras
  const promptsCache = useDataCache('prompts', async () => {
    const response = await fetch('/api/prompts')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  }, { revalidateOnMount: true })

  const lorasCache = useDataCache('loras', async () => {
    const response = await fetch('/api/loras')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  }, { revalidateOnMount: true })

  const costumesCache = useDataCache('costumes', async () => {
    const response = await fetch('/api/costumes')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    // New API returns { costumes, metadata }
    if (data.costumes && data.metadata) {
      return data
    }
    // Fallback for old API format
    return { costumes: data, metadata: { typeOrder: [], costumeOrder: {} } }
  }, { revalidateOnMount: true })

  const fnLorasCache = useDataCache('fnLoras', async () => {
    const response = await fetch('/api/fn-loras')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  }, { revalidateOnMount: true })

  const prompts = promptsCache.data || []
  const loras = lorasCache.data || []
  const fnLoras = fnLorasCache.data || []
  const costumesData = costumesCache.data || { costumes: [], metadata: { typeOrder: [], costumeOrder: {} } }
  const costumes = costumesData.costumes || []
  const costumeMetadata = costumesData.metadata || { typeOrder: [], costumeOrder: {} }

  // Save sensitivity filter to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('sensitivityFilter', sensitivityFilter)
  }, [sensitivityFilter])

  // Save active tab to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('activeTab', activeTab)
  }, [activeTab])

  // Load notifications on mount
  useEffect(() => {
    const loadNotifications = async () => {
      try {
        const response = await fetch('/api/notifications')
        if (!response.ok) return
        const data = await response.json()
        if (data && Array.isArray(data.updates)) setNotifications(data)
      } catch (error) {
        console.error('Failed to load notifications:', error)
      }
    }
    loadNotifications()
  }, [])

  // Track the version when dropdown was opened (to show unread indicators)
  const openedAtVersionRef = useRef(lastSeenVersion)
  
  // Use refs to track latest values for the click outside handler
  const showNotificationsRef = useRef(showNotifications)
  const notificationsVersionRef = useRef(notifications.version)
  const lastSeenVersionRef = useRef(lastSeenVersion)
  
  // Keep refs in sync with state
  useEffect(() => {
    showNotificationsRef.current = showNotifications
  }, [showNotifications])
  
  useEffect(() => {
    notificationsVersionRef.current = notifications.version
  }, [notifications.version])
  
  useEffect(() => {
    lastSeenVersionRef.current = lastSeenVersion
  }, [lastSeenVersion])
  
  // Helper function to mark notifications as read
  const markNotificationsAsRead = () => {
    const currentVersion = notificationsVersionRef.current
    const currentLastSeen = lastSeenVersionRef.current
    if (currentVersion > currentLastSeen) {
      localStorage.setItem('glyphforge_notifications_seen', currentVersion.toString())
      setLastSeenVersion(currentVersion)
    }
  }

  // Handle click outside notification dropdown
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notificationRef.current && !notificationRef.current.contains(event.target)) {
        // Mark notifications as read when closing by clicking outside
        if (showNotificationsRef.current) {
          markNotificationsAsRead()
        }
        setShowNotifications(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])
  
  // Mark notifications as seen when dropdown is closed
  const handleNotificationClick = () => {
    if (!showNotifications) {
      // Opening: remember current lastSeenVersion for unread indicators
      openedAtVersionRef.current = lastSeenVersion
    } else {
      // Closing: mark all as read
      markNotificationsAsRead()
    }
    setShowNotifications(!showNotifications)
  }

  // Check if there are unread notifications
  const hasUnreadNotifications = notifications.version > lastSeenVersion

  // Format notification timestamp
  const formatNotificationTime = (timestamp) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now - date
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    
    if (diffDays === 0) {
      return 'Today'
    } else if (diffDays === 1) {
      return 'Yesterday'
    } else if (diffDays < 7) {
      return `${diffDays} days ago`
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
  }

  // Save costume collapsed types to localStorage
  useEffect(() => {
    localStorage.setItem('costume-collapsed-types', JSON.stringify([...collapsedCostumeTypes]))
  }, [collapsedCostumeTypes])

  useEffect(() => {
    const loadStatistics = async () => {
      try {
        const response = await fetch(`/api/statistics?sensitivity=${sensitivityFilter}`)
        const data = await response.json()
        setStatistics(data)
      } catch (error) {
        console.error('Failed to load statistics:', error)
        setStatistics(null)
      }
    }
    if (activeTab === 'statistics') {
      loadStatistics()
    }
  }, [activeTab, sensitivityFilter])

  // Handle ESC key to close popups
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        if (isEditingPrompt) {
          handleCloseEditPrompt()
        }
        if (isEditingCostume) {
          handleCloseEditCostume()
        }
        if (selectedPrompt) {
          setSelectedPrompt(null)
        }
        if (selectedCostume) {
          setSelectedCostume(null)
        }
        if (selectedLora) {
          setSelectedLora(null)
          setSelectedLoraVersion(null)
        }
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [selectedPrompt, selectedCostume, selectedLora, isEditingPrompt, isEditingCostume])

  // Handle scroll to show/hide scroll-to-top button
  useEffect(() => {
    const handleScroll = () => {
      // Show button when scrolled down more than 300px
      if (window.scrollY > 300) {
        setShowScrollTop(true)
      } else {
        setShowScrollTop(false)
      }
    }

    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Load prompt field options for dynamic dropdowns
  useEffect(() => {
    const loadFieldOptions = async () => {
      try {
        const response = await fetch('/api/prompts/fields')
        if (!response.ok) return
        const data = await response.json()
        if (data && typeof data === 'object' && !data.error) {
          console.log('Loaded field options:', data) // Debug
          setPromptFieldOptions(data)
        }
      } catch (error) {
        console.error('Failed to load prompt field options:', error)
      }
    }
    loadFieldOptions()
  }, []) // Load on mount

  // Reload field options when prompts change
  useEffect(() => {
    if (prompts && prompts.length > 0) {
      fetch('/api/prompts/fields')
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && typeof data === 'object' && !data.error) {
            setPromptFieldOptions(data)
          }
        })
        .catch(err => console.error('Failed to reload field options:', err))
    }
  }, [prompts])

  // Initialize selected version when LoRA is selected
  useEffect(() => {
    if (selectedLora && selectedLora.versions && selectedLora.versions.length > 0) {
      // Prefer illustrious version, fallback to first version
      const illustriousVersion = selectedLora.versions.find(v =>
        v.name.toLowerCase() === 'illustrious'
      )
      setSelectedLoraVersion(illustriousVersion || selectedLora.versions[0])
    } else {
      setSelectedLoraVersion(null)
    }
  }, [selectedLora])

  const handleCopyPrompt = async (promptText, itemId, itemType) => {
    try {
      await navigator.clipboard.writeText(promptText)
      showCopyToast()

      // Increment copy counter
      if (itemId && itemType) {
        let endpoint
        if (itemType === 'prompt') {
          endpoint = `/api/prompts/${itemId}/copy`
        } else if (itemType === 'costume') {
          endpoint = `/api/costumes/${itemId}/copy`
        } else {
          endpoint = `/api/loras/${itemId}/copy`
        }
        await fetch(endpoint, { method: 'POST' })
      }
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  const handleDownload = async (loraId, version) => {
    try {
      // Trigger download
      const link = document.createElement('a')
      link.href = version.filePath
      link.download = version.fileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      // Increment download counter
      await fetch(`/api/loras/${loraId}/download`, { method: 'POST' })
    } catch (error) {
      console.error('Failed to download:', error)
    }
  }

  // Legacy admin-login callback shim — Discord OAuth now handles login.
  // Kept as a no-op so child components don't crash if they still call it.
  const handleAdminLoginSuccess = () => {
    setAdminMode(true)
  }

  const handleAdminLogout = () => {
    setAdminMode(false)
    auth.logout()
  }

  const handleAdminModeToggle = () => {
    if (isLoggedIn) {
      setAdminMode(!adminMode)
    }
  }

  // Prompt admin handlers
  const handlePromptAdminClick = () => {
    if (isLoggedIn) {
      onPromptAdminModeToggle()
    } else {
      auth.login()
    }
  }

  const onPromptAdminModeToggle = () => {
    if (isLoggedIn) {
      setAdminMode(!adminMode)
    }
  }

  const handlePromptLoginSuccess = () => {
    setAdminMode(true)
  }

  const handleEditPrompt = (prompt) => {
    setEditPromptData({
      ...prompt,
      editedTitle: prompt.title || '',
      editedPrompt: prompt.prompt,
      editedNegativePrompt: prompt.negativePrompt || '',
      editedCharacter: prompt.character || 1,
      editedPlace: prompt.place || 'Unknown',
      editedSensitive: prompt.sensitive || 'SFW',
      editedType: prompt.type || 'Unknown',
      editedView: prompt.view || 'Unknown',
      editedNudity: prompt.nudity || 'Unknown',
      editedStability: prompt.stability || 1,
      editedAuthor: prompt.author || 'dANNY',
      editedImages: [...prompt.images],
      editedUsedFnLoras: prompt.usedFnLoras || []
    })
    setIsEditingPrompt(true)
    setIsCreatingPrompt(false)
  }

  const handleCreatePrompt = () => {
    setEditPromptData({
      id: null,
      editedTitle: '',
      editedPrompt: '',
      editedNegativePrompt: '',
      editedCharacter: 1,
      editedPlace: '',
      editedSensitive: 'SFW',
      editedType: '',
      editedView: '',
      editedNudity: '',
      editedStability: 1,
      editedAuthor: 'dANNY',
      editedImages: [],
      editedUsedFnLoras: []
    })
    setPendingImages([null, null])
    setIsEditingPrompt(true)
    setIsCreatingPrompt(true)
  }

  const handleCloseEditPrompt = () => {
    setIsEditingPrompt(false)
    setIsCreatingPrompt(false)
    setEditPromptData(null)
    setPendingImages([null, null])
    setEditNote('')
  }

  const handleUpdatePrompt = async () => {
    if (!editPromptData) return

    // Validation for required fields
    if (isCreatingPrompt && !editPromptData.editedTitle) {
      alert('Please enter a title for the prompt')
      return
    }
    if (!editPromptData.editedPlace || !editPromptData.editedType || !editPromptData.editedView || !editPromptData.editedNudity) {
      alert('Please fill in all required fields (Place, Type, View, Nudity)')
      return
    }

    setIsLoading(true)
    setLoadingMessage(isCreatingPrompt ? 'Creating prompt...' : 'Updating prompt...')

    try {
      const token = auth.token
      
      if (isCreatingPrompt) {
        // Validate: at least one image is required
        const hasImages = pendingImages.some(img => img !== null)
        if (!hasImages) {
          alert('Please upload at least one image')
          return
        }

        // Create new prompt
        const response = await fetch('/api/prompts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            title: editPromptData.editedTitle,
            prompt: editPromptData.editedPrompt,
            negativePrompt: editPromptData.editedNegativePrompt,
            character: parseInt(editPromptData.editedCharacter),
            place: editPromptData.editedPlace,
            sensitive: editPromptData.editedSensitive,
            type: editPromptData.editedType,
            view: editPromptData.editedView,
            nudity: editPromptData.editedNudity,
            stability: parseInt(editPromptData.editedStability),
            author: editPromptData.editedAuthor,
            usedFnLoras: editPromptData.editedUsedFnLoras || [],
            editNote
          })
        })

        if (response.ok) {
          const result = await response.json()
          
          // Upload pending images
          await uploadPendingImages(result.id)
          
          // Force reload prompts cache
          await promptsCache.loadData(true)
          handleCloseEditPrompt()
          showSavedToast()
        } else {
          alert('Failed to create prompt')
        }
      } else {
        // Update existing prompt
        const response = await fetch(`/api/prompts/${editPromptData.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            title: editPromptData.editedTitle,
            prompt: editPromptData.editedPrompt,
            negativePrompt: editPromptData.editedNegativePrompt,
            character: parseInt(editPromptData.editedCharacter),
            place: editPromptData.editedPlace,
            sensitive: editPromptData.editedSensitive,
            type: editPromptData.editedType,
            view: editPromptData.editedView,
            nudity: editPromptData.editedNudity,
            stability: parseInt(editPromptData.editedStability),
            author: editPromptData.editedAuthor,
            usedFnLoras: editPromptData.editedUsedFnLoras || [],
            editNote
          })
        })

        if (response.ok) {
          // Upload any pending images for edit mode
          const hasChangedImages = pendingImages.some(img => img !== null)
          if (hasChangedImages) {
            await uploadPendingImages(editPromptData.id)
          }
          
          // Force reload prompts cache
          await promptsCache.loadData(true)
          handleCloseEditPrompt()
          showSavedToast()
        } else {
          alert('Failed to update prompt')
        }
      }
    } catch (error) {
      console.error('Failed to save prompt:', error)
      alert('Failed to save prompt')
    } finally {
      setIsLoading(false)
      setLoadingMessage('')
    }
  }

  const handleImageClick = (index) => {
    if (!adminMode || !isEditingPrompt) return
    setUploadingImageIndex(index)
    imageInputRef.current?.click()
  }

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file || uploadingImageIndex === null || !editPromptData) return

    // Store file for later upload (both create and edit mode)
    const newPendingImages = [...pendingImages]
    newPendingImages[uploadingImageIndex] = file
    setPendingImages(newPendingImages)
    
    // Create preview URL and update display
    const previewUrl = URL.createObjectURL(file)
    const newImages = [...(editPromptData.editedImages || [])]
    
    // Ensure array has enough slots
    while (newImages.length <= uploadingImageIndex) {
      newImages.push(null)
    }
    // Replace the image at the clicked position
    newImages[uploadingImageIndex] = previewUrl
    
    setEditPromptData(prev => ({
      ...prev,
      editedImages: newImages.filter(img => img !== null)
    }))
    
    setUploadingImageIndex(null)
    if (imageInputRef.current) {
      imageInputRef.current.value = ''
    }
  }

  // Helper function to upload pending images after prompt creation
  const uploadPendingImages = async (promptId) => {
    const token = auth.token
    
    for (let i = 0; i < pendingImages.length; i++) {
      const file = pendingImages[i]
      if (!file) continue
      
      const formData = new FormData()
      formData.append('image', file)
      
      try {
        // imageIndex is now passed as URL param
        await fetch(`/api/prompts/${promptId}/image/${i}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          },
          body: formData
        })
      } catch (error) {
        console.error(`Failed to upload image ${i + 1}:`, error)
      }
    }
  }

  // Costume edit handlers
  const handleEditCostume = (costume) => {
    setEditCostumeData({
      ...costume,
      editedTitle: costume.title || '',
      editedCostumePrompt: costume.costumePrompt || '',  // Pure costume prompt
      editedPrompt: costume.prompt,  // Scene prompt
      editedCharacter: costume.character || 1,
      editedPlace: costume.place || 'Unknown',
      editedSensitive: costume.sensitive || 'SFW',
      editedType: costume.type || 'Costume',
      editedView: costume.view || 'Unknown',
      editedNudity: costume.nudity || 'Unknown',
      editedStability: costume.stability || 1,
      editedAuthor: costume.author || 'dANNY',
      editedImages: [...costume.images]
    })
    setIsEditingCostume(true)
    setIsCreatingCostume(false)
  }

  const handleCreateCostume = () => {
    setEditCostumeData({
      id: null,
      editedTitle: '',
      editedCostumePrompt: '',  // Pure costume prompt
      editedPrompt: '',  // Scene prompt
      editedCharacter: 1,
      editedPlace: '',
      editedSensitive: 'SFW',
      editedType: 'Costume',
      editedView: '',
      editedNudity: '',
      editedStability: 1,
      editedAuthor: 'dANNY',
      editedImages: []
    })
    setPendingCostumeImages([null, null])
    setIsEditingCostume(true)
    setIsCreatingCostume(true)
  }

  const handleCloseEditCostume = () => {
    setIsEditingCostume(false)
    setIsCreatingCostume(false)
    setEditCostumeData(null)
    setPendingCostumeImages([null, null])
    setEditNote('')
  }

  const handleUpdateCostume = async () => {
    if (!editCostumeData) return

    if (isCreatingCostume && !editCostumeData.editedTitle) {
      alert('Please enter a title for the costume')
      return
    }
    if (!editCostumeData.editedPlace || !editCostumeData.editedView || !editCostumeData.editedNudity) {
      alert('Please fill in all required fields (Place, View, Nudity)')
      return
    }

    setIsLoading(true)
    setLoadingMessage(isCreatingCostume ? 'Creating costume...' : 'Updating costume...')

    try {
      const token = auth.token
      
      if (isCreatingCostume) {
        const hasImages = pendingCostumeImages.some(img => img !== null)
        if (!hasImages) {
          alert('Please upload at least one image')
          return
        }

        const response = await fetch('/api/costumes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            title: editCostumeData.editedTitle,
            costumePrompt: editCostumeData.editedCostumePrompt,  // Pure costume prompt
            prompt: editCostumeData.editedPrompt,  // Scene prompt
            character: parseInt(editCostumeData.editedCharacter),
            place: editCostumeData.editedPlace,
            sensitive: editCostumeData.editedSensitive,
            type: editCostumeData.editedType || 'Costume',
            view: editCostumeData.editedView,
            nudity: editCostumeData.editedNudity,
            stability: parseInt(editCostumeData.editedStability),
            author: editCostumeData.editedAuthor
          })
        })

        if (response.ok) {
          const result = await response.json()
          await uploadPendingCostumeImages(result.id)
          await costumesCache.loadData(true)
          handleCloseEditCostume()
          showSavedToast()
        } else {
          alert('Failed to create costume')
        }
      } else {
        const response = await fetch(`/api/costumes/${editCostumeData.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            title: editCostumeData.editedTitle,
            costumePrompt: editCostumeData.editedCostumePrompt,  // Pure costume prompt
            prompt: editCostumeData.editedPrompt,  // Scene prompt
            character: parseInt(editCostumeData.editedCharacter),
            place: editCostumeData.editedPlace,
            sensitive: editCostumeData.editedSensitive,
            type: editCostumeData.editedType || 'Costume',
            view: editCostumeData.editedView,
            nudity: editCostumeData.editedNudity,
            stability: parseInt(editCostumeData.editedStability),
            author: editCostumeData.editedAuthor,
            editNote
          })
        })

        if (response.ok) {
          for (let i = 0; i < pendingCostumeImages.length; i++) {
            const file = pendingCostumeImages[i]
            if (!file) continue
            
            const formData = new FormData()
            formData.append('image', file)
            
            await fetch(`/api/costumes/${editCostumeData.id}/image/${i}`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`
              },
              body: formData
            })
          }
          
          await costumesCache.loadData(true)
          handleCloseEditCostume()
          showSavedToast()
        } else {
          alert('Failed to update costume')
        }
      }
    } catch (error) {
      console.error('Failed to save costume:', error)
      alert('Failed to save costume')
    } finally {
      setIsLoading(false)
      setLoadingMessage('')
    }
  }

  const handleCostumeImageClick = (index) => {
    if (!adminMode || !isEditingCostume) return
    setUploadingCostumeImageIndex(index)
    costumeImageInputRef.current?.click()
  }

  const handleCostumeImageUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file || uploadingCostumeImageIndex === null || !editCostumeData) return

    const newPendingImages = [...pendingCostumeImages]
    newPendingImages[uploadingCostumeImageIndex] = file
    setPendingCostumeImages(newPendingImages)
    
    const previewUrl = URL.createObjectURL(file)
    const newImages = [...(editCostumeData.editedImages || [])]
    
    while (newImages.length <= uploadingCostumeImageIndex) {
      newImages.push(null)
    }
    newImages[uploadingCostumeImageIndex] = previewUrl
    
    setEditCostumeData(prev => ({
      ...prev,
      editedImages: newImages.filter(img => img !== null)
    }))
    
    setUploadingCostumeImageIndex(null)
    if (costumeImageInputRef.current) {
      costumeImageInputRef.current.value = ''
    }
  }

  const uploadPendingCostumeImages = async (costumeId) => {
    const token = auth.token
    
    for (let i = 0; i < pendingCostumeImages.length; i++) {
      const file = pendingCostumeImages[i]
      if (!file) continue
      
      const formData = new FormData()
      formData.append('image', file)
      
      try {
        await fetch(`/api/costumes/${costumeId}/image/${i}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          },
          body: formData
        })
      } catch (error) {
        console.error(`Failed to upload costume image ${i + 1}:`, error)
      }
    }
  }

  // LoRA admin handlers
  const handleLoraAdminClick = () => {
    if (!isLoggedIn) {
      auth.login()
    } else {
      setAdminMode(!adminMode)
    }
  }

  const handleEditLora = (lora) => {
    // Use modelRaw (original array from meta.json) if available
    const modelArray = Array.isArray(lora.modelRaw) && lora.modelRaw.length > 0 
      ? lora.modelRaw 
      : (lora.versions?.map(v => ({ name: v.name, version: '' })) || [])
    
    setEditLoraData({
      ...lora,
      editedCharacter: lora.character || '',
      editedCloth: lora.cloth || '',
      editedCompany: lora.company || '',
      editedGroup: lora.group || '',
      editedGender: lora.gender || 'Girl',
      editedCharacterCount: lora.characterCount || 1,
      editedModel: modelArray,
      editedModelJson: JSON.stringify(modelArray, null, 2),
      editedLink: lora.link || '',
      editedPrompt: lora.prompt || ''
    })
    setPendingLoraThumbnail(null)
    setPendingLoraVersionImages({})
    setEditLoraSelectedVersion(0)
    setIsEditingLora(true)
    setIsCreatingLora(false)
  }

  const handleCreateLora = () => {
    const defaultModel = [{ name: 'Illustrious', version: 'v2.0' }]
    setEditLoraData({
      id: null,
      editedCharacter: '',
      editedCloth: '',
      editedCompany: '',
      editedGroup: '',
      editedGender: 'Girl',
      editedCharacterCount: 1,
      editedModel: defaultModel,
      editedModelJson: JSON.stringify(defaultModel, null, 2),
      editedLink: '',
      editedPrompt: ''
    })
    setPendingLoraThumbnail(null)
    setPendingLoraVersionImages({})
    setEditLoraSelectedVersion(0)
    setIsEditingLora(true)
    setIsCreatingLora(true)
  }

  const handleCloseEditLora = () => {
    setIsEditingLora(false)
    setIsCreatingLora(false)
    setEditLoraData(null)
    setPendingLoraThumbnail(null)
    setPendingLoraVersionImages({})
    setPendingLoraSafetensors({})
    setEditLoraSelectedVersion(0)
    setEditNote('')
  }

  const handleUpdateLora = async () => {
    if (!editLoraData) return

    if (!editLoraData.editedCharacter) {
      alert('Please enter a character name')
      return
    }

    // Parse model JSON if it was edited
    let modelData = editLoraData.editedModel
    if (editLoraData.editedModelJson) {
      try {
        modelData = JSON.parse(editLoraData.editedModelJson)
      } catch (e) {
        alert('Invalid model JSON format')
        return
      }
    }

    setIsLoading(true)
    setLoadingMessage(isCreatingLora ? 'Creating LoRA...' : 'Updating LoRA...')

    try {
      const token = auth.token
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }

      let loraId = editLoraData.id

      if (isCreatingLora) {
        // Create new LoRA
        const response = await fetch('/api/loras', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            character: editLoraData.editedCharacter,
            cloth: editLoraData.editedCloth,
            company: editLoraData.editedCompany,
            group: editLoraData.editedGroup,
            gender: editLoraData.editedGender,
            characterCount: parseInt(editLoraData.editedCharacterCount) || 1,
            model: modelData,
            link: editLoraData.editedLink,
            prompt: editLoraData.editedPrompt
          })
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error)
        loraId = data.id
      } else {
        // Update existing LoRA
        const response = await fetch(`/api/loras/${loraId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            character: editLoraData.editedCharacter,
            cloth: editLoraData.editedCloth,
            company: editLoraData.editedCompany,
            group: editLoraData.editedGroup,
            gender: editLoraData.editedGender,
            characterCount: parseInt(editLoraData.editedCharacterCount) || 1,
            model: modelData,
            link: editLoraData.editedLink,
            prompt: editLoraData.editedPrompt,
            editNote
          })
        })
        if (!response.ok) throw new Error('Failed to update LoRA')
      }

      // Upload thumbnail (0.png) - shared across versions
      if (pendingLoraThumbnail) {
        const formData = new FormData()
        formData.append('image', pendingLoraThumbnail)
        await fetch(`/api/loras/${loraId}/image/0`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData
        })
      }

      // Upload version-specific images
      for (const [versionName, images] of Object.entries(pendingLoraVersionImages)) {
        for (let i = 0; i < images.length; i++) {
          if (images[i]) {
            const formData = new FormData()
            // IMPORTANT: version must be appended BEFORE image for multer to read it in filename callback
            formData.append('version', versionName.toLowerCase())
            formData.append('image', images[i])
            await fetch(`/api/loras/${loraId}/image/${i + 1}`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` },
              body: formData
            })
          }
        }
      }

      // Check if there are safetensors to upload
      const safetensorsToUpload = Object.entries(pendingLoraSafetensors).filter(([_, file]) => file)
      
      if (safetensorsToUpload.length > 0) {
        // Close modal first, then upload in background
        await lorasCache.loadData(true)
        handleCloseEditLora()
        setIsLoading(false)
        setLoadingMessage('')
        
        // Start background upload
        const firstFile = safetensorsToUpload[0][1]
        setBackgroundUploads(prev => ({
          ...prev,
          [`lora-${loraId}`]: { status: 'uploading', fileName: firstFile.name }
        }))
        
        // Upload safetensors in background
        try {
          for (const [versionName, file] of safetensorsToUpload) {
            console.log('Background uploading Character LoRA safetensors:', versionName, file.name)
            const formData = new FormData()
            formData.append('file', file)
            formData.append('version', versionName)
            const uploadRes = await fetch(`/api/loras/${loraId}/safetensors`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` },
              body: formData
            })
            const uploadResult = await uploadRes.json()
            console.log('Background upload result:', uploadResult)
            if (!uploadRes.ok) throw new Error(uploadResult.error || 'Upload failed')
          }
          
          // Upload complete
          setBackgroundUploads(prev => ({
            ...prev,
            [`lora-${loraId}`]: { status: 'done', fileName: firstFile.name }
          }))
          await lorasCache.loadData(true)
          
          // Clear the done status after 3 seconds
          setTimeout(() => {
            setBackgroundUploads(prev => {
              const newState = { ...prev }
              delete newState[`lora-${loraId}`]
              return newState
            })
          }, 3000)
        } catch (uploadError) {
          console.error('Background upload error:', uploadError)
          setBackgroundUploads(prev => ({
            ...prev,
            [`lora-${loraId}`]: { status: 'error', fileName: firstFile.name, error: uploadError.message }
          }))
        }
      } else {
        // No safetensors to upload, just close normally
        await lorasCache.loadData(true)
        handleCloseEditLora()
      }
    } catch (error) {
      console.error('Error saving LoRA:', error)
      alert('Failed to save LoRA: ' + error.message)
    } finally {
      setIsLoading(false)
      setLoadingMessage('')
    }
  }

  const handleDeleteLora = async () => {
    if (!editLoraData || !editLoraData.id) return
    if (!confirm('Are you sure you want to delete this LoRA?')) return

    try {
      const token = auth.token
      const response = await fetch(`/api/loras/${editLoraData.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (!response.ok) throw new Error('Failed to delete LoRA')

      // Refresh LoRA list
      await lorasCache.loadData(true)

      handleCloseEditLora()
    } catch (error) {
      console.error('Error deleting LoRA:', error)
      alert('Failed to delete LoRA: ' + error.message)
    }
  }

  // ============================================
  // Fn LoRA Edit Functions
  // ============================================

  const handleEditFnLora = (fnLora) => {
    const modelArray = Array.isArray(fnLora.modelRaw) && fnLora.modelRaw.length > 0 
      ? fnLora.modelRaw 
      : (fnLora.versions?.map(v => ({ name: v.name, version: '' })) || [])
    
    setEditFnLoraData({
      ...fnLora,
      editedTitle: fnLora.title || fnLora.name || '',
      editedSubTitle: fnLora.subTitle || '',
      editedType: fnLora.type || '',
      editedModel: modelArray,
      editedModelJson: JSON.stringify(modelArray, null, 2),
      editedLink: fnLora.link || '',
      editedPrompt: fnLora.prompt || '',
      editedStability: fnLora.stability || 1,
      editedSensitive: fnLora.sensitive || 'SFW',
      editedWeight: fnLora.weight !== null ? fnLora.weight : ''
    })
    setPendingFnLoraThumbnail(null)
    setPendingFnLoraVersionImages({})
    setEditFnLoraSelectedVersion(0)
    setIsEditingFnLora(true)
    setIsCreatingFnLora(false)
  }

  const handleCreateFnLora = () => {
    const defaultModel = [{ name: 'Illustrious', version: 'v2.0' }]
    setEditFnLoraData({
      id: null,
      editedTitle: '',
      editedSubTitle: '',
      editedType: '',
      editedModel: defaultModel,
      editedModelJson: JSON.stringify(defaultModel, null, 2),
      editedLink: '',
      editedPrompt: '',
      editedStability: 1,
      editedSensitive: 'SFW',
      editedWeight: ''
    })
    setPendingFnLoraThumbnail(null)
    setPendingFnLoraVersionImages({})
    setEditFnLoraSelectedVersion(0)
    setIsEditingFnLora(true)
    setIsCreatingFnLora(true)
  }

  const handleCloseEditFnLora = () => {
    setIsEditingFnLora(false)
    setIsCreatingFnLora(false)
    setEditFnLoraData(null)
    setPendingFnLoraThumbnail(null)
    setPendingFnLoraVersionImages({})
    setPendingFnLoraSafetensors({})
    setEditFnLoraSelectedVersion(0)
    setEditNote('')
  }

  const handleUpdateFnLora = async () => {
    if (!editFnLoraData) return

    if (!editFnLoraData.editedTitle) {
      alert('Please enter a title')
      return
    }

    let modelData = editFnLoraData.editedModel
    if (editFnLoraData.editedModelJson) {
      try {
        modelData = JSON.parse(editFnLoraData.editedModelJson)
      } catch (e) {
        alert('Invalid model JSON format')
        return
      }
    }

    setIsLoading(true)
    setLoadingMessage(isCreatingFnLora ? 'Creating Fn LoRA...' : 'Updating Fn LoRA...')

    try {
      const token = auth.token
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }

      let fnLoraId = editFnLoraData.id

      if (isCreatingFnLora) {
        const response = await fetch('/api/fn-loras', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: editFnLoraData.editedTitle,
            subTitle: editFnLoraData.editedSubTitle,
            type: editFnLoraData.editedType,
            model: modelData,
            link: editFnLoraData.editedLink,
            prompt: editFnLoraData.editedPrompt,
            stability: parseInt(editFnLoraData.editedStability),
            sensitive: editFnLoraData.editedSensitive,
            weight: editFnLoraData.editedWeight !== '' ? parseFloat(editFnLoraData.editedWeight) : null
          })
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error)
        fnLoraId = data.id
      } else {
        const response = await fetch(`/api/fn-loras/${fnLoraId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            title: editFnLoraData.editedTitle,
            subTitle: editFnLoraData.editedSubTitle,
            type: editFnLoraData.editedType,
            model: modelData,
            link: editFnLoraData.editedLink,
            prompt: editFnLoraData.editedPrompt,
            stability: parseInt(editFnLoraData.editedStability),
            sensitive: editFnLoraData.editedSensitive,
            weight: editFnLoraData.editedWeight !== '' ? parseFloat(editFnLoraData.editedWeight) : null,
            editNote
          })
        })
        if (!response.ok) throw new Error('Failed to update Fn LoRA')
      }

      // Upload thumbnail
      if (pendingFnLoraThumbnail) {
        const formData = new FormData()
        formData.append('image', pendingFnLoraThumbnail)
        await fetch(`/api/fn-loras/${fnLoraId}/image/0`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData
        })
      }

      // Upload version-specific images
      for (const [versionName, images] of Object.entries(pendingFnLoraVersionImages)) {
        for (let i = 0; i < images.length; i++) {
          if (images[i]) {
            const formData = new FormData()
            formData.append('image', images[i])
            await fetch(`/api/fn-loras/${fnLoraId}/image/${i + 1}?version=${encodeURIComponent(versionName.toLowerCase())}`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` },
              body: formData
            })
          }
        }
      }

      // Check if there are safetensors to upload
      const safetensorsToUpload = Object.entries(pendingFnLoraSafetensors).filter(([_, file]) => file)
      
      if (safetensorsToUpload.length > 0) {
        // Close modal first, then upload in background
        await fnLorasCache.loadData(true)
        handleCloseEditFnLora()
        setIsLoading(false)
        setLoadingMessage('')
        
        // Start background upload
        const firstFile = safetensorsToUpload[0][1]
        setBackgroundUploads(prev => ({
          ...prev,
          [fnLoraId]: { status: 'uploading', fileName: firstFile.name }
        }))
        
        // Upload safetensors in background
        try {
          for (const [versionName, file] of safetensorsToUpload) {
            console.log('Background uploading safetensors:', versionName, file.name)
            const formData = new FormData()
            formData.append('file', file)
            formData.append('version', versionName)
            const uploadRes = await fetch(`/api/fn-loras/${fnLoraId}/safetensors`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` },
              body: formData
            })
            const uploadResult = await uploadRes.json()
            console.log('Background upload result:', uploadResult)
            if (!uploadRes.ok) throw new Error(uploadResult.error || 'Upload failed')
          }
          
          // Upload complete
          setBackgroundUploads(prev => ({
            ...prev,
            [fnLoraId]: { status: 'done', fileName: firstFile.name }
          }))
          await fnLorasCache.loadData(true)
          
          // Clear the done status after 3 seconds
          setTimeout(() => {
            setBackgroundUploads(prev => {
              const newState = { ...prev }
              delete newState[fnLoraId]
              return newState
            })
          }, 3000)
        } catch (uploadError) {
          console.error('Background upload error:', uploadError)
          setBackgroundUploads(prev => ({
            ...prev,
            [fnLoraId]: { status: 'error', fileName: firstFile.name, error: uploadError.message }
          }))
        }
      } else {
        // No safetensors to upload, just close normally
        await fnLorasCache.loadData(true)
        handleCloseEditFnLora()
      }
    } catch (error) {
      console.error('Error saving Fn LoRA:', error)
      alert('Failed to save Fn LoRA: ' + error.message)
    } finally {
      setIsLoading(false)
      setLoadingMessage('')
    }
  }

  const handleDeleteFnLora = async () => {
    if (!editFnLoraData || !editFnLoraData.id) return
    if (!confirm('Are you sure you want to delete this Fn LoRA?')) return

    try {
      const token = auth.token
      const response = await fetch(`/api/fn-loras/${editFnLoraData.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (!response.ok) throw new Error('Failed to delete Fn LoRA')

      await fnLorasCache.loadData(true)
      handleCloseEditFnLora()
    } catch (error) {
      console.error('Error deleting Fn LoRA:', error)
      alert('Failed to delete Fn LoRA: ' + error.message)
    }
  }

  const handleFnLoraImageSelect = (index, file) => {
    if (index === 0) {
      setPendingFnLoraThumbnail(file)
    } else {
      const currentModel = editFnLoraData?.editedModel?.[editFnLoraSelectedVersion]
      if (currentModel) {
        const versionName = currentModel.name.toLowerCase()
        setPendingFnLoraVersionImages(prev => {
          const versionImages = prev[versionName] || [null, null]
          const newVersionImages = [...versionImages]
          newVersionImages[index - 1] = file
          return { ...prev, [versionName]: newVersionImages }
        })
      }
    }
  }

  // ============================================
  // LoRA Image Functions
  // ============================================

  const handleLoraImageSelect = (index, file) => {
    if (index === 0) {
      // Thumbnail (shared)
      setPendingLoraThumbnail(file)
    } else {
      // Version-specific image (1 or 2)
      const currentModel = editLoraData?.editedModel?.[editLoraSelectedVersion]
      if (currentModel) {
        const versionName = currentModel.name.toLowerCase()
        setPendingLoraVersionImages(prev => {
          const versionImages = prev[versionName] || [null, null]
          const newVersionImages = [...versionImages]
          newVersionImages[index - 1] = file // index 1 -> array[0], index 2 -> array[1]
          return { ...prev, [versionName]: newVersionImages }
        })
      }
    }
  }

  const handleCostumeAdminClick = () => {
    if (!isLoggedIn) {
      auth.login()
    } else {
      setAdminMode(!adminMode)
    }
  }

  // Costume type collapse toggle
  const toggleCostumeType = (type) => {
    setCollapsedCostumeTypes(prev => {
      const newSet = new Set(prev)
      if (newSet.has(type)) {
        newSet.delete(type)
      } else {
        newSet.add(type)
      }
      return newSet
    })
  }

  // Costume type drag handlers
  const handleCostumeTypeDragStart = (e, type) => {
    if (!adminMode) return
    setDraggingCostumeType(type)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleCostumeTypeDragOver = (e, type) => {
    if (!adminMode || !draggingCostumeType || draggingCostumeType === type) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleCostumeTypeDrop = async (e, targetType) => {
    if (!adminMode || !draggingCostumeType || draggingCostumeType === targetType) return
    e.preventDefault()

    const typeOrder = [...costumeMetadata.typeOrder]
    const fromIndex = typeOrder.indexOf(draggingCostumeType)
    const toIndex = typeOrder.indexOf(targetType)

    if (fromIndex !== -1 && toIndex !== -1) {
      typeOrder.splice(fromIndex, 1)
      typeOrder.splice(toIndex, 0, draggingCostumeType)

      // Save to server
      try {
        const token = auth.token
        await fetch('/api/costumes/metadata', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ typeOrder })
        })
        await costumesCache.loadData(true)
      } catch (error) {
        console.error('Failed to update type order:', error)
      }
    }

    setDraggingCostumeType(null)
  }

  const handleCostumeTypeDragEnd = () => {
    setDraggingCostumeType(null)
  }

  // Costume item drag handlers (within a type)
  const handleCostumeDragStart = (e, costumeId, type) => {
    if (!adminMode) return
    setDraggingCostume(costumeId)
    setDraggingCostumeFromType(type)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleCostumeDragOver = (e, costumeId, type) => {
    if (!adminMode || !draggingCostume || type !== draggingCostumeFromType) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleCostumeDrop = async (e, targetCostumeId, type) => {
    if (!adminMode || !draggingCostume || type !== draggingCostumeFromType || draggingCostume === targetCostumeId) return
    e.preventDefault()

    const costumeOrder = { ...costumeMetadata.costumeOrder }
    const typeOrder = [...(costumeOrder[type] || [])]
    const fromIndex = typeOrder.indexOf(draggingCostume)
    const toIndex = typeOrder.indexOf(targetCostumeId)

    if (fromIndex !== -1 && toIndex !== -1) {
      typeOrder.splice(fromIndex, 1)
      typeOrder.splice(toIndex, 0, draggingCostume)
      costumeOrder[type] = typeOrder

      // Save to server
      try {
        const token = auth.token
        await fetch('/api/costumes/metadata', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ costumeOrder })
        })
        await costumesCache.loadData(true)
      } catch (error) {
        console.error('Failed to update costume order:', error)
      }
    }

    setDraggingCostume(null)
    setDraggingCostumeFromType(null)
  }

  const handleCostumeDragEnd = () => {
    setDraggingCostume(null)
    setDraggingCostumeFromType(null)
  }

  // Get costumes by type, sorted by metadata order
  const getCostumesByType = (type) => {
    const typeCostumes = sensitivityFilteredCostumes.filter(c => c.type === type)
    const order = costumeMetadata.costumeOrder[type] || []
    
    return typeCostumes.sort((a, b) => {
      const aIndex = order.indexOf(a.id)
      const bIndex = order.indexOf(b.id)
      if (aIndex === -1 && bIndex === -1) return 0
      if (aIndex === -1) return 1
      if (bIndex === -1) return -1
      return aIndex - bIndex
    })
  }

  // Get unique company list from LoRAs, sorted alphabetically with N/A at the end
  const getLoraCompanies = () => {
    const companies = [...new Set(filteredLoras.map(l => l.company || 'N/A'))]
    return companies.sort((a, b) => {
      if (a === 'N/A') return 1
      if (b === 'N/A') return -1
      return a.localeCompare(b)
    })
  }

  // Get LoRAs by company
  const getLorasByCompany = (company) => {
    return filteredLoras.filter(l => (l.company || 'N/A') === company)
  }

  // Toggle company collapse
  const toggleLoraCompany = (company) => {
    setCollapsedLoraCompanies(prev => {
      const newSet = new Set(prev)
      if (newSet.has(company)) {
        newSet.delete(company)
      } else {
        newSet.add(company)
      }
      return newSet
    })
  }

  const showCopyToast = () => {
    showToast('Copied!')
  }

  const showSavedToast = () => {
    showToast('Saved!')
  }

  const showToast = (message) => {
    const toast = document.createElement('div')
    toast.className = 'copy-toast'
    toast.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      ${message}
    `

    document.body.appendChild(toast)

    setTimeout(() => {
      toast.classList.add('show')
    }, 10)

    setTimeout(() => {
      toast.classList.remove('show')
      setTimeout(() => toast.remove(), 300)
    }, 2000)
  }

  const closePopup = () => {
    setSelectedPrompt(null)
    setSelectedCostume(null)
  }

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    })
  }

  // Render a custom dropdown filter for prompts
  const renderFilter = (label, filterId, currentValue, setValue, options, getLabel) => {
    const isOpen = openDropdown === filterId

    return (
      <div className="filter-row">
        <label>{label}:</label>
        <div className="custom-select-wrapper">
          <div
            className="custom-select"
            onClick={() => setOpenDropdown(isOpen ? null : filterId)}
          >
            <div className="custom-select-trigger">
              <span>{getLabel(currentValue)}</span>
              <svg className="custom-select-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </div>
            {isOpen && (
              <div className="custom-select-options">
                <div
                  className={`custom-select-option ${currentValue === 'all' ? 'selected' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setValue('all')
                    setOpenDropdown(null)
                  }}
                >
                  All ({sensitivityFilteredPrompts.length})
                </div>
                {options.map(option => (
                  <div
                    key={option}
                    className={`custom-select-option ${currentValue === option.toString() ? 'selected' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setValue(option.toString())
                      setOpenDropdown(null)
                    }}
                  >
                    {getLabel(option)} ({sensitivityFilteredPrompts.filter(p => p[filterId] ? p[filterId].toString() === option.toString() : false).length})
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Render sort dropdown
  const renderSortDropdown = (currentValue, setValue, options) => {
    const isOpen = openDropdown === 'sort'

    return (
      <div className="filter-row">
        <label>Sort By:</label>
        <div className="custom-select-wrapper">
          <div
            className="custom-select"
            onClick={() => setOpenDropdown(isOpen ? null : 'sort')}
          >
            <div className="custom-select-trigger">
              <span>{options.find(opt => opt.value === currentValue)?.label || 'Default'}</span>
              <svg className="custom-select-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </div>
            {isOpen && (
              <div className="custom-select-options">
                {options.map(option => (
                  <div
                    key={option.value}
                    className={`custom-select-option ${currentValue === option.value ? 'selected' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setValue(option.value)
                      setOpenDropdown(null)
                    }}
                  >
                    {option.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Render a custom dropdown filter for LoRAs
  const renderLoraFilter = (label, filterId, currentValue, setValue, options, getLabel) => {
    const isOpen = openDropdown === filterId

    return (
      <div className="filter-row">
        <label>{label}:</label>
        <div className="custom-select-wrapper">
          <div
            className="custom-select"
            onClick={() => setOpenDropdown(isOpen ? null : filterId)}
          >
            <div className="custom-select-trigger">
              <span>{getLabel(currentValue)}</span>
              <svg className="custom-select-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </div>
            {isOpen && (
              <div className="custom-select-options">
                <div
                  className={`custom-select-option ${currentValue === 'all' ? 'selected' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setValue('all')
                    setOpenDropdown(null)
                  }}
                >
                  All ({loras.length})
                </div>
                {options.map(option => (
                  <div
                    key={option}
                    className={`custom-select-option ${currentValue === option.toString() ? 'selected' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setValue(option.toString())
                      setOpenDropdown(null)
                    }}
                  >
                    {getLabel(option)} ({loras.filter(l => l[filterId] ? l[filterId].toString() === option.toString() : false).length})
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // First filter by sensitivity (top-level filter)
  // SFW = only SFW content, ALL = SFW + NSFW (everything)
  const sensitivityFilteredPrompts = prompts.filter(p => {
    if (sensitivityFilter === 'sfw') return p.sensitive === 'SFW'
    return true // 'all' shows everything (SFW + NSFW)
  })

  // Filter costumes by sensitivity
  const sensitivityFilteredCostumes = costumes.filter(c => {
    if (sensitivityFilter === 'sfw') return c.sensitive === 'SFW'
    return true // 'all' shows everything (SFW + NSFW)
  })

  // Get unique values for each filter based on sensitivity-filtered prompts
  const getUniqueCharacterCounts = () => {
    const counts = new Set(sensitivityFilteredPrompts.map(p => p.character || 1))
    return Array.from(counts).sort((a, b) => a - b)
  }

  const getUniqueValues = (field) => {
    const values = new Set(sensitivityFilteredPrompts.map(p => p[field] || 'Unknown'))
    return Array.from(values).sort()
  }

  // Filter prompts based on all active filters (after sensitivity filter)
  const filteredAndSortedPrompts = (() => {
    const filtered = sensitivityFilteredPrompts.filter(p => {
      const characterMatch = characterFilter === 'all' || (p.character || 1) === parseInt(characterFilter)
      const placeMatch = placeFilter === 'all' || p.place === placeFilter
      const typeMatch = typeFilter === 'all' || p.type === typeFilter
      const viewMatch = viewFilter === 'all' || p.view === viewFilter
      const nudityMatch = nudityFilter === 'all' || p.nudity === nudityFilter

      return characterMatch && placeMatch && typeMatch && viewMatch && nudityMatch
    })

    // Sort based on promptSortBy
    if (promptSortBy === 'mostCopied') {
      return [...filtered].sort((a, b) => (b.copyCount || 0) - (a.copyCount || 0))
    }
    return filtered
  })()

  const filteredPrompts = filteredAndSortedPrompts

  // Get unique values for LoRA filters
  const getLoraUniqueValues = (field) => {
    const values = new Set(
      loras
        .map(l => l[field])
        .filter(v => v && v !== '' && v !== 'Unknown')
    )
    return Array.from(values).sort()
  }

  // Filter LoRAs based on active filters
  const filteredAndSortedLoras = (() => {
    const filtered = loras.filter(l => {
      const genderMatch = loraGenderFilter === 'all' || l.gender === loraGenderFilter
      const modelMatch = loraModelFilter === 'all' || l.model === loraModelFilter
      const companyMatch = loraCompanyFilter === 'all' || l.company === loraCompanyFilter
      const groupMatch = loraGroupFilter === 'all' || l.group === loraGroupFilter
      const characterMatch = loraCharacterFilter === 'all' || l.character === loraCharacterFilter
      const characterCountMatch = loraCharacterCountFilter === 'all' || String(l.characterCount || 1) === loraCharacterCountFilter

      return genderMatch && modelMatch && companyMatch && groupMatch && characterMatch && characterCountMatch
    })

    // Default sort: by character count first (single before multi), then alphabetically by character name
    const defaultSort = (a, b) => {
      const countA = a.characterCount || 1
      const countB = b.characterCount || 1
      if (countA !== countB) return countA - countB
      return (a.character || '').localeCompare(b.character || '')
    }

    // Sort based on loraSortBy
    if (loraSortBy === 'mostCopied') {
      return [...filtered].sort((a, b) => (b.copyCount || 0) - (a.copyCount || 0))
    } else if (loraSortBy === 'mostDownloaded') {
      return [...filtered].sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0))
    }
    return [...filtered].sort(defaultSort)
  })()

  const filteredLoras = filteredAndSortedLoras

  // Fn LoRA helpers
  const getFnLoraUniqueValues = (field) => {
    const values = new Set(
      fnLoras
        .map(l => l[field])
        .filter(v => v && v !== '' && v !== 'Unknown')
    )
    return Array.from(values).sort()
  }

  // Filter Fn LoRAs based on active filters
  // First filter Fn LoRAs by sensitivity
  const sensitivityFilteredFnLoras = fnLoras.filter(l => {
    if (sensitivityFilter === 'sfw') return l.sensitive === 'SFW'
    return true // 'all' shows everything (SFW + NSFW)
  })

  const filteredFnLoras = sensitivityFilteredFnLoras.filter(l => {
    const typeMatch = fnLoraTypeFilter === 'all' || l.type === fnLoraTypeFilter
    const modelMatch = fnLoraModelFilter === 'all' || l.model === fnLoraModelFilter
    return typeMatch && modelMatch
  })

  // Fn LoRA filter render helper
  const renderFnLoraFilter = (label, filterId, currentValue, setValue, options, getLabel) => {
    const isOpen = openDropdown === `fnlora-${filterId}`

    return (
      <div className="filter-row">
        <label>{label}:</label>
        <div className="custom-select-wrapper">
          <div
            className="custom-select"
            onClick={() => setOpenDropdown(isOpen ? null : `fnlora-${filterId}`)}
          >
            <div className="custom-select-trigger">
              <span>{getLabel(currentValue)}</span>
              <svg className="custom-select-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </div>
            {isOpen && (
              <div className="custom-select-options">
                <div
                  className={`custom-select-option ${currentValue === 'all' ? 'selected' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setValue('all')
                    setOpenDropdown(null)
                  }}
                >
                  All ({sensitivityFilteredFnLoras.length})
                </div>
                {options.map(option => (
                  <div
                    key={option}
                    className={`custom-select-option ${currentValue === option.toString() ? 'selected' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setValue(option.toString())
                      setOpenDropdown(null)
                    }}
                  >
                    {getLabel(option)} ({fnLoras.filter(l => l[filterId] ? l[filterId].toString() === option.toString() : false).length})
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      <div className="app-container">
      {/* Floating Sensitivity Toggle */}
      <div className={`sensitivity-toggle-container ${sensitivityFilter === 'all' ? 'nsfw-active' : ''}`}>
        <span className="sensitivity-label">Safety Switch</span>
        <div 
          className={`sensitivity-toggle ${sensitivityFilter === 'all' ? 'nsfw-mode' : ''}`}
          onClick={() => setSensitivityFilter(sensitivityFilter === 'sfw' ? 'all' : 'sfw')}
        >
          {/* NSFW Icon - Inside toggle, left side */}
          <div className={`womb-tattoo-icon ${sensitivityFilter === 'all' ? 'visible' : ''}`}>
            <img src="/nsfw-icon.png" alt="NSFW" />
          </div>
          <div className={`toggle-slider ${sensitivityFilter}`}></div>
        </div>
      </div>

      <div className="main-card">
        {/* Hamburger Menu Button (Mobile Only) */}
        <button
          className="hamburger-menu"
          onClick={() => setIsSidebarOpen(true)}
          aria-label="Open navigation menu"
        >
          <span></span>
          <span></span>
          <span></span>
        </button>

        {/* Mobile Sidebar */}
        {isSidebarOpen && (
          <>
            <div
              className="sidebar-overlay"
              onClick={() => setIsSidebarOpen(false)}
            />
            <div className="mobile-sidebar">
              <div className="sidebar-header">
                <h3>Navigation</h3>
                <button
                  className="sidebar-close"
                  onClick={() => setIsSidebarOpen(false)}
                  aria-label="Close navigation menu"
                >
                  ×
                </button>
              </div>
              <nav className="sidebar-nav">
                <button
                  className={`sidebar-tab ${activeTab === 'lora' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('lora')
                    setIsSidebarOpen(false)
                  }}
                >
                  LoRA
                </button>
                <button
                  className={`sidebar-tab ${activeTab === 'fnlora' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('fnlora')
                    setIsSidebarOpen(false)
                  }}
                >
                  Fn LoRA
                </button>
                <button
                  className={`sidebar-tab ${activeTab === 'prompt' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('prompt')
                    setIsSidebarOpen(false)
                  }}
                >
                  Prompt
                </button>
                <button
                  className={`sidebar-tab ${activeTab === 'costume' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('costume')
                    setIsSidebarOpen(false)
                  }}
                >
                  Costume
                </button>
                <button
                  className={`sidebar-tab ${activeTab === 'gallery' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('gallery')
                    setIsSidebarOpen(false)
                  }}
                >
                  Collection
                </button>
                <button
                  className={`sidebar-tab ${activeTab === 'request' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('request')
                    setIsSidebarOpen(false)
                  }}
                >
                  Request
                </button>
                <button
                  className={`sidebar-tab ${activeTab === 'workflow' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('workflow')
                    setIsSidebarOpen(false)
                  }}
                >
                  Workflow
                </button>
                <button
                  className={`sidebar-tab ${activeTab === 'statistics' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('statistics')
                    setIsSidebarOpen(false)
                  }}
                >
                  Statistics
                </button>
                <button
                  className={`sidebar-tab ${activeTab === 'changelog' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('changelog')
                    setIsSidebarOpen(false)
                  }}
                >
                  Changelog
                </button>
                {auth.isAdmin && (
                  <button
                    className={`sidebar-tab ${activeTab === 'users' ? 'active' : ''}`}
                    onClick={() => {
                      setActiveTab('users')
                      setIsSidebarOpen(false)
                    }}
                  >
                    Users
                  </button>
                )}
              </nav>
            </div>
          </>
        )}

        {/* Desktop Tab Container */}
        <div className="tab-container">
          <button
            className={`tab ${activeTab === 'lora' ? 'active' : ''}`}
            onClick={() => setActiveTab('lora')}
          >
            LoRA
          </button>
          <button
            className={`tab ${activeTab === 'fnlora' ? 'active' : ''}`}
            onClick={() => setActiveTab('fnlora')}
          >
            Fn LoRA
          </button>
          <button
            className={`tab ${activeTab === 'prompt' ? 'active' : ''}`}
            onClick={() => setActiveTab('prompt')}
          >
            Prompt
          </button>
          <button
            className={`tab ${activeTab === 'costume' ? 'active' : ''}`}
            onClick={() => setActiveTab('costume')}
          >
            Costume
          </button>
          <button
            className={`tab ${activeTab === 'gallery' ? 'active' : ''}`}
            onClick={() => setActiveTab('gallery')}
          >
            Collection
          </button>
          <button
            className={`tab ${activeTab === 'request' ? 'active' : ''}`}
            onClick={() => setActiveTab('request')}
          >
            Request
          </button>
          <button
            className={`tab ${activeTab === 'workflow' ? 'active' : ''}`}
            onClick={() => setActiveTab('workflow')}
          >
            Workflow
          </button>
          <button
            className={`tab ${activeTab === 'statistics' ? 'active' : ''}`}
            onClick={() => setActiveTab('statistics')}
          >
            Statistics
          </button>
          <button
            className={`tab ${activeTab === 'changelog' ? 'active' : ''}`}
            onClick={() => setActiveTab('changelog')}
          >
            Changelog
          </button>
          {auth.isAdmin && (
            <button
              className={`tab ${activeTab === 'users' ? 'active' : ''}`}
              onClick={() => setActiveTab('users')}
            >
              Users
            </button>
          )}
        </div>

        <div className="content-area">
          {auth.isWhitelisted && activeTab === 'prompt' && (
            <div className="tab-content">
              <div className="tab-header">
                <div>
                  <h2>Prompt Gallery</h2>
                  <p>Browse and use preset prompt examples</p>
                </div>
                <div className="tab-header-actions">
                  <button
                    className="help-button"
                    onClick={() => setShowHelpModal(true)}
                    title="Help & Information"
                  >
                    ?
                  </button>
                  <LoginButton adminMode={adminMode} onAdminModeToggle={handlePromptAdminClick} />
                </div>
              </div>

              <div className="filter-container">
                <button
                  className="filter-toggle-button"
                  onClick={() => setIsFilterExpanded(!isFilterExpanded)}
                >
                  <span>Filters</span>
                  <span className={`filter-arrow ${isFilterExpanded ? 'expanded' : ''}`}>▼</span>
                  <span className="filter-count">
                    {filteredPrompts.length} / {sensitivityFilteredPrompts.length}
                  </span>
                </button>

                <div className={`filter-content ${isFilterExpanded ? 'expanded' : ''}`}>
                  <div>
                    <div className="filter-grid">
                      {/* Character Filter */}
                      {renderFilter(
                        'Character',
                        'character',
                        characterFilter,
                        setCharacterFilter,
                        getUniqueCharacterCounts(),
                        (val) => val === 'all' ? `All (${sensitivityFilteredPrompts.length})` : `${val} Character${parseInt(val) > 1 ? 's' : ''}`
                      )}

                      {/* Place Filter */}
                      {renderFilter(
                        'Place',
                        'place',
                        placeFilter,
                        setPlaceFilter,
                        getUniqueValues('place'),
                        (val) => val === 'all' ? `All (${sensitivityFilteredPrompts.length})` : val
                      )}

                      {/* Type Filter */}
                      {renderFilter(
                        'Type',
                        'type',
                        typeFilter,
                        setTypeFilter,
                        getUniqueValues('type'),
                        (val) => val === 'all' ? `All (${sensitivityFilteredPrompts.length})` : val
                      )}

                      {/* View Filter */}
                      {renderFilter(
                        'View',
                        'view',
                        viewFilter,
                        setViewFilter,
                        getUniqueValues('view'),
                        (val) => val === 'all' ? `All (${sensitivityFilteredPrompts.length})` : val
                      )}

                      {/* Nudity Filter - Only show when not in SFW mode */}
                      {sensitivityFilter !== 'sfw' && renderFilter(
                        'Nudity',
                        'nudity',
                        nudityFilter,
                        setNudityFilter,
                        getUniqueValues('nudity'),
                        (val) => val === 'all' ? `All (${sensitivityFilteredPrompts.length})` : val
                      )}

                      {/* Sort Dropdown */}
                      {renderSortDropdown(promptSortBy, setPromptSortBy, [
                        { value: 'default', label: 'Default' },
                        { value: 'mostCopied', label: 'Most Copied' }
                      ])}
                    </div>

                    <div className="filter-info">
                      Showing {filteredPrompts.length} of {sensitivityFilteredPrompts.length} prompts
                    </div>
                  </div>
                </div>
              </div>

              <div className="content-section">
                <div className="prompt-grid">
                  {/* Add New Prompt Card (Admin Mode Only) */}
                  {adminMode && (
                    <div
                      className="prompt-card add-new-card"
                      onClick={handleCreatePrompt}
                    >
                      <div className="add-new-icon">+</div>
                      <div className="prompt-info">
                        <h4>Add New</h4>
                      </div>
                    </div>
                  )}
                  {filteredPrompts.map((item) => (
                    <div
                      key={item.id}
                      className={`prompt-card ${adminMode ? 'admin-mode' : ''}`}
                      onClick={() => adminMode ? handleEditPrompt(item) : setSelectedPrompt(item)}
                    >
                      <div
                        className="prompt-thumbnail"
                        style={{ backgroundImage: `url("${encodeURI(item.thumbnail)}")` }}
                      ></div>
                      <div className="prompt-info">
                        <h4>{item.title || ''}</h4>
                        {adminMode && <span className="edit-indicator">✎ Edit</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'lora' && (
            <div className="tab-content">
              <div className="tab-header">
                <div>
                  <h2>LoRA Gallery</h2>
                  <p>Browse and download LoRA models</p>
                </div>
                <div className="tab-header-actions">
                  {/* Notification Bell */}
                  <div className="notification-container" ref={notificationRef}>
                    <button
                      className="notification-bell"
                      onClick={handleNotificationClick}
                      title="Updates"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                      {hasUnreadNotifications && <span className="notification-badge" />}
                    </button>
                    {showNotifications && (
                      <div className="notification-dropdown">
                        <div className="notification-header">
                          <span>Updates</span>
                          {notifications.updates.length > 0 && (
                            <span className="notification-count">{notifications.updates.length}</span>
                          )}
                        </div>
                        <div className="notification-list">
                          {notifications.updates.length === 0 ? (
                            <div className="notification-empty">No updates yet</div>
                          ) : (
                            notifications.updates.map((notif) => {
                              const isUnread = notif.id > openedAtVersionRef.current
                              return (
                                <div key={notif.id} className={`notification-item ${isUnread ? 'unread' : ''}`}>
                                  {isUnread && <span className="notification-item-badge" />}
                                  <div className="notification-content">
                                    <div className="notification-message">{notif.message}</div>
                                    <div className="notification-time">{formatNotificationTime(notif.timestamp)}</div>
                                  </div>
                                </div>
                              )
                            })
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <LoginButton adminMode={adminMode} onAdminModeToggle={handleLoraAdminClick} />
                </div>
              </div>

              <div className="filter-container">
                <button
                  className="filter-toggle-button"
                  onClick={() => setIsLoraFilterExpanded(!isLoraFilterExpanded)}
                >
                  <span>Filters</span>
                  <span className={`filter-arrow ${isLoraFilterExpanded ? 'expanded' : ''}`}>▼</span>
                  <span className="filter-count">
                    {filteredLoras.length} / {loras.length}
                  </span>
                </button>

                <div className={`filter-content ${isLoraFilterExpanded ? 'expanded' : ''}`}>
                  <div>
                    <div className="filter-grid">
                      {/* Gender Filter */}
                      {renderLoraFilter(
                        'Gender',
                        'gender',
                        loraGenderFilter,
                        setLoraGenderFilter,
                        getLoraUniqueValues('gender'),
                        (val) => val === 'all' ? `All (${loras.length})` : val
                      )}

                      {/* Model Filter */}
                      {renderLoraFilter(
                        'Model',
                        'model',
                        loraModelFilter,
                        setLoraModelFilter,
                        getLoraUniqueValues('model'),
                        (val) => val === 'all' ? `All (${loras.length})` : val
                      )}

                      {/* Company Filter */}
                      {renderLoraFilter(
                        'Company',
                        'company',
                        loraCompanyFilter,
                        setLoraCompanyFilter,
                        getLoraUniqueValues('company'),
                        (val) => val === 'all' ? `All (${loras.length})` : val
                      )}

                      {/* Group Filter */}
                      {renderLoraFilter(
                        'Group',
                        'group',
                        loraGroupFilter,
                        setLoraGroupFilter,
                        getLoraUniqueValues('group'),
                        (val) => val === 'all' ? `All (${loras.length})` : val
                      )}

                      {/* Character Filter */}
                      {renderLoraFilter(
                        'Character',
                        'character',
                        loraCharacterFilter,
                        setLoraCharacterFilter,
                        getLoraUniqueValues('character'),
                        (val) => val === 'all' ? `All (${loras.length})` : val
                      )}

                      {/* Character Count Filter */}
                      {renderLoraFilter(
                        'Char Count',
                        'characterCount',
                        loraCharacterCountFilter,
                        setLoraCharacterCountFilter,
                        getLoraUniqueValues('characterCount').length > 0 
                          ? getLoraUniqueValues('characterCount').map(v => String(v))
                          : ['1'],
                        (val) => val === 'all' ? `All (${loras.length})` : `${val} char`
                      )}

                      {/* Sort Dropdown */}
                      {renderSortDropdown(loraSortBy, setLoraSortBy, [
                        { value: 'default', label: 'Default' },
                        { value: 'mostCopied', label: 'Most Copied' },
                        { value: 'mostDownloaded', label: 'Most Downloaded' }
                      ])}
                    </div>

                    <div className="filter-info">
                      Showing {filteredLoras.length} of {loras.length} LoRAs
                    </div>
                  </div>
                </div>
              </div>

              {/* Add New LoRA Button (Admin Mode Only) */}
              {adminMode && (
                <div style={{ padding: '0 1rem 1rem' }}>
                  <button
                    className="admin-btn admin-btn-primary"
                    onClick={handleCreateLora}
                    style={{ width: '100%' }}
                  >
                    + Add New LoRA
                  </button>
                </div>
              )}

              <div className="lora-categories">
                {getLoraCompanies().map((company) => {
                  const companyLoras = getLorasByCompany(company)
                  const totalCompanyLoras = loras.filter(l => (l.company || 'N/A') === company).length
                  const isCollapsed = collapsedLoraCompanies.has(company)

                  if (totalCompanyLoras === 0) return null

                  return (
                    <div key={company} className="lora-category-section">
                      <div
                        className="lora-category-header"
                        onClick={() => toggleLoraCompany(company)}
                      >
                        <span className={`lora-category-arrow ${isCollapsed ? '' : 'expanded'}`}>
                          ▶
                        </span>
                        <h3 className="lora-category-title">
                          {company}
                        </h3>
                        <span className="lora-category-count">
                          {companyLoras.length !== totalCompanyLoras 
                            ? `${companyLoras.length} / ${totalCompanyLoras}` 
                            : totalCompanyLoras}
                        </span>
                      </div>

                      {!isCollapsed && (
                        <div className="lora-grid">
                          {companyLoras.length > 0 ? (
                            companyLoras.map((lora) => {
                              const uploadStatus = backgroundUploads[`lora-${lora.id}`]
                              return (
                                <div
                                  key={lora.id}
                                  className={`lora-card ${adminMode ? 'admin-mode' : ''} ${uploadStatus?.status === 'uploading' ? 'uploading' : ''}`}
                                  onClick={() => uploadStatus?.status === 'uploading' ? null : (adminMode ? handleEditLora(lora) : setSelectedLora(lora))}
                                  style={uploadStatus?.status === 'uploading' ? { cursor: 'wait', opacity: 0.7 } : {}}
                                >
                                  <div
                                    className="lora-preview"
                                    style={{ backgroundImage: `url("${encodeURI(lora.thumbnail)}")` }}
                                  >
                                    {uploadStatus?.status === 'uploading' && (
                                      <div className="upload-overlay">
                                        <div className="upload-spinner"></div>
                                        <span>Uploading...</span>
                                      </div>
                                    )}
                                    {uploadStatus?.status === 'done' && (
                                      <div className="upload-overlay done">
                                        <span>✓ Done</span>
                                      </div>
                                    )}
                                    {uploadStatus?.status === 'error' && (
                                      <div className="upload-overlay error">
                                        <span>✗ Failed</span>
                                      </div>
                                    )}
                                  </div>
                                  <div className="lora-info">
                                    <h4 className="lora-character">{lora.character}</h4>
                                    <p className="lora-cloth">{lora.cloth || '-'}</p>
                                    {adminMode && !uploadStatus && <span className="edit-indicator">✎ Edit</span>}
                                  </div>
                                </div>
                              )
                            })
                          ) : (
                            <div className="lora-category-empty">
                              No LoRAs visible (filtered)
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {auth.isWhitelisted && activeTab === 'fnlora' && (
            <div className="tab-content">
              <div className="tab-header">
                <div>
                  <h2>Functional LoRA</h2>
                  <p>Browse and download functional LoRA models</p>
                </div>
                <div className="tab-header-actions">
                  <button
                    className="help-button"
                    onClick={() => setShowHelpModal(true)}
                    title="Help"
                  >
                    ?
                  </button>
                  <LoginButton adminMode={adminMode} onAdminModeToggle={() => {
                    if (!isLoggedIn) {
                      auth.login()
                    } else {
                      setAdminMode(!adminMode)
                    }
                  }} />
                </div>
              </div>

              <div className="filter-container">
                <button
                  className="filter-toggle-button"
                  onClick={() => setIsFnLoraFilterExpanded(!isFnLoraFilterExpanded)}
                >
                  <span>Filters</span>
                  <span className={`filter-arrow ${isFnLoraFilterExpanded ? 'expanded' : ''}`}>▼</span>
                  <span className="filter-count">
                    {filteredFnLoras.length} / {sensitivityFilteredFnLoras.length}
                  </span>
                </button>

                <div className={`filter-content ${isFnLoraFilterExpanded ? 'expanded' : ''}`}>
                  <div>
                    <div className="filter-grid">
                      {/* Type Filter */}
                      {renderFnLoraFilter(
                        'Type',
                        'type',
                        fnLoraTypeFilter,
                        setFnLoraTypeFilter,
                        getFnLoraUniqueValues('type'),
                        (val) => val === 'all' ? `All (${sensitivityFilteredFnLoras.length})` : val
                      )}

                      {/* Model Filter */}
                      {renderFnLoraFilter(
                        'Model',
                        'model',
                        fnLoraModelFilter,
                        setFnLoraModelFilter,
                        getFnLoraUniqueValues('model'),
                        (val) => val === 'all' ? `All (${sensitivityFilteredFnLoras.length})` : val
                      )}
                    </div>

                    <div className="filter-info">
                      Showing {filteredFnLoras.length} of {sensitivityFilteredFnLoras.length} Functional LoRAs
                    </div>
                  </div>
                </div>
              </div>

              <div className="content-section">
                <div className="lora-grid">
                  {/* Add New Fn LoRA Card (Admin Mode Only) */}
                  {adminMode && (
                    <div
                      className="lora-card add-new-card"
                      onClick={handleCreateFnLora}
                    >
                      <div className="lora-preview add-new-preview">
                        <span className="add-new-icon">+</span>
                      </div>
                      <div className="lora-info">
                        <h4 className="lora-character">Add New</h4>
                        <p className="lora-cloth">Fn LoRA</p>
                      </div>
                    </div>
                  )}
                  {filteredFnLoras.map((fnLora) => {
                    const uploadStatus = backgroundUploads[fnLora.id]
                    return (
                      <div
                        key={fnLora.id}
                        className={`lora-card ${adminMode ? 'admin-mode' : ''} ${uploadStatus?.status === 'uploading' ? 'uploading' : ''}`}
                        onClick={() => uploadStatus?.status === 'uploading' ? null : (adminMode ? handleEditFnLora(fnLora) : setSelectedFnLora(fnLora))}
                        style={uploadStatus?.status === 'uploading' ? { cursor: 'wait', opacity: 0.7 } : {}}
                      >
                        <div
                          className="lora-preview"
                          style={{ backgroundImage: `url("${encodeURI(fnLora.thumbnail)}")` }}
                        >
                          {uploadStatus?.status === 'uploading' && (
                            <div className="upload-overlay">
                              <div className="upload-spinner"></div>
                              <span>Uploading...</span>
                            </div>
                          )}
                          {uploadStatus?.status === 'done' && (
                            <div className="upload-overlay done">
                              <span>✓ Done</span>
                            </div>
                          )}
                          {uploadStatus?.status === 'error' && (
                            <div className="upload-overlay error">
                              <span>✗ Failed</span>
                            </div>
                          )}
                        </div>
                        <div className="lora-info">
                          <h4 className="lora-character">{fnLora.title}</h4>
                          <p className="lora-cloth">{fnLora.subTitle || '-'}</p>
                          {adminMode && !uploadStatus && <span className="edit-indicator">✎ Edit</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {auth.isWhitelisted && activeTab === 'costume' && (
            <div className="tab-content">
              <div className="tab-header">
                <div>
                  <h2>Costume Gallery</h2>
                  <p>Browse costume and outfit prompts by category</p>
                </div>
                <div className="tab-header-actions">
                  <LoginButton adminMode={adminMode} onAdminModeToggle={handleCostumeAdminClick} />
                </div>
              </div>

              <div className="filter-info" style={{ padding: '0.5rem 1rem', color: themeColors.textSecondary, fontSize: '0.85rem' }}>
                Showing {sensitivityFilteredCostumes.length} of {costumes.length} costumes
                {adminMode && ' • Drag categories or items to reorder'}
              </div>

              {/* Add New Costume Button (Admin Mode Only) */}
              {adminMode && (
                <div style={{ padding: '0 1rem 1rem' }}>
                  <button
                    className="admin-btn admin-btn-primary"
                    onClick={handleCreateCostume}
                    style={{ width: '100%' }}
                  >
                    + Add New Costume
                  </button>
                </div>
              )}

              <div className="costume-categories">
                {costumeMetadata.typeOrder.map((type) => {
                  const typeCostumes = getCostumesByType(type)
                  const totalTypeCostumes = costumes.filter(c => c.type === type).length
                  const isCollapsed = collapsedCostumeTypes.has(type)

                  if (totalTypeCostumes === 0) return null

                  return (
                    <div
                      key={type}
                      className={`costume-category-section ${draggingCostumeType === type ? 'dragging' : ''}`}
                      draggable={adminMode}
                      onDragStart={(e) => handleCostumeTypeDragStart(e, type)}
                      onDragOver={(e) => handleCostumeTypeDragOver(e, type)}
                      onDrop={(e) => handleCostumeTypeDrop(e, type)}
                      onDragEnd={handleCostumeTypeDragEnd}
                    >
                      <div
                        className="costume-category-header"
                        onClick={() => toggleCostumeType(type)}
                      >
                        {adminMode && (
                          <span className="costume-drag-handle" title="Drag to reorder">⋮⋮</span>
                        )}
                        <span className={`costume-category-arrow ${isCollapsed ? '' : 'expanded'}`}>
                          ▶
                        </span>
                        <h3 className="costume-category-title">
                          {type}
                        </h3>
                        <span className="costume-category-count">
                          {typeCostumes.length !== totalTypeCostumes 
                            ? `${typeCostumes.length} / ${totalTypeCostumes}` 
                            : totalTypeCostumes}
                        </span>
                      </div>

                      {!isCollapsed && (
                        <div className="costume-grid">
                          {typeCostumes.length > 0 ? (
                            typeCostumes.map((item) => (
                              <div
                                key={item.id}
                                className={`prompt-card ${adminMode ? 'admin-mode' : ''} ${draggingCostume === item.id ? 'dragging' : ''}`}
                                draggable={adminMode}
                                onDragStart={(e) => { e.stopPropagation(); handleCostumeDragStart(e, item.id, type) }}
                                onDragOver={(e) => { e.stopPropagation(); handleCostumeDragOver(e, item.id, type) }}
                                onDrop={(e) => { e.stopPropagation(); handleCostumeDrop(e, item.id, type) }}
                                onDragEnd={handleCostumeDragEnd}
                                onClick={() => adminMode ? handleEditCostume(item) : setSelectedCostume(item)}
                              >
                                <div className="prompt-thumbnail">
                                  <img 
                                    src={item.thumbnail} 
                                    alt={item.title || 'Costume'} 
                                    loading="lazy"
                                    decoding="async"
                                  />
                                </div>
                                <div className="prompt-info">
                                  <h4>{item.title || ''}</h4>
                                  {adminMode && <span className="edit-indicator">✎ Edit</span>}
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="costume-category-empty">
                              No costumes visible (filtered by sensitivity)
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {auth.isWhitelisted && activeTab === 'gallery' && (
            <div className="tab-content">
              <Gallery
                sensitivityFilter={sensitivityFilter}
                isLoggedIn={isLoggedIn}
                adminMode={adminMode}
                onAdminLogout={handleAdminLogout}
                onAdminModeToggle={handleAdminModeToggle}
              />
            </div>
          )}

          {auth.isWhitelisted && activeTab === 'request' && (
            <div className="tab-content">
              <Request
                isLoggedIn={isLoggedIn}
                adminMode={adminMode}
                onAdminLogout={handleAdminLogout}
                onAdminModeToggle={handleAdminModeToggle}
              />
            </div>
          )}

          {auth.isWhitelisted && activeTab === 'statistics' && (
            <div className="tab-content statistics-content">
              <div className="tab-header">
                <div>
                  <h2>Statistics Dashboard</h2>
                  <p>
                    Overview of prompts and LoRA usage data
                    {sensitivityFilter !== 'all' && (
                      <span className="stats-filter-badge">
                        {' '}· Filtered by: {sensitivityFilter.toUpperCase()}
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <div className="content-section">
                {!statistics ? (
                  <div className="loading-message">Loading statistics...</div>
                ) : (
                  <div className="statistics-grid">
                  {/* Overview Cards */}
                  <div className="stats-overview">
                    <div className="stat-card">
                      <div className="stat-icon">📝</div>
                      <div className="stat-info">
                        <div className="stat-value">{statistics.prompts.total}</div>
                        <div className="stat-label">Total Prompts</div>
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-icon">👗</div>
                      <div className="stat-info">
                        <div className="stat-value">{statistics.costumes?.total || 0}</div>
                        <div className="stat-label">Total Costumes</div>
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-icon">🎨</div>
                      <div className="stat-info">
                        <div className="stat-value">{statistics.loras.total}</div>
                        <div className="stat-label">Total LoRAs</div>
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-icon">⬇️</div>
                      <div className="stat-info">
                        <div className="stat-value">{statistics.loras.totalDownloads}</div>
                        <div className="stat-label">Total Downloads</div>
                      </div>
                    </div>
                  </div>

                  {/* Prompt Statistics */}
                  <div className="chart-section">
                    <h3>Prompt Statistics</h3>

                    <div className="chart-container">
                      <h4>Top 10 Most Copied Prompts</h4>
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart
                          data={statistics.prompts.topCopied}
                          barCategoryGap="20%"
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(99, 130, 191, 0.2)" />
                          <XAxis
                            dataKey="name"
                            stroke={themeColors.chartAxis}
                            tick={{ fill: themeColors.chartAxis }}
                          />
                          <YAxis
                            stroke={themeColors.chartAxis}
                            tick={{ fill: themeColors.chartAxis }}
                          />
                          <Tooltip
                            cursor={{ fill: 'rgba(99, 130, 191, 0.08)' }}
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                const data = payload[0].payload
                                return (
                                  <div className="custom-chart-tooltip">
                                    {data.thumbnail && (
                                      <img
                                        src={data.thumbnail}
                                        alt={data.name}
                                        className="tooltip-preview"
                                      />
                                    )}
                                    <div className="tooltip-info">
                                      <p className="tooltip-label">{data.name}</p>
                                      <p className="tooltip-value">Copies: {data.copyCount}</p>
                                      <p className="tooltip-meta">Place: {data.place}</p>
                                      <p className="tooltip-meta">Characters: {data.character}</p>
                                    </div>
                                  </div>
                                )
                              }
                              return null
                            }}
                          />
                          <Bar dataKey="copyCount" fill={themeColors.chartBar1} radius={[8, 8, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="chart-row">
                      <div className="chart-container half-width">
                        <h4>Prompts by Character Count</h4>
                        <ResponsiveContainer width="100%" height={180}>
                          <PieChart>
                            <Pie
                              data={Object.entries(statistics.prompts.byCharacter).map(([key, value]) => ({
                                name: `${key} Character${key > 1 ? 's' : ''}`,
                                value: value
                              }))}
                              cx="50%"
                              cy="50%"
                              labelLine={false}
                              label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                              outerRadius={60}
                              fill={themeColors.chartPie1}
                              dataKey="value"
                            >
                              {Object.keys(statistics.prompts.byCharacter).map((_, index) => (
                                <Cell key={`cell-${index}`} fill={[themeColors.chartPie1, themeColors.chartPie2, themeColors.chartPie3, themeColors.chartPie4, themeColors.chartPie5][index % 5]} />
                              ))}
                            </Pie>
                            <Tooltip
                              contentStyle={{
                                backgroundColor: themeColors.tooltipBg,
                                border: `1px solid ${themeColors.tooltipBorder}`,
                                borderRadius: '8px',
                                color: themeColors.textPrimary
                              }}
                              itemStyle={{
                                color: themeColors.textPrimary
                              }}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="chart-container half-width">
                        <h4>Prompts by Sensitivity</h4>
                        <ResponsiveContainer width="100%" height={180}>
                          <PieChart>
                            <Pie
                              data={Object.entries(statistics.prompts.bySensitivity).map(([key, value]) => ({
                                name: key,
                                value: value
                              }))}
                              cx="50%"
                              cy="50%"
                              labelLine={false}
                              label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                              outerRadius={60}
                              fill={themeColors.chartPie1}
                              dataKey="value"
                            >
                              <Cell fill={themeColors.chartBar1} />
                              <Cell fill={themeColors.chartCostume} />
                            </Pie>
                            <Tooltip
                              contentStyle={{
                                backgroundColor: themeColors.tooltipBg,
                                border: `1px solid ${themeColors.tooltipBorder}`,
                                borderRadius: '8px',
                                color: themeColors.textPrimary
                              }}
                              itemStyle={{
                                color: themeColors.textPrimary
                              }}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div className="chart-container">
                      <h4>Prompts by Type</h4>
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart data={Object.entries(statistics.prompts.byType).map(([key, value]) => ({
                          name: key,
                          count: value
                        }))}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(99, 130, 191, 0.2)" />
                          <XAxis
                            dataKey="name"
                            stroke={themeColors.chartAxis}
                            tick={{ fill: themeColors.chartAxis }}
                            angle={-45}
                            textAnchor="end"
                            height={100}
                          />
                          <YAxis
                            stroke={themeColors.chartAxis}
                            tick={{ fill: themeColors.chartAxis }}
                          />
                          <Tooltip
                            cursor={{ fill: 'rgba(99, 130, 191, 0.08)' }}
                            contentStyle={{
                              backgroundColor: themeColors.tooltipBg,
                              border: `1px solid ${themeColors.tooltipBorder}`,
                              borderRadius: '8px',
                              color: themeColors.textPrimary
                            }}
                          />
                          <Bar dataKey="count" fill={themeColors.chartBar2} radius={[8, 8, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Costume Statistics */}
                  {statistics.costumes && statistics.costumes.total > 0 && (
                    <div className="chart-section">
                      <h3>Costume Statistics</h3>

                      <div className="chart-container">
                        <h4>Top 10 Most Copied Costumes</h4>
                        <ResponsiveContainer width="100%" height={250}>
                          <BarChart
                            data={statistics.costumes.topCopied}
                            barCategoryGap="20%"
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(99, 130, 191, 0.2)" />
                            <XAxis
                              dataKey="name"
                              stroke={themeColors.chartAxis}
                              tick={{ fill: themeColors.chartAxis }}
                            />
                            <YAxis
                              stroke={themeColors.chartAxis}
                              tick={{ fill: themeColors.chartAxis }}
                            />
                            <Tooltip
                              cursor={{ fill: 'rgba(99, 130, 191, 0.08)' }}
                              content={({ active, payload }) => {
                                if (active && payload && payload.length) {
                                  const data = payload[0].payload
                                  return (
                                    <div className="custom-chart-tooltip">
                                      {data.thumbnail && (
                                        <img
                                          src={data.thumbnail}
                                          alt={data.name}
                                          className="tooltip-preview"
                                        />
                                      )}
                                      <div className="tooltip-info">
                                        <p className="tooltip-label">{data.name}</p>
                                        <p className="tooltip-value">Copies: {data.copyCount}</p>
                                        <p className="tooltip-meta">Type: {data.type}</p>
                                        <p className="tooltip-meta">View: {data.view}</p>
                                      </div>
                                    </div>
                                  )
                                }
                                return null
                              }}
                            />
                            <Bar dataKey="copyCount" fill={themeColors.chartCostume} radius={[8, 8, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="chart-row">
                        <div className="chart-container half-width">
                          <h4>Costumes by Type</h4>
                          <ResponsiveContainer width="100%" height={180}>
                            <PieChart>
                              <Pie
                                data={Object.entries(statistics.costumes.byType).map(([key, value]) => ({
                                  name: key,
                                  value: value
                                }))}
                                cx="50%"
                                cy="50%"
                                labelLine={false}
                                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                                outerRadius={60}
                                fill={themeColors.chartPie1}
                                dataKey="value"
                              >
                                {Object.keys(statistics.costumes.byType).map((_, index) => (
                                  <Cell key={`cell-${index}`} fill={[themeColors.chartCostume, themeColors.chartPie2, themeColors.chartPie3, themeColors.chartPie4, themeColors.chartPie5][index % 5]} />
                                ))}
                              </Pie>
                              <Tooltip
                                contentStyle={{
                                  backgroundColor: themeColors.tooltipBg,
                                  border: `1px solid ${themeColors.tooltipBorder}`,
                                  borderRadius: '8px',
                                  color: themeColors.textPrimary
                                }}
                                itemStyle={{
                                  color: themeColors.textPrimary
                                }}
                              />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>

                        <div className="chart-container half-width">
                          <h4>Costumes by View</h4>
                          <ResponsiveContainer width="100%" height={180}>
                            <PieChart>
                              <Pie
                                data={Object.entries(statistics.costumes.byView).map(([key, value]) => ({
                                  name: key,
                                  value: value
                                }))}
                                cx="50%"
                                cy="50%"
                                labelLine={false}
                                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                                outerRadius={60}
                                fill={themeColors.chartPie1}
                                dataKey="value"
                              >
                                {Object.keys(statistics.costumes.byView).map((_, index) => (
                                  <Cell key={`cell-${index}`} fill={[themeColors.chartCostume, themeColors.chartPie2, themeColors.chartPie3, themeColors.chartPie4, themeColors.chartPie5][index % 5]} />
                                ))}
                              </Pie>
                              <Tooltip
                                contentStyle={{
                                  backgroundColor: themeColors.tooltipBg,
                                  border: `1px solid ${themeColors.tooltipBorder}`,
                                  borderRadius: '8px',
                                  color: themeColors.textPrimary
                                }}
                                itemStyle={{
                                  color: themeColors.textPrimary
                                }}
                              />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* LoRA Statistics */}
                  <div className="chart-section">
                    <h3>LoRA Statistics</h3>

                    <div className="chart-container">
                      <h4>Top 10 Most Downloaded LoRAs</h4>
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart data={statistics.loras.topDownloaded}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(99, 130, 191, 0.2)" />
                          <XAxis
                            dataKey="name"
                            stroke={themeColors.chartAxis}
                            tick={(props) => {
                              const { x, y, payload } = props
                              if (!payload || !payload.value) return null

                              // Split at first '-' to separate character and cloth
                              const dashIndex = payload.value.indexOf('-')
                              let line1 = payload.value
                              let line2 = ''

                              if (dashIndex !== -1) {
                                line1 = payload.value.substring(0, dashIndex)
                                line2 = payload.value.substring(dashIndex + 1)
                              }

                              return (
                                <g transform={`translate(${x},${y})`}>
                                  <text
                                    x={0}
                                    y={0}
                                    textAnchor="middle"
                                    fontSize={12}
                                  >
                                    <tspan x={0} dy={16} fill={themeColors.chartBar2}>{line1}</tspan>
                                    {line2 && <tspan x={0} dy={14} fill={themeColors.textMuted}>{line2}</tspan>}
                                  </text>
                                </g>
                              )
                            }}
                            height={100}
                          />
                          <YAxis
                            stroke={themeColors.chartAxis}
                            tick={{ fill: themeColors.chartAxis }}
                          />
                          <Tooltip
                            cursor={{ fill: 'rgba(99, 130, 191, 0.08)' }}
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                const data = payload[0].payload

                                // Split character and cloth
                                const dashIndex = data.name.indexOf('-')
                                let character = data.name
                                let cloth = ''

                                if (dashIndex !== -1) {
                                  character = data.name.substring(0, dashIndex)
                                  cloth = data.name.substring(dashIndex + 1)
                                }

                                return (
                                  <div className="custom-chart-tooltip">
                                    {data.thumbnail && (
                                      <img
                                        src={data.thumbnail}
                                        alt={data.name}
                                        className="tooltip-preview"
                                      />
                                    )}
                                    <div className="tooltip-info">
                                      <p className="tooltip-label">{character}</p>
                                      {cloth && <p className="tooltip-cloth">{cloth}</p>}
                                      <p className="tooltip-value">Downloads: {data.downloadCount}</p>
                                    </div>
                                  </div>
                                )
                              }
                              return null
                            }}
                          />
                          <Bar dataKey="downloadCount" fill={themeColors.chartBar1} radius={[8, 8, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="chart-row">
                      <div className="chart-container half-width">
                        <h4>LoRAs by Gender</h4>
                        <ResponsiveContainer width="100%" height={180}>
                          <PieChart>
                            <Pie
                              data={Object.entries(statistics.loras.byGender).map(([key, value]) => ({
                                name: key,
                                value: value
                              }))}
                              cx="50%"
                              cy="50%"
                              labelLine={false}
                              label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                              outerRadius={60}
                              fill={themeColors.chartPie1}
                              dataKey="value"
                            >
                              {Object.keys(statistics.loras.byGender).map((_, index) => (
                                <Cell key={`cell-${index}`} fill={[themeColors.chartPie1, themeColors.chartCostume, themeColors.chartPie2][index % 3]} />
                              ))}
                            </Pie>
                            <Tooltip
                              contentStyle={{
                                backgroundColor: themeColors.tooltipBg,
                                border: `1px solid ${themeColors.tooltipBorder}`,
                                borderRadius: '8px',
                                color: themeColors.textPrimary
                              }}
                              itemStyle={{
                                color: themeColors.textPrimary
                              }}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="chart-container half-width">
                        <h4>LoRAs by Model</h4>
                        <ResponsiveContainer width="100%" height={180}>
                          <PieChart>
                            <Pie
                              data={Object.entries(statistics.loras.byModel).map(([key, value]) => ({
                                name: key,
                                value: value
                              }))}
                              cx="50%"
                              cy="50%"
                              labelLine={false}
                              label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                              outerRadius={60}
                              fill={themeColors.chartPie1}
                              dataKey="value"
                            >
                              {Object.keys(statistics.loras.byModel).map((_, index) => (
                                <Cell key={`cell-${index}`} fill={[themeColors.chartPie1, themeColors.chartPie2, themeColors.chartPie3, themeColors.chartPie4, themeColors.chartPie5][index % 5]} />
                              ))}
                            </Pie>
                            <Tooltip
                              contentStyle={{
                                backgroundColor: themeColors.tooltipBg,
                                border: `1px solid ${themeColors.tooltipBorder}`,
                                borderRadius: '8px',
                                color: themeColors.textPrimary
                              }}
                              itemStyle={{
                                color: themeColors.textPrimary
                              }}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'changelog' && (
            <div className="tab-content">
              <Changelog />
            </div>
          )}

          {auth.isWhitelisted && activeTab === 'workflow' && (
            <div className="tab-content">
              <Workflow
                isLoggedIn={isLoggedIn}
                adminMode={adminMode}
                onAdminLogout={handleAdminLogout}
                onAdminModeToggle={handleAdminModeToggle}
              />
            </div>
          )}

          {auth.isAdmin && activeTab === 'users' && (
            <div className="tab-content">
              <AdminUsersPanel />
            </div>
          )}

          {!auth.isWhitelisted && activeTab !== 'lora' && activeTab !== 'changelog' && activeTab !== 'users' && (
            <div className="tab-content">
              <AccessGate />
            </div>
          )}
        </div>
      </div>

      {selectedPrompt && (
        <div className="popup-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, closePopup)}>
          <div className="popup-content" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={closePopup}>×</button>

            <div className={`popup-images ${selectedPrompt.imageOrientation === 'landscape' ? 'landscape' : 'portrait'}`}>
              {selectedPrompt.images.map((image, index) => (
                <img key={index} src={image} alt={`Image ${index + 1}`} />
              ))}
            </div>

            <div className="prompt-author">
              Author: {selectedPrompt.author}
            </div>

            <div className="prompt-meta-info">
              {selectedPrompt.character && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">Character:</span>
                  <span className="prompt-meta-value">{selectedPrompt.character}</span>
                </div>
              )}
              {selectedPrompt.place && selectedPrompt.place !== 'Unknown' && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">Place:</span>
                  <span className="prompt-meta-value">{selectedPrompt.place}</span>
                </div>
              )}
              {selectedPrompt.type && selectedPrompt.type !== 'Unknown' && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">Type:</span>
                  <span className="prompt-meta-value">{selectedPrompt.type}</span>
                </div>
              )}
              {selectedPrompt.view && selectedPrompt.view !== 'Unknown' && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">View:</span>
                  <span className="prompt-meta-value">{selectedPrompt.view}</span>
                </div>
              )}
              {selectedPrompt.stability && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">Stability:</span>
                  <span className={`stability-badge stability-${selectedPrompt.stability}`}>
                    S{selectedPrompt.stability}
                  </span>
                </div>
              )}
            </div>

            {selectedPrompt.usedFnLoras && selectedPrompt.usedFnLoras.length > 0 && (
              <div className="prompt-fn-loras-section">
                <span className="prompt-fn-loras-label">Functional LoRA:</span>
                <div className="fn-lora-tags">
                  {selectedPrompt.usedFnLoras.map((loraId, index) => {
                    const fnLora = fnLoras.find(l => l.id === loraId)
                    return (
                      <span 
                        key={index} 
                        className="fn-lora-tag clickable"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedPrompt(null) // 關閉 prompt 燈箱
                          setActiveTab('fnlora') // 切換到 Fn LoRA tab
                          if (fnLora) {
                            setTimeout(() => setSelectedFnLora(fnLora), 100) // 開啟對應的 Fn LoRA 燈箱
                          }
                        }}
                        title={fnLora ? `View ${fnLora.name}` : ''}
                      >
                        {fnLora ? fnLora.name : loraId}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Copy Buttons */}
            <div className="copy-buttons-row">
              <button
                className="copy-button"
                onClick={() => handleCopyPrompt(selectedPrompt.prompt, selectedPrompt.id, 'prompt')}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy Prompt
              </button>
              <button
                className={`copy-button copy-negative ${!selectedPrompt.negativePrompt ? 'disabled' : ''}`}
                onClick={() => selectedPrompt.negativePrompt && handleCopyPrompt(selectedPrompt.negativePrompt, selectedPrompt.id, 'prompt')}
                disabled={!selectedPrompt.negativePrompt}
                title={selectedPrompt.negativePrompt ? 'Copy negative prompt' : 'No negative prompt'}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy Negative
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Costume Popup */}
      {selectedCostume && (
        <div className="popup-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, () => setSelectedCostume(null))}>
          <div className="popup-content" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={() => setSelectedCostume(null)}>×</button>

            <div className={`popup-images ${selectedCostume.imageOrientation === 'landscape' ? 'landscape' : 'portrait'}`}>
              {selectedCostume.images.map((image, index) => (
                <img key={index} src={image} alt={`Image ${index + 1}`} />
              ))}
            </div>

            <div className="prompt-author">
              Author: {selectedCostume.author}
            </div>

            <div className="prompt-meta-info">
              {selectedCostume.character && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">Character:</span>
                  <span className="prompt-meta-value">{selectedCostume.character}</span>
                </div>
              )}
              {selectedCostume.place && selectedCostume.place !== 'Unknown' && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">Place:</span>
                  <span className="prompt-meta-value">{selectedCostume.place}</span>
                </div>
              )}
              {selectedCostume.type && selectedCostume.type !== 'Unknown' && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">Type:</span>
                  <span className="prompt-meta-value">{selectedCostume.type}</span>
                </div>
              )}
              {selectedCostume.view && selectedCostume.view !== 'Unknown' && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">View:</span>
                  <span className="prompt-meta-value">{selectedCostume.view}</span>
                </div>
              )}
              {selectedCostume.stability && (
                <div className="prompt-meta-item">
                  <span className="prompt-meta-label">Stability:</span>
                  <span className={`stability-badge stability-${selectedCostume.stability}`}>
                    S{selectedCostume.stability}
                  </span>
                </div>
              )}
            </div>

            <div className="copy-buttons-group">
              <button
                className="copy-button costume-copy"
                onClick={() => handleCopyPrompt(selectedCostume.costumePrompt, selectedCostume.id, 'costume')}
                disabled={!selectedCostume.costumePrompt}
                title={selectedCostume.costumePrompt ? 'Copy costume-only prompt' : 'Costume prompt not available'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy Costume
              </button>
              <button
                className="copy-button scene-copy"
                onClick={() => handleCopyPrompt(selectedCostume.prompt, selectedCostume.id, 'costume')}
                disabled={!selectedCostume.prompt}
                title={selectedCostume.prompt ? 'Copy costume + scene prompt' : 'Scene prompt not available'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy Scene
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt Edit Modal (Admin Mode) */}
      {isEditingPrompt && editPromptData && (
        <div className="popup-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, handleCloseEditPrompt)}>
          <div className="popup-content edit-mode" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={handleCloseEditPrompt}>×</button>

            <h3 className="edit-modal-title">
              {isCreatingPrompt ? 'Create New Prompt' : `Edit Prompt #${editPromptData.id}`}
            </h3>

            {/* Hidden file input for image upload */}
            <input
              type="file"
              ref={imageInputRef}
              style={{ display: 'none' }}
              accept="image/png,image/jpeg,image/webp"
              onChange={handleImageUpload}
            />

            {/* Editable Images */}
            {isCreatingPrompt ? (
              // Create mode: show upload placeholders with previews
              <div className="popup-images edit-images portrait">
                <div className="edit-image-placeholder-container">
                  {[0, 1].map(index => (
                    <div
                      key={index}
                      className={`edit-image-placeholder ${pendingImages[index] ? 'has-image' : ''}`}
                      onClick={() => handleImageClick(index)}
                    >
                      {editPromptData.editedImages[index] ? (
                        <>
                          <img src={editPromptData.editedImages[index]} alt={`Preview ${index + 1}`} />
                          <div className="edit-image-overlay">
                            <span>📷 Click to replace</span>
                          </div>
                        </>
                      ) : (
                        <span>📷 Click to upload Image {index + 1} {index === 0 ? <span className="required">*</span> : '(optional)'}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : editPromptData.id ? (
              // Edit mode: show existing images or upload placeholders
              <div className={`popup-images edit-images ${editPromptData.imageOrientation === 'landscape' ? 'landscape' : 'portrait'}`}>
                {editPromptData.editedImages.length > 0 ? (
                  editPromptData.editedImages.map((image, index) => (
                    <div
                      key={index}
                      className="edit-image-container"
                      onClick={() => handleImageClick(index)}
                    >
                      <img src={image} alt={`Image ${index + 1}`} />
                      <div className="edit-image-overlay">
                        <span>📷 Click to replace</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="edit-image-placeholder-container">
                    <div
                      className="edit-image-placeholder"
                      onClick={() => handleImageClick(0)}
                    >
                      <span>📷 Click to upload Image 1</span>
                    </div>
                    <div
                      className="edit-image-placeholder"
                      onClick={() => handleImageClick(1)}
                    >
                      <span>📷 Click to upload Image 2</span>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {/* Datalists for autocomplete */}
            <datalist id="place-options">
              {promptFieldOptions.place.map(opt => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
            <datalist id="type-options">
              {promptFieldOptions.type.map(opt => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
            <datalist id="view-options">
              {promptFieldOptions.view.map(opt => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
            <datalist id="nudity-options">
              {promptFieldOptions.nudity.map(opt => (
                <option key={opt} value={opt} />
              ))}
            </datalist>

            {/* Editable Meta Fields */}
            <div className="edit-form">
              <div className="edit-field full-width">
                <label>Title: {isCreatingPrompt && <span className="required">*</span>}</label>
                <input
                  type="text"
                  value={editPromptData.editedTitle}
                  onChange={(e) => setEditPromptData(prev => ({ ...prev, editedTitle: e.target.value }))}
                  placeholder="Enter prompt title..."
                />
              </div>

              <div className="edit-field">
                <label>Author:</label>
                <input
                  type="text"
                  value={editPromptData.editedAuthor}
                  onChange={(e) => setEditPromptData(prev => ({ ...prev, editedAuthor: e.target.value }))}
                />
              </div>

              <div className="edit-field-grid">
                <div className="edit-field">
                  <label>Character:</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={editPromptData.editedCharacter}
                    onChange={(e) => setEditPromptData(prev => ({ ...prev, editedCharacter: e.target.value }))}
                  />
                </div>

                <div className="edit-field">
                  <label>Place: <span className="required">*</span></label>
                  <input
                    type="text"
                    list="place-options"
                    value={editPromptData.editedPlace}
                    onChange={(e) => setEditPromptData(prev => ({ ...prev, editedPlace: e.target.value }))}
                    placeholder="Type or select..."
                  />
                </div>

                <div className="edit-field">
                  <label>Sensitivity:</label>
                  <select
                    value={editPromptData.editedSensitive}
                    onChange={(e) => setEditPromptData(prev => ({ ...prev, editedSensitive: e.target.value }))}
                  >
                    <option value="SFW">SFW</option>
                    <option value="NSFW">NSFW</option>
                  </select>
                </div>

                <div className="edit-field">
                  <label>Type: <span className="required">*</span></label>
                  <input
                    type="text"
                    list="type-options"
                    value={editPromptData.editedType}
                    onChange={(e) => setEditPromptData(prev => ({ ...prev, editedType: e.target.value }))}
                    placeholder="Type or select..."
                  />
                </div>

                <div className="edit-field">
                  <label>View: <span className="required">*</span></label>
                  <input
                    type="text"
                    list="view-options"
                    value={editPromptData.editedView}
                    onChange={(e) => setEditPromptData(prev => ({ ...prev, editedView: e.target.value }))}
                    placeholder="Type or select..."
                  />
                </div>

                <div className="edit-field">
                  <label>Nudity: <span className="required">*</span></label>
                  <input
                    type="text"
                    list="nudity-options"
                    value={editPromptData.editedNudity}
                    onChange={(e) => setEditPromptData(prev => ({ ...prev, editedNudity: e.target.value }))}
                    placeholder="Type or select..."
                  />
                </div>

                <div className="edit-field">
                  <label>Stability:</label>
                  <select
                    value={editPromptData.editedStability}
                    onChange={(e) => setEditPromptData(prev => ({ ...prev, editedStability: e.target.value }))}
                  >
                    <option value="1">S1 - High</option>
                    <option value="2">S2 - Medium</option>
                    <option value="3">S3 - Low</option>
                  </select>
                </div>
              </div>

              {/* Fn LoRA Selection */}
              <div className="edit-field full-width">
                <label>Fn LoRA Used:</label>
                <div className="fn-lora-selector">
                  <div className="fn-lora-selected-tags">
                    {(editPromptData.editedUsedFnLoras || []).map((loraId, index) => {
                      const fnLora = fnLoras.find(l => l.id === loraId)
                      return (
                        <span key={index} className="fn-lora-tag editable">
                          {fnLora ? fnLora.name : loraId}
                          <button
                            className="fn-lora-tag-remove"
                            onClick={() => setEditPromptData(prev => ({
                              ...prev,
                              editedUsedFnLoras: prev.editedUsedFnLoras.filter(id => id !== loraId)
                            }))}
                          >
                            ×
                          </button>
                        </span>
                      )
                    })}
                  </div>
                  <select
                    className="fn-lora-add-select"
                    value=""
                    onChange={(e) => {
                      if (e.target.value && !editPromptData.editedUsedFnLoras?.includes(e.target.value)) {
                        setEditPromptData(prev => ({
                          ...prev,
                          editedUsedFnLoras: [...(prev.editedUsedFnLoras || []), e.target.value]
                        }))
                      }
                    }}
                  >
                    <option value="">+ Add Fn LoRA...</option>
                    {fnLoras
                      .filter(lora => !editPromptData.editedUsedFnLoras?.includes(lora.id))
                      .map(lora => (
                        <option key={lora.id} value={lora.id}>{lora.name}</option>
                      ))
                    }
                  </select>
                </div>
              </div>

              {/* Editable Prompt Text */}
              <div className="edit-field full-width">
                <label>Prompt:</label>
                <textarea
                  value={editPromptData.editedPrompt}
                  onChange={(e) => setEditPromptData(prev => ({ ...prev, editedPrompt: e.target.value }))}
                  rows={6}
                  placeholder="Enter prompt text..."
                />
              </div>

              <div className="edit-field full-width">
                <label>Negative Prompt:</label>
                <textarea
                  value={editPromptData.editedNegativePrompt}
                  onChange={(e) => setEditPromptData(prev => ({ ...prev, editedNegativePrompt: e.target.value }))}
                  rows={4}
                  placeholder="Enter negative prompt (optional)..."
                />
              </div>
            </div>

            {!isCreatingPrompt && (
              <div className="edit-note-block">
                <label className="edit-note-label" htmlFor="edit-note-prompt">Change note (optional)</label>
                <div className="edit-note-hint">
                  Shown in the Discord notification. Leave blank to auto-list the changed fields.
                </div>
                <textarea
                  id="edit-note-prompt"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  maxLength={500}
                  placeholder="Describe what you changed and why…"
                />
              </div>
            )}

            {/* Action Buttons */}
            <div className="edit-actions">
              <button className="cancel-button" onClick={handleCloseEditPrompt}>
                Cancel
              </button>
              <button className="update-button" onClick={handleUpdatePrompt}>
                {isCreatingPrompt ? 'Create Prompt' : 'Update Prompt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Costume Edit Modal (Admin Mode) */}
      {isEditingCostume && editCostumeData && (
        <div className="popup-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, handleCloseEditCostume)}>
          <div className="popup-content edit-mode" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={handleCloseEditCostume}>×</button>

            <h3 className="edit-modal-title">
              {isCreatingCostume ? 'Create New Costume' : `Edit Costume #${editCostumeData.id}`}
            </h3>

            {/* Hidden file input for image upload */}
            <input
              type="file"
              ref={costumeImageInputRef}
              style={{ display: 'none' }}
              accept="image/png,image/jpeg,image/webp"
              onChange={handleCostumeImageUpload}
            />

            {/* Editable Images */}
            {isCreatingCostume ? (
              <div className="popup-images edit-images portrait">
                <div className="edit-image-placeholder-container">
                  {[0, 1].map(index => (
                    <div
                      key={index}
                      className={`edit-image-placeholder ${pendingCostumeImages[index] ? 'has-image' : ''}`}
                      onClick={() => handleCostumeImageClick(index)}
                    >
                      {editCostumeData.editedImages[index] ? (
                        <>
                          <img src={editCostumeData.editedImages[index]} alt={`Preview ${index + 1}`} />
                          <div className="edit-image-overlay">
                            <span>📷 Click to replace</span>
                          </div>
                        </>
                      ) : (
                        <span>📷 Click to upload Image {index + 1} {index === 0 ? <span className="required">*</span> : '(optional)'}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : editCostumeData.id ? (
              <div className={`popup-images edit-images ${editCostumeData.imageOrientation === 'landscape' ? 'landscape' : 'portrait'}`}>
                {editCostumeData.editedImages.length > 0 ? (
                  editCostumeData.editedImages.map((image, index) => (
                    <div
                      key={index}
                      className="edit-image-container"
                      onClick={() => handleCostumeImageClick(index)}
                    >
                      <img src={image} alt={`Image ${index + 1}`} />
                      <div className="edit-image-overlay">
                        <span>📷 Click to replace</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="edit-image-placeholder-container">
                    <div
                      className="edit-image-placeholder"
                      onClick={() => handleCostumeImageClick(0)}
                    >
                      <span>📷 Click to upload Image 1</span>
                    </div>
                    <div
                      className="edit-image-placeholder"
                      onClick={() => handleCostumeImageClick(1)}
                    >
                      <span>📷 Click to upload Image 2</span>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {/* Datalists for autocomplete */}
            <datalist id="costume-type-options">
              {costumeMetadata.typeOrder.map(opt => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
            <datalist id="costume-place-options">
              {promptFieldOptions.place.map(opt => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
            <datalist id="costume-view-options">
              {promptFieldOptions.view.map(opt => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
            <datalist id="costume-nudity-options">
              {promptFieldOptions.nudity.map(opt => (
                <option key={opt} value={opt} />
              ))}
            </datalist>

            {/* Editable Meta Fields */}
            <div className="edit-form">
              <div className="edit-field full-width">
                <label>Title: {isCreatingCostume && <span className="required">*</span>}</label>
                <input
                  type="text"
                  value={editCostumeData.editedTitle}
                  onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedTitle: e.target.value }))}
                  placeholder="Enter costume title..."
                />
              </div>

              <div className="edit-field">
                <label>Author:</label>
                <input
                  type="text"
                  value={editCostumeData.editedAuthor}
                  onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedAuthor: e.target.value }))}
                />
              </div>

              <div className="edit-field-grid">
                <div className="edit-field">
                  <label>Character:</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={editCostumeData.editedCharacter}
                    onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedCharacter: e.target.value }))}
                  />
                </div>

                <div className="edit-field">
                  <label>Place: <span className="required">*</span></label>
                  <input
                    type="text"
                    list="costume-place-options"
                    value={editCostumeData.editedPlace}
                    onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedPlace: e.target.value }))}
                    placeholder="Type or select..."
                  />
                </div>

                <div className="edit-field">
                  <label>Type: <span className="required">*</span></label>
                  <input
                    type="text"
                    list="costume-type-options"
                    value={editCostumeData.editedType}
                    onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedType: e.target.value }))}
                    placeholder="Type or select category..."
                  />
                </div>

                <div className="edit-field">
                  <label>Sensitivity:</label>
                  <select
                    value={editCostumeData.editedSensitive}
                    onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedSensitive: e.target.value }))}
                  >
                    <option value="SFW">SFW</option>
                    <option value="NSFW">NSFW</option>
                  </select>
                </div>

                <div className="edit-field">
                  <label>View: <span className="required">*</span></label>
                  <input
                    type="text"
                    list="costume-view-options"
                    value={editCostumeData.editedView}
                    onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedView: e.target.value }))}
                    placeholder="Type or select..."
                  />
                </div>

                <div className="edit-field">
                  <label>Nudity: <span className="required">*</span></label>
                  <input
                    type="text"
                    list="costume-nudity-options"
                    value={editCostumeData.editedNudity}
                    onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedNudity: e.target.value }))}
                    placeholder="Type or select..."
                  />
                </div>

                <div className="edit-field">
                  <label>Stability:</label>
                  <select
                    value={editCostumeData.editedStability}
                    onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedStability: e.target.value }))}
                  >
                    <option value="1">S1 - High</option>
                    <option value="2">S2 - Medium</option>
                    <option value="3">S3 - Low</option>
                  </select>
                </div>
              </div>

              {/* Editable Costume Prompt (Pure clothing) */}
              <div className="edit-field full-width">
                <label>👗 Costume Prompt (clothing only):</label>
                <textarea
                  value={editCostumeData.editedCostumePrompt}
                  onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedCostumePrompt: e.target.value }))}
                  rows={4}
                  placeholder="Enter pure costume/clothing description..."
                />
              </div>

              {/* Editable Scene Prompt (Costume + Scene) */}
              <div className="edit-field full-width">
                <label>🎬 Scene Prompt (costume + scene):</label>
                <textarea
                  value={editCostumeData.editedPrompt}
                  onChange={(e) => setEditCostumeData(prev => ({ ...prev, editedPrompt: e.target.value }))}
                  rows={6}
                  placeholder="Enter full scene prompt with costume..."
                />
              </div>
            </div>

            {!isCreatingCostume && (
              <div className="edit-note-block">
                <label className="edit-note-label" htmlFor="edit-note-costume">Change note (optional)</label>
                <div className="edit-note-hint">
                  Shown in the Discord notification. Leave blank to auto-list the changed fields.
                </div>
                <textarea
                  id="edit-note-costume"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  maxLength={500}
                  placeholder="Describe what you changed and why…"
                />
              </div>
            )}

            {/* Action Buttons */}
            <div className="edit-actions">
              <button className="cancel-button" onClick={handleCloseEditCostume}>
                Cancel
              </button>
              <button className="update-button" onClick={handleUpdateCostume}>
                {isCreatingCostume ? 'Create Costume' : 'Update Costume'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LoRA Edit Modal */}
      {isEditingLora && editLoraData && (
        <div className="popup-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, handleCloseEditLora)}>
          <div className="popup-content edit-mode lora-edit-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={handleCloseEditLora}>×</button>

            <h3 className="edit-modal-title">
              {isCreatingLora ? '✨ Create New LoRA' : `✏️ Edit: ${editLoraData.character || 'LoRA'}`}
            </h3>

            {/* Thumbnail Upload (Shared) */}
            <div className="edit-images">
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'block' }}>
                📷 Thumbnail (shared across all versions):
              </label>
              <div
                className={`edit-image-placeholder ${pendingLoraThumbnail || (!isCreatingLora && editLoraData.thumbnail) ? 'has-image' : ''}`}
                onClick={() => {
                  setUploadingLoraImageIndex(0)
                  loraImageInputRef.current?.click()
                }}
                style={{ aspectRatio: '1', width: '120px', height: '120px' }}
              >
                {pendingLoraThumbnail ? (
                  <>
                    <img src={URL.createObjectURL(pendingLoraThumbnail)} alt="Thumbnail preview" />
                    <div className="edit-image-overlay"><span>Change</span></div>
                  </>
                ) : !isCreatingLora && editLoraData.thumbnail ? (
                  <>
                    <img src={editLoraData.thumbnail} alt="Thumbnail" />
                    <div className="edit-image-overlay"><span>Change</span></div>
                  </>
                ) : (
                  <span>📷 Square</span>
                )}
              </div>
            </div>

            {/* Model JSON Editor */}
            <div className="edit-field full-width" style={{ marginTop: '1rem' }}>
              <label>Model Versions (JSON):</label>
              <textarea
                value={editLoraData.editedModelJson || '[]'}
                onChange={(e) => {
                  setEditLoraData(prev => ({ ...prev, editedModelJson: e.target.value }))
                  // Try to parse and update editedModel
                  try {
                    const parsed = JSON.parse(e.target.value)
                    if (Array.isArray(parsed)) {
                      setEditLoraData(prev => ({ ...prev, editedModel: parsed }))
                    }
                  } catch (err) {
                    // Invalid JSON, ignore
                  }
                }}
                rows={3}
                placeholder='[{"name": "Illustrious", "version": "v2.0"}]'
                style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
              />
            </div>

            {/* Version Tabs for Images */}
            {editLoraData.editedModel && editLoraData.editedModel.length > 0 && (
              <div className="lora-version-image-section">
                <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'block' }}>
                  🖼️ Version Images (click tab to switch):
                </label>
                
                {/* Version Tabs */}
                <div className="lora-edit-version-tabs">
                  {editLoraData.editedModel.map((model, idx) => (
                    <button
                      key={idx}
                      className={`lora-edit-version-tab ${editLoraSelectedVersion === idx ? 'active' : ''}`}
                      onClick={() => setEditLoraSelectedVersion(idx)}
                    >
                      {model.name}
                    </button>
                  ))}
                </div>

                {/* Images for Selected Version */}
                {(() => {
                  const currentModel = editLoraData.editedModel[editLoraSelectedVersion]
                  if (!currentModel) return null
                  const versionName = currentModel.name.toLowerCase()
                  const versionImages = pendingLoraVersionImages[versionName] || [null, null]
                  // Find existing images from versions
                  const existingVersion = editLoraData.versions?.find(v => v.name.toLowerCase() === versionName)
                  const existingImages = existingVersion?.images || []

                  return (
                    <div className="edit-image-placeholder-container" style={{ marginTop: '0.5rem' }}>
                      {/* Image 1 */}
                      <div
                        className={`edit-image-placeholder ${versionImages[0] || existingImages[0] ? 'has-image' : ''}`}
                        onClick={() => {
                          setUploadingLoraImageIndex(1)
                          loraImageInputRef.current?.click()
                        }}
                      >
                        {versionImages[0] ? (
                          <>
                            <img src={URL.createObjectURL(versionImages[0])} alt="Preview 1" />
                            <div className="edit-image-overlay"><span>Change</span></div>
                          </>
                        ) : existingImages[0] ? (
                          <>
                            <img src={existingImages[0]} alt="Preview 1" />
                            <div className="edit-image-overlay"><span>Change</span></div>
                          </>
                        ) : (
                          <span>🖼️ Image 1<br/>({currentModel.name})</span>
                        )}
                      </div>

                      {/* Image 2 */}
                      <div
                        className={`edit-image-placeholder ${versionImages[1] || existingImages[1] ? 'has-image' : ''}`}
                        onClick={() => {
                          setUploadingLoraImageIndex(2)
                          loraImageInputRef.current?.click()
                        }}
                      >
                        {versionImages[1] ? (
                          <>
                            <img src={URL.createObjectURL(versionImages[1])} alt="Preview 2" />
                            <div className="edit-image-overlay"><span>Change</span></div>
                          </>
                        ) : existingImages[1] ? (
                          <>
                            <img src={existingImages[1]} alt="Preview 2" />
                            <div className="edit-image-overlay"><span>Change</span></div>
                          </>
                        ) : (
                          <span>🖼️ Image 2<br/>({currentModel.name})</span>
                        )}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            <input
              ref={loraImageInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files[0] && uploadingLoraImageIndex !== null) {
                  handleLoraImageSelect(uploadingLoraImageIndex, e.target.files[0])
                }
                e.target.value = ''
              }}
            />

            {/* Form Fields */}
            <div className="edit-field-grid" style={{ marginTop: '1rem' }}>
              <div className="edit-field">
                <label>Character: <span className="required">*</span></label>
                <input
                  type="text"
                  value={editLoraData.editedCharacter}
                  onChange={(e) => setEditLoraData(prev => ({ ...prev, editedCharacter: e.target.value }))}
                  placeholder="Character name"
                />
              </div>

              <div className="edit-field">
                <label>Cloth/Version:</label>
                <input
                  type="text"
                  value={editLoraData.editedCloth}
                  onChange={(e) => setEditLoraData(prev => ({ ...prev, editedCloth: e.target.value }))}
                  placeholder="e.g., 1.0, 2.0, Swimsuit"
                />
              </div>

              <div className="edit-field">
                <label>Gender:</label>
                <select
                  value={editLoraData.editedGender}
                  onChange={(e) => setEditLoraData(prev => ({ ...prev, editedGender: e.target.value }))}
                >
                  <option value="Girl">Girl</option>
                  <option value="Boy">Boy</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div className="edit-field">
                <label>Char Count:</label>
                <input
                  type="number"
                  min="1"
                  value={editLoraData.editedCharacterCount}
                  onChange={(e) => setEditLoraData(prev => ({ ...prev, editedCharacterCount: e.target.value }))}
                  placeholder="1"
                />
              </div>

              <div className="edit-field">
                <label>Company:</label>
                <input
                  type="text"
                  list="lora-company-options"
                  value={editLoraData.editedCompany}
                  onChange={(e) => setEditLoraData(prev => ({ ...prev, editedCompany: e.target.value }))}
                  placeholder=""
                />
              </div>

              <div className="edit-field">
                <label>Group:</label>
                <input
                  type="text"
                  list="lora-group-options"
                  value={editLoraData.editedGroup}
                  onChange={(e) => setEditLoraData(prev => ({ ...prev, editedGroup: e.target.value }))}
                  placeholder=""
                />
              </div>

              <div className="edit-field">
                <label>Link:</label>
                <input
                  type="text"
                  value={editLoraData.editedLink}
                  onChange={(e) => setEditLoraData(prev => ({ ...prev, editedLink: e.target.value }))}
                  placeholder=""
                />
              </div>
            </div>

            {/* Prompt */}
            <div className="edit-field full-width">
              <label>Prompt:</label>
              <textarea
                value={editLoraData.editedPrompt}
                onChange={(e) => setEditLoraData(prev => ({ ...prev, editedPrompt: e.target.value }))}
                rows={4}
                placeholder="LoRA trigger prompt..."
              />
            </div>

            {/* Datalists for autocomplete */}
            <datalist id="lora-company-options">
              {getLoraUniqueValues('company').map(val => (
                <option key={val} value={val} />
              ))}
            </datalist>
            <datalist id="lora-group-options">
              {getLoraUniqueValues('group').map(val => (
                <option key={val} value={val} />
              ))}
            </datalist>

            {/* Safetensors Upload */}
            {editLoraData.editedModel && editLoraData.editedModel.length > 0 && (
              <div className="safetensors-upload-section" style={{ marginTop: '1rem' }}>
                <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'block' }}>
                  📁 Upload .safetensors file for: {editLoraData.editedModel[editLoraSelectedVersion]?.name || 'Select a version'}
                </label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    className="safetensors-upload-btn"
                    onClick={() => document.getElementById('lora-safetensors-input')?.click()}
                    style={{
                      padding: '0.5rem 1rem',
                      background: 'var(--accent-bg)',
                      border: '1px solid var(--border-hover)',
                      borderRadius: '6px',
                      color: 'var(--accent-secondary)',
                      cursor: 'pointer'
                    }}
                  >
                    {pendingLoraSafetensors[editLoraData.editedModel[editLoraSelectedVersion]?.name?.toLowerCase()] 
                      ? `✓ ${pendingLoraSafetensors[editLoraData.editedModel[editLoraSelectedVersion]?.name?.toLowerCase()].name}`
                      : '📁 Upload .safetensors'}
                  </button>
                  {pendingLoraSafetensors[editLoraData.editedModel[editLoraSelectedVersion]?.name?.toLowerCase()] && (
                    <button
                      onClick={() => {
                        const versionName = editLoraData.editedModel[editLoraSelectedVersion]?.name?.toLowerCase()
                        setPendingLoraSafetensors(prev => {
                          const newState = { ...prev }
                          delete newState[versionName]
                          return newState
                        })
                      }}
                      style={{
                        padding: '0.5rem',
                        background: 'rgba(239, 68, 68, 0.2)',
                        border: '1px solid rgba(239, 68, 68, 0.5)',
                        borderRadius: '6px',
                        color: '#f87171',
                        cursor: 'pointer'
                      }}
                    >
                      ✗
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Hidden input for safetensors upload */}
            <input
              id="lora-safetensors-input"
              type="file"
              ref={loraSafetensorsInputRef}
              style={{ display: 'none' }}
              accept=".safetensors,application/octet-stream"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file && editLoraData.editedModel?.[editLoraSelectedVersion]) {
                  const versionName = editLoraData.editedModel[editLoraSelectedVersion].name.toLowerCase()
                  setPendingLoraSafetensors(prev => ({ ...prev, [versionName]: file }))
                }
                e.target.value = ''
              }}
            />

            {!isCreatingLora && (
              <div className="edit-note-block">
                <label className="edit-note-label" htmlFor="edit-note-lora">Change note (optional)</label>
                <div className="edit-note-hint">
                  Shown in the Discord notification. Leave blank to auto-list the changed fields.
                </div>
                <textarea
                  id="edit-note-lora"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  maxLength={500}
                  placeholder="Describe what you changed and why…"
                />
              </div>
            )}

            {/* Actions */}
            <div className="edit-actions">
              {!isCreatingLora && (
                <button className="cancel-button" onClick={handleDeleteLora} style={{ background: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgba(239, 68, 68, 0.5)', color: '#f87171' }}>
                  🗑️ Delete
                </button>
              )}
              <button className="cancel-button" onClick={handleCloseEditLora}>
                Cancel
              </button>
              <button className="update-button" onClick={handleUpdateLora}>
                {isCreatingLora ? 'Create LoRA' : 'Update LoRA'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fn LoRA Edit Modal */}
      {isEditingFnLora && editFnLoraData && (
        <div className="popup-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, handleCloseEditFnLora)}>
          <div className="popup-content edit-mode lora-edit-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={handleCloseEditFnLora}>×</button>

            <h3 className="edit-modal-title">
              {isCreatingFnLora ? '✨ Create New Fn LoRA' : `✏️ Edit: ${editFnLoraData.editedTitle || 'Fn LoRA'}`}
            </h3>

            {/* Thumbnail Upload (Shared) */}
            <div className="edit-images">
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'block' }}>
                📷 Thumbnail (shared across all versions):
              </label>
              <div
                className={`edit-image-placeholder ${pendingFnLoraThumbnail || (!isCreatingFnLora && editFnLoraData.thumbnail) ? 'has-image' : ''}`}
                onClick={() => {
                  setUploadingLoraImageIndex(0)
                  fnLoraImageInputRef.current?.click()
                }}
                style={{ aspectRatio: '1', width: '120px', height: '120px' }}
              >
                {pendingFnLoraThumbnail ? (
                  <>
                    <img src={URL.createObjectURL(pendingFnLoraThumbnail)} alt="Thumbnail preview" />
                    <div className="edit-image-overlay"><span>Change</span></div>
                  </>
                ) : !isCreatingFnLora && editFnLoraData.thumbnail ? (
                  <>
                    <img src={editFnLoraData.thumbnail} alt="Thumbnail" />
                    <div className="edit-image-overlay"><span>Change</span></div>
                  </>
                ) : (
                  <span>📷 Square</span>
                )}
              </div>
            </div>

            {/* Model JSON Editor */}
            <div className="edit-field full-width" style={{ marginTop: '1rem' }}>
              <label>Model Versions (JSON):</label>
              <textarea
                value={editFnLoraData.editedModelJson || '[]'}
                onChange={(e) => {
                  setEditFnLoraData(prev => ({ ...prev, editedModelJson: e.target.value }))
                  try {
                    const parsed = JSON.parse(e.target.value)
                    if (Array.isArray(parsed)) {
                      setEditFnLoraData(prev => ({ ...prev, editedModel: parsed }))
                    }
                  } catch (err) {}
                }}
                rows={3}
                placeholder='[{"name": "Illustrious", "version": "v2.0"}]'
                style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
              />
            </div>

            {/* Version Tabs for Images */}
            {editFnLoraData.editedModel && editFnLoraData.editedModel.length > 0 && (
              <div className="lora-version-image-section">
                <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'block' }}>
                  🖼️ Version Images (click tab to switch):
                </label>
                
                <div className="lora-edit-version-tabs">
                  {editFnLoraData.editedModel.map((model, idx) => (
                    <button
                      key={idx}
                      className={`lora-edit-version-tab ${editFnLoraSelectedVersion === idx ? 'active' : ''}`}
                      onClick={() => setEditFnLoraSelectedVersion(idx)}
                    >
                      {model.name}
                    </button>
                  ))}
                </div>

                {(() => {
                  const currentModel = editFnLoraData.editedModel[editFnLoraSelectedVersion]
                  if (!currentModel) return null
                  const versionName = currentModel.name.toLowerCase()
                  const versionImages = pendingFnLoraVersionImages[versionName] || [null, null]
                  const existingVersion = editFnLoraData.versions?.find(v => v.name.toLowerCase() === versionName)
                  const existingImages = existingVersion?.images || []

                  const pendingSafetensors = pendingFnLoraSafetensors[versionName]
                  const existingSafetensors = existingVersion?.fileName

                  return (
                    <div key={versionName}>
                      {/* Safetensors Upload */}
                      <div style={{ marginTop: '0.5rem', marginBottom: '0.75rem' }}>
                        <label style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', display: 'block', marginBottom: '0.25rem' }}>
                          📦 LoRA File ({currentModel.name}):
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <button
                            type="button"
                            className="safetensors-upload-btn"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              document.getElementById('fnlora-safetensors-input')?.click()
                            }}
                            style={{
                              padding: '0.5rem 1rem',
                              background: pendingSafetensors || existingSafetensors ? 'var(--accent-bg)' : 'var(--bg-secondary)',
                              border: `1px solid ${pendingSafetensors || existingSafetensors ? 'var(--accent-primary)' : 'var(--border-primary)'}`,
                              borderRadius: '8px',
                              color: pendingSafetensors || existingSafetensors ? 'var(--accent-primary)' : 'var(--text-secondary)',
                              cursor: 'pointer',
                              fontSize: '0.85rem'
                            }}
                          >
                            {pendingSafetensors ? `✓ ${pendingSafetensors.name}` : 
                             existingSafetensors ? `✓ ${existingSafetensors}` : 
                             '📁 Upload .safetensors'}
                          </button>
                          {(pendingSafetensors || existingSafetensors) && (
                            <span style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>
                              {pendingSafetensors ? '(pending upload)' : '(uploaded)'}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Version Images */}
                      <div className="edit-image-placeholder-container">
                        <div
                          className={`edit-image-placeholder ${versionImages[0] || existingImages[0] ? 'has-image' : ''}`}
                          onClick={() => {
                            setUploadingLoraImageIndex(1)
                            fnLoraImageInputRef.current?.click()
                          }}
                        >
                          {versionImages[0] ? (
                            <>
                              <img src={URL.createObjectURL(versionImages[0])} alt="Preview 1" />
                              <div className="edit-image-overlay"><span>Change</span></div>
                            </>
                          ) : existingImages[0] ? (
                            <>
                              <img src={existingImages[0]} alt="Preview 1" />
                              <div className="edit-image-overlay"><span>Change</span></div>
                            </>
                          ) : (
                            <span>🖼️ Image 1<br/>({currentModel.name})</span>
                          )}
                        </div>

                        <div
                          className={`edit-image-placeholder ${versionImages[1] || existingImages[1] ? 'has-image' : ''}`}
                          onClick={() => {
                            setUploadingLoraImageIndex(2)
                            fnLoraImageInputRef.current?.click()
                          }}
                        >
                          {versionImages[1] ? (
                            <>
                              <img src={URL.createObjectURL(versionImages[1])} alt="Preview 2" />
                              <div className="edit-image-overlay"><span>Change</span></div>
                            </>
                          ) : existingImages[1] ? (
                            <>
                              <img src={existingImages[1]} alt="Preview 2" />
                              <div className="edit-image-overlay"><span>Change</span></div>
                            </>
                          ) : (
                            <span>🖼️ Image 2<br/>({currentModel.name})</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            <input
              ref={fnLoraImageInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files[0] && uploadingLoraImageIndex !== null) {
                  handleFnLoraImageSelect(uploadingLoraImageIndex, e.target.files[0])
                }
                e.target.value = ''
              }}
            />

            {/* Hidden input for safetensors upload */}
            <input
              id="fnlora-safetensors-input"
              ref={fnLoraSafetensorsInputRef}
              type="file"
              accept=".safetensors,application/octet-stream"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) {
                  const currentModel = editFnLoraData?.editedModel?.[editFnLoraSelectedVersion]
                  if (currentModel) {
                    const versionName = currentModel.name.toLowerCase()
                    setPendingFnLoraSafetensors(prev => ({
                      ...prev,
                      [versionName]: file
                    }))
                  }
                }
                e.target.value = ''
              }}
            />

            {/* Form Fields */}
            <div className="edit-field-grid" style={{ marginTop: '1rem' }}>
              <div className="edit-field">
                <label>Title: <span className="required">*</span></label>
                <input
                  type="text"
                  value={editFnLoraData.editedTitle}
                  onChange={(e) => setEditFnLoraData(prev => ({ ...prev, editedTitle: e.target.value }))}
                  placeholder="e.g., Loli, Style Enhancement"
                />
              </div>

              <div className="edit-field">
                <label>Sub-Title:</label>
                <input
                  type="text"
                  value={editFnLoraData.editedSubTitle}
                  onChange={(e) => setEditFnLoraData(prev => ({ ...prev, editedSubTitle: e.target.value }))}
                  placeholder="e.g., Bratty, Cute"
                />
              </div>

              <div className="edit-field">
                <label>Type:</label>
                <input
                  type="text"
                  list="fnlora-type-options"
                  value={editFnLoraData.editedType}
                  onChange={(e) => setEditFnLoraData(prev => ({ ...prev, editedType: e.target.value }))}
                  placeholder="e.g., Style, Effect"
                />
              </div>

              <div className="edit-field">
                <label>Link:</label>
                <input
                  type="text"
                  value={editFnLoraData.editedLink}
                  onChange={(e) => setEditFnLoraData(prev => ({ ...prev, editedLink: e.target.value }))}
                  placeholder=""
                />
              </div>

              <div className="edit-field">
                <label>Stability:</label>
                <select
                  value={editFnLoraData.editedStability}
                  onChange={(e) => setEditFnLoraData(prev => ({ ...prev, editedStability: e.target.value }))}
                >
                  <option value="1">S1 - High</option>
                  <option value="2">S2 - Medium</option>
                  <option value="3">S3 - Low</option>
                </select>
              </div>

              <div className="edit-field">
                <label>Sensitivity:</label>
                <select
                  value={editFnLoraData.editedSensitive}
                  onChange={(e) => setEditFnLoraData(prev => ({ ...prev, editedSensitive: e.target.value }))}
                >
                  <option value="SFW">SFW</option>
                  <option value="NSFW">NSFW</option>
                </select>
              </div>

              <div className="edit-field">
                <label>Weight (0-1):</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={editFnLoraData.editedWeight}
                  onChange={(e) => setEditFnLoraData(prev => ({ ...prev, editedWeight: e.target.value }))}
                  placeholder="e.g., 0.8"
                  style={{ width: '80px' }}
                />
              </div>
            </div>

            {/* Prompt */}
            <div className="edit-field full-width">
              <label>Prompt:</label>
              <textarea
                value={editFnLoraData.editedPrompt}
                onChange={(e) => setEditFnLoraData(prev => ({ ...prev, editedPrompt: e.target.value }))}
                rows={4}
                placeholder="Fn LoRA trigger prompt..."
              />
            </div>

            {/* Datalists for autocomplete */}
            <datalist id="fnlora-type-options">
              {getFnLoraUniqueValues('type').map(val => (
                <option key={val} value={val} />
              ))}
            </datalist>

            {!isCreatingFnLora && (
              <div className="edit-note-block">
                <label className="edit-note-label" htmlFor="edit-note-fnlora">Change note (optional)</label>
                <div className="edit-note-hint">
                  Shown in the Discord notification. Leave blank to auto-list the changed fields.
                </div>
                <textarea
                  id="edit-note-fnlora"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  maxLength={500}
                  placeholder="Describe what you changed and why…"
                />
              </div>
            )}

            {/* Actions */}
            <div className="edit-actions">
              {!isCreatingFnLora && (
                <button className="cancel-button" onClick={handleDeleteFnLora} style={{ background: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgba(239, 68, 68, 0.5)', color: '#f87171' }}>
                  🗑️ Delete
                </button>
              )}
              <button className="cancel-button" onClick={handleCloseEditFnLora}>
                Cancel
              </button>
              <button className="update-button" onClick={handleUpdateFnLora}>
                {isCreatingFnLora ? 'Create Fn LoRA' : 'Update Fn LoRA'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt Admin Login Modal — removed; Discord OAuth handles login via <LoginButton> */}

      {selectedLora && (
        <div className="popup-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, () => setSelectedLora(null))}>
          <div className="popup-content" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={() => setSelectedLora(null)}>×</button>

            {selectedLora.versions && selectedLora.versions.length > 0 && (
              <div className="lora-version-header">
                <div className="lora-version-left">
                  <span className="lora-version-label">Version:</span>
                  {selectedLora.hasMultipleVersions ? (
                    <div
                      className="custom-version-select"
                      onClick={() => setIsVersionDropdownOpen(!isVersionDropdownOpen)}
                    >
                      <div className="custom-version-select-trigger">
                        <span>{selectedLoraVersion ? selectedLoraVersion.displayName : 'Select version'}</span>
                        <svg className={`custom-version-arrow ${isVersionDropdownOpen ? 'open' : ''}`} width="12" height="8" viewBox="0 0 12 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                      {isVersionDropdownOpen && (
                        <div className="custom-version-options">
                          {selectedLora.versions.map((version) => (
                            <div
                              key={version.name}
                              className={`custom-version-option ${selectedLoraVersion && selectedLoraVersion.name === version.name ? 'selected' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedLoraVersion(version)
                                setIsVersionDropdownOpen(false)
                              }}
                            >
                              {version.displayName}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="lora-version-text">
                      {selectedLoraVersion ? selectedLoraVersion.displayName : selectedLora.versions[0].displayName}
                    </span>
                  )}
                </div>
                <div className="lora-company-group-container">
                  {selectedLora.company && (
                    <div className="lora-company-line">
                      <span className="company-from-label">From:</span>
                      <span className="lora-company-name">{selectedLora.company}</span>
                    </div>
                  )}
                  {selectedLora.group && selectedLora.group !== 'N/A' && (
                    <div className="lora-group-line">
                      {selectedLora.group}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className={`popup-images ${
              selectedLoraVersion && selectedLoraVersion.images && selectedLoraVersion.images.length > 1
                ? 'portrait'
                : 'landscape'
            }`}>
              {selectedLoraVersion && selectedLoraVersion.images && selectedLoraVersion.images.length > 0 ? (
                selectedLoraVersion.images.map((image, index) => (
                  <img key={index} src={image} alt={`${selectedLora.name} ${index + 1}`} />
                ))
              ) : (
                <img src={selectedLora.preview} alt={selectedLora.name} />
              )}
            </div>

            <div className="lora-meta-info">
              {selectedLora.character && (
                <div className="lora-meta-item">
                  <span className="lora-meta-label">Character:</span>
                  <span className="lora-meta-value">{selectedLora.character}</span>
                </div>
              )}
              {selectedLora.cloth && (
                <div className="lora-meta-item">
                  <span className="lora-meta-label">Cloth:</span>
                  <span className="lora-meta-value">{selectedLora.cloth}</span>
                </div>
              )}
              {selectedLora.gender && (
                <div className="lora-meta-item">
                  <span className="lora-meta-label">Gender:</span>
                  <span className="lora-meta-value">{selectedLora.gender}</span>
                </div>
              )}
              {(selectedLora.characterCount && selectedLora.characterCount > 0) && (
                <div className="lora-meta-item">
                  <span className="lora-meta-label">Char Count:</span>
                  <span className="lora-meta-value">{selectedLora.characterCount}</span>
                </div>
              )}
              {selectedLora.model && (
                <div className="lora-meta-item">
                  <span className="lora-meta-label">Model:</span>
                  <span className="lora-meta-value">{selectedLora.model}</span>
                </div>
              )}
            </div>

            {/* Multi-character warning */}
            {selectedLora.characterCount && selectedLora.characterCount > 1 && (
              <div className="multi-char-warning">
                ⚠️ Multi-character LoRA may sacrifice some features and require multiple regenerations for better results.
              </div>
            )}

            <div className="lora-actions">
              {/* External link button - temporarily disabled */}
              <button
                className="lora-action-button"
                disabled
                title="External link (temporarily unavailable)"
                style={{ opacity: 0.3, cursor: 'not-allowed' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
              </button>
              {selectedLoraVersion && selectedLoraVersion.filePath && (
                <button
                  className="lora-action-button"
                  onClick={() => handleDownload(selectedLora.id, selectedLoraVersion)}
                  title={`Download ${selectedLoraVersion.name} version`}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                </button>
              )}
              {selectedLora.prompt && (
                <button
                  className="lora-action-button"
                  onClick={() => handleCopyPrompt(selectedLora.prompt, selectedLora.id, 'lora')}
                  title="Copy prompt"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Fn LoRA Detail Modal */}
      {selectedFnLora && (
        <div className="popup-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, () => setSelectedFnLora(null))}>
          <div className="popup-content" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={() => setSelectedFnLora(null)}>×</button>

            {selectedFnLora.versions && selectedFnLora.versions.length > 0 && (
              <div className="lora-version-header">
                <div className="lora-version-left">
                  <span className="lora-version-label">Version:</span>
                  <span className="lora-version-text">
                    {selectedFnLora.versions[selectedFnLoraVersion]?.displayName || selectedFnLora.versions[0]?.displayName}
                  </span>
                </div>
                <div className="lora-company-group-container">
                  {selectedFnLora.type && (
                    <div className="lora-company-line">
                      <span className="company-from-label">Type:</span>
                      <span className="lora-company-name">{selectedFnLora.type}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className={`popup-images ${
              selectedFnLora.versions && selectedFnLora.versions[selectedFnLoraVersion]?.images?.length > 1
                ? 'portrait'
                : 'landscape'
            }`}>
              {selectedFnLora.versions && selectedFnLora.versions[selectedFnLoraVersion]?.images?.length > 0 ? (
                selectedFnLora.versions[selectedFnLoraVersion].images.map((image, index) => (
                  <img key={index} src={image} alt={`${selectedFnLora.name} ${index + 1}`} />
                ))
              ) : (
                <img src={selectedFnLora.thumbnail} alt={selectedFnLora.name} />
              )}
            </div>

            <div className="lora-meta-wrapper">
              {selectedFnLora.weight !== null && selectedFnLora.weight !== undefined && (
                <div className="recommended-weight-badge">
                  <span className="recommended-weight-label">Rec. Weight</span>
                  <span className="recommended-weight-value">{selectedFnLora.weight}</span>
                </div>
              )}
              <div className="lora-meta-info">
                {selectedFnLora.title && (
                  <div className="lora-meta-item">
                    <span className="lora-meta-label">Title:</span>
                    <span className="lora-meta-value">{selectedFnLora.title}</span>
                  </div>
                )}
                {selectedFnLora.subTitle && (
                  <div className="lora-meta-item">
                    <span className="lora-meta-label">Sub-Title:</span>
                    <span className="lora-meta-value">{selectedFnLora.subTitle}</span>
                  </div>
                )}
                {selectedFnLora.type && (
                  <div className="lora-meta-item">
                    <span className="lora-meta-label">Type:</span>
                    <span className="lora-meta-value">{selectedFnLora.type}</span>
                  </div>
                )}
                {selectedFnLora.model && (
                  <div className="lora-meta-item">
                    <span className="lora-meta-label">Model:</span>
                    <span className="lora-meta-value">{selectedFnLora.model}</span>
                  </div>
                )}
                {selectedFnLora.stability && (
                  <div className="lora-meta-item">
                    <span className="lora-meta-label">Stability:</span>
                    <span className={`stability-badge stability-${selectedFnLora.stability}`}>
                      S{selectedFnLora.stability}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="lora-actions">
              {selectedFnLora.versions && selectedFnLora.versions[selectedFnLoraVersion]?.filePath && (
                <button
                  className="lora-action-button"
                  onClick={async () => {
                    const version = selectedFnLora.versions[selectedFnLoraVersion]
                    const link = document.createElement('a')
                    link.href = version.filePath
                    link.download = version.fileName
                    document.body.appendChild(link)
                    link.click()
                    document.body.removeChild(link)
                    // Update download count
                    await fetch(`/api/fn-loras/${selectedFnLora.id}/download`, { method: 'POST' })
                  }}
                  title="Download"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                </button>
              )}
              {selectedFnLora.prompt && (
                <button
                  className="lora-action-button"
                  onClick={async () => {
                    navigator.clipboard.writeText(selectedFnLora.prompt)
                    // Update copy count
                    await fetch(`/api/fn-loras/${selectedFnLora.id}/copy`, { method: 'POST' })
                  }}
                  title="Copy prompt"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Loading Overlay */}
      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-content">
            <div className="loading-spinner"></div>
            <p>{loadingMessage || 'Processing...'}</p>
          </div>
        </div>
      )}

      {showHelpModal && (
        <div className="popup-overlay help-modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={(e) => handleOverlayClick(e, () => setShowHelpModal(false))}>
          <div className="help-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={() => setShowHelpModal(false)}>×</button>

            {activeTab === 'fnlora' ? (
              <>
                <h2>Functional LoRA Guide</h2>

                <div className="help-section">
                  <h3>How to Use</h3>
                  <ul>
                    <li>Click on any Fn LoRA card to view details and download</li>
                    <li>Use filters to narrow down by Type or Model</li>
                    <li>Download the .safetensors file and add to your LoRA folder</li>
                    <li>Copy the trigger prompt to use with the LoRA</li>
                  </ul>
                </div>

                <div className="help-section">
                  <h3>Stability Levels</h3>
                  <p>Stability indicates how consistently a Functional LoRA produces expected results:</p>
                  <div className="stability-examples">
                    <div className="stability-example">
                      <span className="stability-badge stability-1">S1</span>
                      <div>
                        <strong>High Stability</strong>
                        <p>Effect applies consistently. Works well across different prompts.</p>
                      </div>
                    </div>
                    <div className="stability-example">
                      <span className="stability-badge stability-2">S2</span>
                      <div>
                        <strong>Medium Stability</strong>
                        <p>Effect may vary. Some prompts work better than others.</p>
                      </div>
                    </div>
                    <div className="stability-example">
                      <span className="stability-badge stability-3">S3</span>
                      <div>
                        <strong>Low Stability</strong>
                        <p>Effect is inconsistent. May require specific prompts or settings.</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="help-section">
                  <h3>Meta Information</h3>
                  <p>Each Functional LoRA includes:</p>
                  <ul>
                    <li><strong>Title:</strong> Name of the LoRA</li>
                    <li><strong>Sub-Title:</strong> Additional description or variant</li>
                    <li><strong>Type:</strong> Category (Style, Effect, Concept, etc.)</li>
                    <li><strong>Model:</strong> Compatible base model versions</li>
                    <li><strong>Prompt:</strong> Trigger words to activate the LoRA effect</li>
                  </ul>
                </div>
              </>
            ) : (
              <>
                <h2>Prompt Gallery Guide</h2>

                <div className="help-section">
                  <h3>How to Use</h3>
                  <ul>
                    <li>Click on any prompt card to view details and copy the prompt</li>
                    <li>Use filters to narrow down prompts by character count, place, type, and view</li>
                    <li>Sort by "Most Copied" to find popular prompts</li>
                    <li>Toggle between SFW/NSFW content using the top-right switch</li>
                  </ul>
                </div>

                <div className="help-section">
                  <h3>Stability Levels</h3>
                  <p>Stability indicates how consistently a prompt produces expected results:</p>
                  <div className="stability-examples">
                    <div className="stability-example">
                      <span className="stability-badge stability-1">S1</span>
                      <div>
                        <strong>High Stability</strong>
                        <p>Produces consistent results. Minimal "gacha" needed.</p>
                      </div>
                    </div>
                    <div className="stability-example">
                      <span className="stability-badge stability-2">S2</span>
                      <div>
                        <strong>Medium Stability</strong>
                        <p>Moderately consistent. Some variation expected.</p>
                      </div>
                    </div>
                    <div className="stability-example">
                      <span className="stability-badge stability-3">S3</span>
                      <div>
                        <strong>Low Stability</strong>
                        <p>Results vary significantly. More "gacha" required.</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="help-section">
                  <h3>Meta Information</h3>
                  <p>Each prompt includes:</p>
                  <ul>
                    <li><strong>Author:</strong> Creator of the prompt</li>
                    <li><strong>Character:</strong> Number of characters in the scene</li>
                    <li><strong>Place:</strong> Scene location (Indoor, Outdoor, etc.)</li>
                    <li><strong>Type:</strong> Scene type or action (Standing, Sitting, Running, etc.)</li>
                    <li><strong>View:</strong> Camera angle (Front, Back, Side, etc.)</li>
                  </ul>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Background Upload Warning Banner */}
      {Object.keys(backgroundUploads).length > 0 && Object.values(backgroundUploads).some(u => u.status === 'uploading') && (
        <div className="upload-warning-banner">
          <span className="upload-warning-icon">⚠️</span>
          <span className="upload-warning-text">
            Upload in progress. Do not refresh the page! ({Object.values(backgroundUploads).filter(u => u.status === 'uploading').map(u => u.fileName).join(', ')})
          </span>
          <span className="upload-warning-spinner"></span>
        </div>
      )}

      {/* Floating Logout Button */}
      {isLoggedIn && (
        <button 
          className="floating-logout-btn" 
          onClick={handleAdminLogout}
          title="Logout"
        >
          🚪 Logout
        </button>
      )}

      {/* Scroll to Top Button */}
      {showScrollTop && (
        <button className="scroll-to-top" onClick={scrollToTop} title="Back to top">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 19V5M5 12l7-7 7 7"/>
          </svg>
        </button>
      )}
      </div>
    </ToastProvider>
  )
}

export default App
