import { useState, useEffect, useRef, useCallback } from 'react'

// Bump this whenever the on-disk cache shape changes or a deploy needs to
// invalidate every persisted cache (e.g. because a prior bug poisoned
// localStorage with empty arrays / error objects). On first import after a
// version bump, every `cache_*` / `cache_meta_*` entry is wiped.
const CACHE_SCHEMA_VERSION = 3
const SCHEMA_KEY = 'cache_schema_version'
if (typeof window !== 'undefined') {
  try {
    const stored = parseInt(localStorage.getItem(SCHEMA_KEY) || '0', 10)
    if (stored !== CACHE_SCHEMA_VERSION) {
      const toRemove = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && (k.startsWith('cache_') && k !== SCHEMA_KEY)) toRemove.push(k)
      }
      toRemove.forEach((k) => localStorage.removeItem(k))
      localStorage.setItem(SCHEMA_KEY, String(CACHE_SCHEMA_VERSION))
      console.log(`[useDataCache] Cache schema bumped to v${CACHE_SCHEMA_VERSION}, wiped ${toRemove.length} entries`)
    }
  } catch {
    // localStorage unavailable — fine, hook will work without persistence
  }
}

/**
 * Universal data caching hook with automatic staleness detection
 *
 * @param {string} cacheKey - Unique key for this cache (e.g., 'prompts', 'loras', 'gallery.static')
 * @param {Function} fetchFn - Async function to fetch data
 * @param {Object} options - Configuration options
 * @param {boolean} options.autoLoad - Whether to load data automatically on mount (default: true)
 * @param {number} options.staleTime - Time in ms before checking for updates (default: 30000 = 30s)
 * @param {boolean} options.persist - Whether to persist cache to localStorage (default: true)
 * @param {boolean} options.revalidateOnMount - Whether to check for updates on mount while showing cached data (default: false)
 * @returns {Object} - { data, loading, error, refresh, isStale, revalidate }
 */
