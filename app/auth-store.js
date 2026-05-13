// app/auth-store.js
// Discord-only auth store: whitelist, admins, self-service requests,
// user profile cache, append-only audit log.
//
// Schema overview (all files under AUTH_DIR; writes are atomic):
//   whitelist.json          { discord: ["<id>", ...] }
//   admins.json             { discord: ["<id>", ...] }
//     The super-admin (SUPER_ADMIN_DISCORD_ID env) is NOT stored here;
//     it's always-admin regardless of file contents.
//   whitelist_requests.json { requests: [Request, ...] }
//     Where Request =
//       { id, discordId, profile, reason, createdAt,
//         status: 'pending'|'approved'|'denied'|'cancelled',
//         reviewedBy?, reviewedAt?, reviewNote? }
//   user_profiles.json      { discord: { "<id>": { username, globalName,
//                                                   avatar, firstSeen,
//                                                   lastSeen } } }
//   access.log.jsonl        append-only audit (one JSON per line)
//
// All reads go through a small in-memory cache (60s TTL) invalidated on
// writes from this process. The cache exists to keep middleware fast;
// cross-process consistency isn't a concern since only one server.js
// instance runs at a time.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const TTL_MS = 60 * 1000

export function createAuthStore({ authDir, writeJsonAtomic, sendDiscordNotification }) {
  if (!authDir) throw new Error('createAuthStore: authDir is required')
  if (typeof writeJsonAtomic !== 'function') {
    throw new Error('createAuthStore: writeJsonAtomic is required')
  }

  // Resolve paths once.
  const WHITELIST_PATH         = path.join(authDir, 'whitelist.json')
  const ADMINS_PATH            = path.join(authDir, 'admins.json')
  const REQUESTS_PATH          = path.join(authDir, 'whitelist_requests.json')
  const PROFILES_PATH          = path.join(authDir, 'user_profiles.json')
  const ACCESS_LOG_PATH        = path.join(authDir, 'access.log.jsonl')

  // Ensure directory exists at boot.
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true })
  }

  const cache = { v: {}, t: {} }
  function readJsonCached(key, file, fallback) {
    const now = Date.now()
    if (cache.t[key] && now - cache.t[key] < TTL_MS && cache.v[key] !== undefined) {
      return cache.v[key]
    }
    let value = fallback
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8')
        value = JSON.parse(raw)
      }
    } catch (err) {
      console.error(`[auth-store] failed to read ${file}: ${err.message} — falling back to default`)
      value = fallback
    }
    cache.v[key] = value
    cache.t[key] = now
    return value
  }
  function invalidate(key) {
    delete cache.v[key]
    delete cache.t[key]
  }

  // ---------- Whitelist ----------
  function loadWhitelist() {
    return readJsonCached('whitelist', WHITELIST_PATH, { discord: [] })
  }
  function saveWhitelist(list) {
    writeJsonAtomic(WHITELIST_PATH, list)
    invalidate('whitelist')
  }
  function isWhitelistedRaw(discordId) {
    if (!discordId) return false
    return loadWhitelist().discord.includes(String(discordId).trim())
  }
  function addWhitelist(discordId) {
    const id = String(discordId).trim()
    if (!id) throw new Error('discordId required')
    const list = loadWhitelist()
    if (!list.discord.includes(id)) {
      list.discord.push(id)
      saveWhitelist(list)
      return true
    }
    return false
  }
  function removeWhitelist(discordId) {
    const id = String(discordId).trim()
    const list = loadWhitelist()
    const before = list.discord.length
    list.discord = list.discord.filter((e) => e !== id)
    if (list.discord.length !== before) {
      saveWhitelist(list)
      return true
    }
    return false
  }

  // ---------- Admins ----------
  // Super-admin from env is always admin and is NOT stored in admins.json.
  function getSuperAdminId() {
    return (process.env.SUPER_ADMIN_DISCORD_ID || '').trim()
  }
  function loadAdmins() {
    return readJsonCached('admins', ADMINS_PATH, { discord: [] })
  }
  function saveAdmins(list) {
    writeJsonAtomic(ADMINS_PATH, list)
    invalidate('admins')
  }
  function isAdmin(discordId) {
    if (!discordId) return false
    const id = String(discordId).trim()
    if (id === getSuperAdminId()) return true
    return loadAdmins().discord.includes(id)
  }
  function isSuperAdmin(discordId) {
    return !!discordId && String(discordId).trim() === getSuperAdminId()
  }
  function promoteAdmin(discordId) {
    const id = String(discordId).trim()
    if (!id) throw new Error('discordId required')
    if (id === getSuperAdminId()) return false // already always-admin
    if (!isWhitelistedRaw(id)) {
      // Promotion implies whitelist — auto-add.
      addWhitelist(id)
    }
    const list = loadAdmins()
    if (!list.discord.includes(id)) {
      list.discord.push(id)
      saveAdmins(list)
      return true
    }
    return false
  }
  function demoteAdmin(discordId) {
    const id = String(discordId).trim()
    if (id === getSuperAdminId()) {
      throw new Error('Cannot demote the super-admin')
    }
    const list = loadAdmins()
    const before = list.discord.length
    list.discord = list.discord.filter((e) => e !== id)
    if (list.discord.length !== before) {
      saveAdmins(list)
      return true
    }
    return false
  }

  // ---------- Profiles ----------
  function loadProfiles() {
    return readJsonCached('profiles', PROFILES_PATH, { discord: {} })
  }
  function saveProfiles(profiles) {
    writeJsonAtomic(PROFILES_PATH, profiles)
    invalidate('profiles')
  }
  function upsertProfile({ discordId, username, globalName, avatar }) {
    if (!discordId) return null
    const id = String(discordId).trim()
    const profiles = loadProfiles()
    const now = new Date().toISOString()
    const existing = profiles.discord[id] || {}
    profiles.discord[id] = {
      username: username || existing.username || '',
      globalName: globalName || existing.globalName || '',
      avatar: avatar !== undefined ? avatar : (existing.avatar || null),
      firstSeen: existing.firstSeen || now,
      lastSeen: now,
    }
    saveProfiles(profiles)
    return profiles.discord[id]
  }
  function getProfile(discordId) {
    if (!discordId) return null
    return loadProfiles().discord[String(discordId).trim()] || null
  }

  // ---------- Whitelist requests ----------
  function loadRequests() {
    return readJsonCached('requests', REQUESTS_PATH, { requests: [] })
  }
  function saveRequests(data) {
    writeJsonAtomic(REQUESTS_PATH, data)
    invalidate('requests')
  }
  function listRequests({ status } = {}) {
    const all = loadRequests().requests || []
    if (status) return all.filter((r) => r.status === status)
    return all
  }
  function findPendingByUser(discordId) {
    const id = String(discordId).trim()
    return (loadRequests().requests || []).find(
      (r) => r.discordId === id && r.status === 'pending'
    ) || null
  }
  function findRequestById(id) {
    return (loadRequests().requests || []).find((r) => r.id === id) || null
  }
  function createRequest({ discordId, reason }) {
    const id = String(discordId).trim()
    if (!id) throw new Error('discordId required')
    if (isWhitelistedRaw(id)) {
      const e = new Error('Already whitelisted')
      e.code = 'ALREADY_WHITELISTED'
      throw e
    }
    if (findPendingByUser(id)) {
      const e = new Error('A pending request already exists')
      e.code = 'PENDING_EXISTS'
      throw e
    }
    const data = loadRequests()
    const newReq = {
      id: crypto.randomBytes(8).toString('hex'),
      discordId: id,
      profile: getProfile(id) || null,
      reason: String(reason || '').slice(0, 1000),
      createdAt: new Date().toISOString(),
      status: 'pending',
    }
    data.requests = data.requests || []
    data.requests.push(newReq)
    saveRequests(data)
    return newReq
  }
  function reviewRequest({ requestId, status, reviewerId, reviewNote }) {
    if (!['approved', 'denied'].includes(status)) {
      throw new Error('status must be approved or denied')
    }
    const data = loadRequests()
    const req = (data.requests || []).find((r) => r.id === requestId)
    if (!req) {
      const e = new Error('Request not found')
      e.code = 'NOT_FOUND'
      throw e
    }
    if (req.status !== 'pending') {
      const e = new Error(`Request already ${req.status}`)
      e.code = 'NOT_PENDING'
      throw e
    }
    req.status = status
    req.reviewedBy = String(reviewerId || '').trim()
    req.reviewedAt = new Date().toISOString()
    if (reviewNote) req.reviewNote = String(reviewNote).slice(0, 500)
    if (status === 'approved') {
      addWhitelist(req.discordId)
    }
    saveRequests(data)
    return req
  }
  function cancelRequest({ requestId, discordId }) {
    const id = String(discordId).trim()
    const data = loadRequests()
    const req = (data.requests || []).find((r) => r.id === requestId)
    if (!req) {
      const e = new Error('Request not found'); e.code = 'NOT_FOUND'; throw e
    }
    if (req.discordId !== id) {
      const e = new Error('Forbidden'); e.code = 'FORBIDDEN'; throw e
    }
    if (req.status !== 'pending') {
      const e = new Error('Only pending requests can be cancelled'); e.code = 'NOT_PENDING'; throw e
    }
    req.status = 'cancelled'
    req.reviewedAt = new Date().toISOString()
    saveRequests(data)
    return req
  }

  // ---------- Audit log ----------
  // Fire-and-forget append. Never throws.
  function audit(event, data) {
    try {
      const line = JSON.stringify({
        t: new Date().toISOString(),
        event,
        ...data,
      })
      fs.appendFileSync(ACCESS_LOG_PATH, line + '\n', 'utf-8')
    } catch (err) {
      console.error(`[auth-store] audit write failed: ${err.message}`)
    }
  }

  // ---------- Aggregated helper ----------
  // Resolve auth flags for a Discord ID. Used by middleware and /api/auth/me.
  function getAuthFlags(discordId) {
    return {
      discordId: discordId ? String(discordId).trim() : null,
      isWhitelisted: isAdmin(discordId) || isWhitelistedRaw(discordId),
      isAdmin: isAdmin(discordId),
      isSuperAdmin: isSuperAdmin(discordId),
    }
  }

  // ---------- Notification helper (optional) ----------
  function notify(event, payload) {
    if (typeof sendDiscordNotification === 'function') {
      try { sendDiscordNotification(event, payload) }
      catch (err) { console.error(`[auth-store] notify failed: ${err.message}`) }
    }
  }

  return {
    // Whitelist
    loadWhitelist, addWhitelist, removeWhitelist, isWhitelistedRaw,
    // Admins
    loadAdmins, isAdmin, isSuperAdmin, getSuperAdminId,
    promoteAdmin, demoteAdmin,
    // Profiles
    loadProfiles, upsertProfile, getProfile,
    // Requests
    listRequests, findPendingByUser, findRequestById,
    createRequest, reviewRequest, cancelRequest,
    // Audit + flags
    audit, getAuthFlags, notify,
    // Paths (for debugging)
    paths: {
      WHITELIST_PATH, ADMINS_PATH, REQUESTS_PATH,
      PROFILES_PATH, ACCESS_LOG_PATH, AUTH_DIR: authDir,
    },
  }
}
