import React, { useState, useEffect } from 'react'
import AlbumGrid from './AlbumGrid'
import StaticViewer from './Viewers/StaticViewer'
import VideoViewer from './Viewers/VideoViewer'
import StoryViewer from './Viewers/StoryViewer'
import AdminPanel from './Admin/AdminPanel'
import { useDataCache } from '../../hooks/useDataCache'
import './Gallery.css'

// Feature flag to enable/disable Story Gallery
const ENABLE_STORY_GALLERY = false

function Gallery({ sensitivityFilter, isLoggedIn, adminMode, onAdminLogout, onAdminModeToggle }) {
  const [activeCategory, setActiveCategory] = useState(() => {
    // Load from localStorage, default to 'static' for new users
    return localStorage.getItem('galleryCategory') || 'static'
  })
  const [selectedAlbum, setSelectedAlbum] = useState(null)
  const [selectedType, setSelectedType] = useState(null)

  // Use data cache hooks for each category (lazy loading - only load when needed)
  const staticCache = useDataCache(
    'gallery.static',
    async () => {
      const response = await fetch('/api/gallery/static')
      return await response.json()
    },
    {
      autoLoad: false, // Don't auto-load, load on demand
      revalidateOnMount: true // Check for updates in background on mount
    }
  )

  const videoCache = useDataCache(
    'gallery.video',
    async () => {
      const response = await fetch('/api/gallery/video')
      return await response.json()
    },
    {
      autoLoad: false,
      revalidateOnMount: true
    }
  )

  const storyCache = useDataCache(
    'gallery.story',
    async () => {
      const response = await fetch('/api/gallery/story')
      return await response.json()
    },
    {
      autoLoad: false,
      revalidateOnMount: true
    }
  )

  // Save gallery category to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('galleryCategory', activeCategory)
  }, [activeCategory])

  // Load albums when category changes (only if not already loaded)
  useEffect(() => {
    if (activeCategory === 'static') {
      if (!staticCache.data) {
        staticCache.loadData()
      } else {
        // Already have cached data, revalidate in background
        staticCache.revalidate()
      }
    } else if (activeCategory === 'video') {
      if (!videoCache.data) {
        videoCache.loadData()
      } else {
        videoCache.revalidate()
      }
    } else if (activeCategory === 'story') {
      if (!storyCache.data) {
        storyCache.loadData() // Load data even if disabled (for admin purposes)
      } else {
        storyCache.revalidate()
      }
    }
  }, [activeCategory]) // Only depend on activeCategory to avoid infinite loop

  // Filter albums by sensitivity
  const filterBySensitivity = (albums) => {
    if (sensitivityFilter === 'all') return albums
    if (sensitivityFilter === 'sfw') {
      return albums.filter(album => album.sensitive === 'SFW')
    }
    if (sensitivityFilter === 'nsfw') {
      return albums.filter(album => album.sensitive === 'NSFW')
    }
    return albums
  }

  const getCurrentAlbums = () => {
    let albums = []
    if (activeCategory === 'static') albums = staticCache.data || []
    else if (activeCategory === 'video') albums = videoCache.data || []
    else if (activeCategory === 'story') albums = storyCache.data || []

    return filterBySensitivity(albums)
  }

  const getCurrentCache = () => {
    if (activeCategory === 'static') return staticCache
    if (activeCategory === 'video') return videoCache
    if (activeCategory === 'story') return storyCache
    return { loading: false }
  }

  const handleAlbumClick = async (album) => {
    setSelectedAlbum(album)
    setSelectedType(activeCategory)

    // Increment view count and silently refresh data in background
    try {
      await fetch(`/api/gallery/${activeCategory}/${album.id}/view`, {
        method: 'POST'
      })
      // Silently refresh cache in background (won't show loading state)
      const currentCache = getCurrentCache()
      if (currentCache && currentCache.loadData) {
        currentCache.loadData(true, true) // force=true, silent=true
      }
    } catch (err) {
      console.error('Failed to update view count:', err)
    }
  }

  const handleCloseViewer = () => {
    setSelectedAlbum(null)
    setSelectedType(null)
  }

  const handleAdminClick = () => {
    if (isLoggedIn) {
      onAdminModeToggle()

      // Refresh cache when exiting admin mode
      if (adminMode) {
        console.log('👀 Exiting admin mode, refreshing cache...')
        handleRefresh()
      }
    }
  }

  const handleLogout = () => {
    onAdminLogout()
  }

  const handleRefresh = () => {
    // Force reload data after admin changes
    const currentCache = getCurrentCache()
    if (currentCache && currentCache.loadData) {
      console.log('🔄 Force refreshing gallery cache...')
      currentCache.loadData(true) // Force reload
    }
  }

  const currentAlbums = getCurrentAlbums()
  const currentCache = getCurrentCache()

  return (
    <div className="gallery-container">
      <div className="gallery-header">
        <div>
          <h2>Collection Gallery</h2>
          <p>Browse image collections, video albums, and visual stories</p>
        </div>
        <button
          className={`admin-toggle-btn ${adminMode ? 'active' : ''}`}
          onClick={handleAdminClick}
          title={isLoggedIn ? (adminMode ? 'Exit Admin Mode' : 'Enter Admin Mode') : 'Admin Login'}
        >
          {adminMode ? '🔓 Admin Mode' : (isLoggedIn ? '🔒 Admin' : '🔐 Login')}
        </button>
      </div>

      {/* Category Navigation */}
      <div className="gallery-category-nav">
        <button
          className={`category-button ${activeCategory === 'static' ? 'active' : ''}`}
          onClick={() => setActiveCategory('static')}
        >
          <span className="category-icon">🖼️</span>
          <span>Static Gallery</span>
          <span className="category-count">{filterBySensitivity(staticCache.data || []).length}</span>
        </button>
        <button
          className={`category-button ${activeCategory === 'video' ? 'active' : ''}`}
          onClick={() => setActiveCategory('video')}
        >
          <span className="category-icon">🎬</span>
          <span>Video Gallery</span>
          <span className="category-count">{filterBySensitivity(videoCache.data || []).length}</span>
        </button>
        <button
          className={`category-button ${activeCategory === 'story' ? 'active' : ''}`}
          onClick={() => ENABLE_STORY_GALLERY && setActiveCategory('story')}
          disabled={!ENABLE_STORY_GALLERY}
          style={!ENABLE_STORY_GALLERY ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
          title={!ENABLE_STORY_GALLERY ? 'Coming soon...' : ''}
        >
          <span className="category-icon">📖</span>
          <span>Story Gallery</span>
          <span className="category-count">{filterBySensitivity(storyCache.data || []).length}</span>
        </button>
      </div>

      {/* Content Area */}
      <div className="gallery-content-section">
        {adminMode ? (
          <AdminPanel
            type={activeCategory}
            albums={currentAlbums}
            onLogout={handleLogout}
            onRefresh={handleRefresh}
          />
        ) : (
          <>
            {/* Album Grid */}
            {currentCache.loading ? (
              <div className="gallery-loading">Loading...</div>
            ) : (
              <AlbumGrid
                albums={currentAlbums}
                onAlbumClick={handleAlbumClick}
                type={activeCategory}
              />
            )}

            {/* Viewers */}
            {selectedAlbum && selectedType === 'static' && (
              <StaticViewer album={selectedAlbum} onClose={handleCloseViewer} />
            )}
            {selectedAlbum && selectedType === 'video' && (
              <VideoViewer album={selectedAlbum} onClose={handleCloseViewer} />
            )}
            {selectedAlbum && selectedType === 'story' && ENABLE_STORY_GALLERY && (
              <StoryViewer album={selectedAlbum} onClose={handleCloseViewer} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default Gallery