export function useDataCache(cacheKey, fetchFn, options = {}) {
  const {
    autoLoad = true,
    staleTime = 30000, // 30 seconds default
    persist = true,     // Enable persistence by default
    revalidateOnMount = false // Enable stale-while-revalidate on mount
  } = options

  const STORAGE_KEY = `cache_${cacheKey}`
  const METADATA_KEY = `cache_meta_${cacheKey}`

  // Initialize data from localStorage if available
  const [data, setData] = useState(() => {
    if (persist && typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored) {
          const parsed = JSON.parse(stored)
          // Sanity check: discard cached error responses or empty fallbacks
          // that may have leaked in before fetchers learned to throw on
          // !response.ok. A real payload is either a non-empty array or an
          // object with real data — never a bare {error: "..."} shape and
          // never an empty array (which means the fetch failed silently and
          // wrote an empty fallback into the cache).
          if (Array.isArray(parsed) && parsed.length === 0) {
            localStorage.removeItem(STORAGE_KEY)
            localStorage.removeItem(METADATA_KEY)
            return null
          }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const keys = Object.keys(parsed)
            if (keys.length === 1 && keys[0] === 'error') {
              localStorage.removeItem(STORAGE_KEY)
              localStorage.removeItem(METADATA_KEY)
              return null
            }
            // Special-case the costumes shape: {costumes:[], metadata:{...}}
            // with an empty costumes array is a silent-failure fallback.
            if (Array.isArray(parsed.costumes) && parsed.costumes.length === 0) {
              localStorage.removeItem(STORAGE_KEY)
              localStorage.removeItem(METADATA_KEY)
              return null
            }
          }
          return parsed
        }
      } catch (err) {
        console.error(`Failed to load cache from localStorage for ${cacheKey}:`, err)
      }
    }
    return null
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [isStale, setIsStale] = useState(false)

  // Store cache metadata - initialize from localStorage if available
  const getInitialMetadata = () => {
    if (persist && typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(METADATA_KEY)
        if (stored) {
          const parsed = JSON.parse(stored)
          return {
            lastModified: parsed.lastModified || null,
            lastFetched: parsed.lastFetched || null,
            data: null // data is stored in state, not ref
          }
        }
      } catch (err) {
        console.error(`Failed to load cache metadata from localStorage for ${cacheKey}:`, err)
      }
    }
    return {
      lastModified: null,
      lastFetched: null,
      data: null
    }
  }

  const cacheRef = useRef(getInitialMetadata())

  // Debounce localStorage writes to avoid blocking UI
  useEffect(() => {
    if (!persist || data === null || typeof window === 'undefined') {
      return
    }

    // Debounce the write operation (wait 500ms after last change)
    const timeoutId = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
        localStorage.setItem(METADATA_KEY, JSON.stringify({
          lastModified: cacheRef.current.lastModified,
          lastFetched: cacheRef.current.lastFetched
        }))
      } catch (err) {
        console.error(`Failed to save cache to localStorage for ${cacheKey}:`, err)
      }
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [data, cacheKey, persist, STORAGE_KEY, METADATA_KEY])

  // Check if cache is stale based on time
  const checkStaleTime = useCallback(() => {
    if (!cacheRef.current.lastFetched) return true
    const timeSinceLastFetch = Date.now() - cacheRef.current.lastFetched
    return timeSinceLastFetch > staleTime
  }, [staleTime])

  // Fetch metadata from server to check for updates
  const checkForUpdates = useCallback(async () => {
    try {
      const response = await fetch('/api/metadata')
      if (!response.ok) return false
      const metadata = await response.json()

      // Parse cache key to get the correct metadata path
      // e.g., 'prompts' -> metadata.prompts
      // e.g., 'gallery.static' -> metadata.gallery.static
      const keys = cacheKey.split('.')
      let serverLastModified = metadata

      for (const key of keys) {
        if (serverLastModified && serverLastModified[key]) {
          serverLastModified = serverLastModified[key]
        } else {
          return false
        }
      }

      // Get the lastModified value
      const lastModified = serverLastModified.lastModified || serverLastModified

      // If we have cached data, check if it's outdated
      if (cacheRef.current.lastModified !== null) {
        if (lastModified > cacheRef.current.lastModified) {
          setIsStale(true)
          return true // Data is stale
        }
      }

      return false // Data is fresh
    } catch (err) {
      console.error('Failed to check for updates:', err)
      return false
    }
  }, [cacheKey])

  // Load data
  const loadData = useCallback(async (force = false, silent = false) => {
    // If not forcing and we have fresh cached data, use it
    const hasData = data !== null || cacheRef.current.data !== null
    if (!force && hasData && !checkStaleTime()) {
      // Use existing data from state or cache
      if (data === null && cacheRef.current.data) {
        setData(cacheRef.current.data)
      }
      setIsStale(false)
      return
    }

    // Only show loading state if not silent
    if (!silent) {
      setLoading(true)
    }
    setError(null)

    try {
      const result = await fetchFn()

      // Update cache
      cacheRef.current.data = result
      cacheRef.current.lastFetched = Date.now()

      // Get updated metadata
      const response = await fetch('/api/metadata')
      if (response.ok) {
        const metadata = await response.json()

        const keys = cacheKey.split('.')
        let serverLastModified = metadata

        for (const key of keys) {
          if (serverLastModified && serverLastModified[key]) {
            serverLastModified = serverLastModified[key]
          }
        }

        cacheRef.current.lastModified = serverLastModified.lastModified || serverLastModified
      }

      setData(result)
      setIsStale(false)
    } catch (err) {
      console.error(`Failed to load ${cacheKey}:`, err)
      setError(err)
    } finally {
      // Only clear loading state if not silent
      if (!silent) {
        setLoading(false)
      }
    }
  }, [cacheKey, fetchFn, checkStaleTime, data])

  // Refresh function (smart reload - only if data changed)
  const refresh = useCallback(async () => {
    try {
      // First, check if there are any updates
      const needsUpdate = await checkForUpdates()

      if (needsUpdate) {
        // Data has changed on server, reload it
        await loadData(true)
      } else {
        // No changes, just clear the stale flag
        setIsStale(false)
      }
    } catch (err) {
      console.error('Failed to refresh:', err)
    }
  }, [checkForUpdates, loadData])

  // Revalidate function (stale-while-revalidate strategy)
  // Shows cached data immediately, then silently checks and updates in background
  const revalidate = useCallback(async () => {
    try {
      // First, check if there are any updates
      const needsUpdate = await checkForUpdates()

      if (needsUpdate) {
        // Data has changed on server, silently reload it
        await loadData(true, true) // force=true, silent=true
        console.log(`🔄 [${cacheKey}] Background revalidation: Updated`)
      } else {
        // No changes, just clear the stale flag
        setIsStale(false)
        console.log(`✓ [${cacheKey}] Background revalidation: Up to date`)
      }
    } catch (err) {
      console.error(`Failed to revalidate ${cacheKey}:`, err)
    }
  }, [checkForUpdates, loadData, cacheKey])

  // Auto-load on mount if enabled
  useEffect(() => {
    if (autoLoad) {
      // If we have cached data and revalidateOnMount is enabled,
      // show cached data immediately and revalidate in background
      const hasCachedData = data !== null

      if (hasCachedData && revalidateOnMount) {
        console.log(`📦 [${cacheKey}] Using cached data, revalidating in background...`)
        // Don't call loadData, we already have cached data
        // Just trigger background revalidation
        revalidate()
      } else {
        // Normal load
        loadData()
      }
    }
  }, []) // Only run on mount, don't include dependencies to avoid re-triggering

  // Periodic staleness check
  useEffect(() => {
    if (!data) return

    const interval = setInterval(async () => {
      const needsUpdate = await checkForUpdates()
      if (needsUpdate) {
        // Optionally auto-refresh or just mark as stale
        // For now, we just mark as stale
        setIsStale(true)
      }
    }, staleTime)

    return () => clearInterval(interval)
  }, [data, checkForUpdates, staleTime])

  return {
    data,
    loading,
    error,
    refresh,
    isStale,
    loadData,
    revalidate
  }
}
