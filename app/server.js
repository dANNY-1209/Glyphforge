import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import cors from 'cors'
import sizeOf from 'image-size'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import dotenv from 'dotenv'
import ffmpeg from 'fluent-ffmpeg'
import sharp from 'sharp'
import http from 'http'
import rateLimit from 'express-rate-limit'
import { createAuthStore } from './auth-store.js'

dotenv.config()

// ============================================
// REQUIRED ENVIRONMENT VARIABLES — fail-fast at startup.
// Hard-coded fallbacks (e.g. JWT_SECRET="defaul...-key") are forbidden in
// production: a missing env value would otherwise silently downgrade auth
// to a publicly-known credential.
//
// Discord OAuth is now the only login path. SUPER_ADMIN_DISCORD_ID is the
// bootstrap admin who can never be demoted — it's the recovery handle if
// admins.json gets wiped.
// ============================================
const REQUIRED_ENV = [
  'JWT_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'SUPER_ADMIN_DISCORD_ID',
]
const __envMissing = REQUIRED_ENV.filter((k) => !process.env[k] || !String(process.env[k]).trim())
if (__envMissing.length) {
  console.error(`[startup] FATAL: missing required environment variables: ${__envMissing.join(', ')}`)
  console.error('[startup] See .env.example for the expected configuration.')
  process.exit(1)
}


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load configuration
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'))
const PROMPT_FOLDER_PATH = path.isAbsolute(config.promptFolder.path)
  ? config.promptFolder.path
  : path.join(__dirname, config.promptFolder.path)
const PROMPT_FOLDER_NAME = config.promptFolder.name

const COSTUME_FOLDER_PATH = config.costumeFolder
  ? (path.isAbsolute(config.costumeFolder.path)
    ? config.costumeFolder.path
    : path.join(__dirname, config.costumeFolder.path))
  : null
const COSTUME_FOLDER_NAME = config.costumeFolder?.name || 'costume'

const LORA_FOLDER_PATH = path.isAbsolute(config.loraFolder.path)
  ? config.loraFolder.path
  : path.join(__dirname, config.loraFolder.path)
const LORA_FOLDER_NAME = config.loraFolder.name

const GALLERY_FOLDER_PATH = path.isAbsolute(config.galleryFolder.path)
  ? config.galleryFolder.path
  : path.join(__dirname, config.galleryFolder.path)
const GALLERY_FOLDER_NAME = config.galleryFolder.name

const REQUEST_FOLDER_PATH = path.isAbsolute(config.requestFolder.path)
  ? config.requestFolder.path
  : path.join(__dirname, config.requestFolder.path)
const REQUEST_FOLDER_NAME = config.requestFolder.name

const WORKFLOW_FOLDER_PATH = config.workflowFolder
  ? (path.isAbsolute(config.workflowFolder.path)
    ? config.workflowFolder.path
    : path.join(__dirname, config.workflowFolder.path))
  : path.join(__dirname, 'workflows')
const WORKFLOW_FOLDER_NAME = config.workflowFolder?.name || 'workflows'

// Auth data dir — whitelist / admins / requests / profiles / audit log live
// here. Persisted across container rebuilds via the /datas bind mount.
const AUTH_FOLDER_PATH = config.authFolder
  ? (path.isAbsolute(config.authFolder.path)
    ? config.authFolder.path
    : path.join(__dirname, config.authFolder.path))
  : path.join(__dirname, 'auth')

// Static asset dir — persona avatars and other admin-managed images. Mounted
// publicly at `/static`, so URLs are reachable by external services (e.g.
// Discord CDN fetching webhook avatar_url).
const STATIC_FOLDER_PATH = config.staticFolder
  ? (path.isAbsolute(config.staticFolder.path)
    ? config.staticFolder.path
    : path.join(__dirname, config.staticFolder.path))
  : path.join(__dirname, 'static')

// Config dir — admin-editable runtime config (Discord personas, etc.).
const CONFIG_FOLDER_PATH = config.configFolder
  ? (path.isAbsolute(config.configFolder.path)
    ? config.configFolder.path
    : path.join(__dirname, config.configFolder.path))
  : path.join(__dirname, 'config')

const app = express()
const PORT = 3001

// Enable CORS
app.use(cors())
app.use(express.json())

// 📝 Request logging middleware
app.use((req, res, next) => {
  const start = Date.now()
  const timestamp = new Date().toISOString()
  
  // Log incoming request
  console.log(`[${timestamp}] ⬇️  ${req.method} ${req.path}`)
  if (req.headers['content-length']) {
    console.log(`   📦 Content-Length: ${req.headers['content-length']} bytes`)
  }
  if (req.headers['content-type']) {
    console.log(`   📄 Content-Type: ${req.headers['content-type']}`)
  }
  
  // Track response
  res.on('finish', () => {
    const duration = Date.now() - start
    const emoji = res.statusCode < 400 ? '✅' : '❌'
    console.log(`[${new Date().toISOString()}] ${emoji} ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`)
  })
  
  next()
})

// ============================================
// SAFE-PATH / VALIDATION HELPERS
// ============================================

// A "slug" is a filesystem-safe id segment derived from user input.
// Allowed: letters, digits, dot, dash, underscore. Length 1..200.
// Rejects:  empty, ".", "..", anything containing / \ NUL or control chars.
const SLUG_RE = /^[A-Za-z0-9._-]{1,200}$/
function isSafeSlug(s) {
  if (typeof s !== 'string' || !s.length) return false
  if (s === '.' || s === '..') return false
  return SLUG_RE.test(s)
}
function requireSlug(name, value, res) {
  if (!isSafeSlug(value)) {
    res.status(400).json({ error: `Invalid ${name}` })
    return false
  }
  return true
}

// Looser validator for user-facing filenames (uploaded files keep their
// original name, which may contain spaces, parentheses, unicode chars, etc).
// We still defend against path traversal here; safeResolveUnder is the final
// guard at the path-join site.
function isSafeFilename(s) {
  if (typeof s !== 'string' || !s.length || s.length > 255) return false
  if (s === '.' || s === '..') return false
  if (s.includes('/') || s.includes('\\') || s.includes('\0')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(s)) return false
  return true
}
function requireFilename(name, value, res) {
  if (!isSafeFilename(value)) {
    res.status(400).json({ error: `Invalid ${name}` })
    return false
  }
  return true
}

// Resolve `child` under `base` and ensure the resolved path actually stays
// inside `base`. Defends against ../, absolute overrides, symlinks, mixed
// separators, and unicode path tricks. Returns null if the path escapes.
function safeResolveUnder(base, ...segments) {
  const resolved = path.resolve(base, ...segments)
  const baseResolved = path.resolve(base)
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    return null
  }
  return resolved
}

// Whitelist of gallery types (used in /api/gallery/admin/:type/...).
const GALLERY_TYPES = new Set(['static', 'video', 'story'])
function requireGalleryType(value, res) {
  if (!GALLERY_TYPES.has(value)) {
    res.status(400).json({ error: 'Invalid gallery type' })
    return false
  }
  return true
}

// Express middleware factory: validate `:type` against GALLERY_TYPES and any
// listed `:slug` params with isSafeSlug. Use as:
//   app.put('/api/gallery/admin/:type/:id', validatePathParams(['id']), authMiddleware, ...)
function validatePathParams(slugParams = [], { requireType = true } = {}) {
  return (req, res, next) => {
    if (requireType && 'type' in req.params && !requireGalleryType(req.params.type, res)) return
    for (const p of slugParams) {
      const v = req.params[p]
      if (v != null && !isSafeSlug(v)) {
        return res.status(400).json({ error: `Invalid ${p}` })
      }
    }
    next()
  }
}

// ============================================
// ATOMIC JSON WRITES + PER-FILE MUTEX
// ============================================
// Many endpoints do read-modify-write on small JSON files (meta.json,
// notifications.json, etc.). Two pitfalls:
//   1. Plain fs.writeFileSync truncates first then writes; an interrupted
//      write (process killed, ENOSPC) leaves the file empty or partially
//      written, corrupting the data.
//   2. Two concurrent requests can both read the old value, increment
//      independently, then both write — the second write loses one update.
//
// writeJsonAtomic() writes to a sibling tmp file then renames atomically,
// so a reader either sees the old or the new file, never a torn one.
// withFileLock() serializes async work that touches a given path within
// this Node process. Single-container deployment is assumed.

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  const json = JSON.stringify(data, null, 2)
  fs.writeFileSync(tmp, json)
  fs.renameSync(tmp, filePath)
}

// Atomic write for plain text files (e.g. prompt.txt). Do NOT use
// writeJsonAtomic here — that always JSON.stringifies, which would
// wrap user text in quotes and escape characters.
function writeTextAtomic(filePath, text) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, String(text ?? ''), 'utf-8')
  fs.renameSync(tmp, filePath)
}

const __fileLocks = new Map()
async function withFileLock(filePath, fn) {
  const key = path.resolve(filePath)
  const prev = __fileLocks.get(key) || Promise.resolve()
  let release
  const next = new Promise((resolve) => { release = resolve })
  const chained = prev.then(() => next)
  __fileLocks.set(key, chained)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (__fileLocks.get(key) === chained) {
      __fileLocks.delete(key)
    }
  }
}

// ============================================
// RATE LIMITING
// ============================================
// Three buckets:
//   loginLimiter   — strict, applied to admin login + Discord OAuth callback.
//                    5 attempts / 15 min per IP, no retry-skip on success
//                    (keeps brute-force attempts from cycling through users).
//   submitLimiter  — public mutation: new requests + admin-mode toggles. 30
//                    requests / 5 min per IP. Authenticated callers count
//                    too — admin should not be issuing 30 writes per 5 min.
//   counterLimiter — view/copy/download counters. 60 increments / minute /
//                    IP. Stops drive-by inflation while still allowing
//                    legitimate browsing.

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
})
const submitLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
})
const counterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Don't block on hit, just don't increment — saves the user a 429 popup
  // for a non-critical write. We still emit the standard headers.
  handler: (req, res) => res.status(429).json({ error: 'Slow down' }),
})

// Webhook configuration
const WEBHOOK_ENABLED = process.env.WEBHOOK_ENABLED === 'true'
const WEBHOOK_URL = process.env.WEBHOOK_URL
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET

// Discord OAuth2 configuration
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3001/api/auth/discord/callback'

// Discord channel webhook (separate from OAuth) — for posting "new content"
// notifications to a Discord channel.  Treat the URL as a secret.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ''
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''   // e.g. https://glyphforge.example.com

// Per-event-type Discord embed colors (hex int).  Keep distinct so the channel
// is glanceable.
const DISCORD_EVENT_STYLES = {
  new_lora:      { color: 0xff6699, emoji: '🎀', label: 'LoRA' },
  new_fn_lora:   { color: 0x9966ff, emoji: '⚙️', label: 'Functional LoRA' },
  new_prompt:    { color: 0x66ccff, emoji: '✨', label: 'Prompt' },
  new_costume:   { color: 0xffaa33, emoji: '👗', label: 'Costume' },
  new_workflow:  { color: 0x33cc99, emoji: '🧩', label: 'Workflow' },
  new_request:   { color: 0xffcc00, emoji: '📥', label: 'Request' },
  // Edit variants — darker / cooler shade of the same hue, ✏️ to distinguish
  edit_lora:     { color: 0xb34870, emoji: '✏️', label: 'LoRA' },
  edit_fn_lora:  { color: 0x6c47b3, emoji: '✏️', label: 'Functional LoRA' },
  edit_prompt:   { color: 0x4791b3, emoji: '✏️', label: 'Prompt' },
  edit_costume:  { color: 0xb37726, emoji: '✏️', label: 'Costume' },
  edit_workflow: { color: 0x269173, emoji: '✏️', label: 'Workflow' },
  edit_request:  { color: 0xb38f00, emoji: '✏️', label: 'Request' },
  // Whitelist + admin lifecycle events
  whitelist_request:    { color: 0xffcc66, emoji: '🙋', label: 'Whitelist Request' },
  whitelist_approve:    { color: 0x33cc66, emoji: '✅', label: 'Whitelist Approved' },
  whitelist_deny:       { color: 0xcc4444, emoji: '⛔', label: 'Whitelist Denied' },
  whitelist_add_direct: { color: 0x33cc66, emoji: '➕', label: 'Whitelist Added' },
  whitelist_revoke:     { color: 0xcc4444, emoji: '🚫', label: 'Whitelist Revoked' },
  admin_promote:        { color: 0xffd633, emoji: '👑', label: 'Admin Promoted' },
  admin_demote:         { color: 0x999999, emoji: '⬇️', label: 'Admin Demoted' },
  test:          { color: 0x808080, emoji: '🧪', label: 'Test' },
}

// Human-friendly labels for fields surfaced in edit notifications. Anything
// not in the map falls back to a Title Case version of the camelCase name.
const FIELD_LABELS = {
  character:        'Character',
  characterName:    'Character Name',
  characterCount:   'Character Count',
  cloth:            'Outfit',
  company:          'Company',
  group:            'Group',
  gender:           'Gender',
  model:            'Model',
  link:             'Link',
  prompt:           'Prompt',
  negativePrompt:   'Negative Prompt',
  title:            'Title',
  'sub-title':      'Sub-title',
  subTitle:         'Sub-title',
  type:             'Type',
  view:             'View',
  place:            'Place',
  nudity:           'Nudity',
  sensitive:        'Rating',
  stability:        'Stability',
  weight:           'Weight',
  author:           'Author',
  costumePrompt:    'Costume Prompt',
  usedFnLoras:      'Used Fn LoRAs',
  name:             'Name',
  description:      'Description',
  workflowFile:     'Workflow File',
  attachments:      'Attachments',
  outfit:           'Outfit',
  livestreamArchive:'Livestream Archive',
  channelLink:      'Channel Link',
  socialMediaLink:  'Social Media Link',
  fnLoraTitle:      'Fn LoRA Title',
  fnLoraSubTitle:   'Fn LoRA Sub-title',
  note:             'Note',
  status:           'Status',
  rejectReason:     'Reject Reason',
  thumbnail:        'Thumbnail',
}

function humanizeField(name) {
  if (FIELD_LABELS[name]) return FIELD_LABELS[name]
  // camelCase → Title Case (e.g. "myFieldName" → "My Field Name")
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Stable JSON for deep-equal comparison. Used to detect whether a meta
// field actually changed across an edit. Object key order is normalized.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

// Compute the list of fields whose values changed between oldMeta and newMeta.
// `fields` is the allowlist of fields to inspect; internal flags like
// `discordNotified`, `createdAt`, `updatedAt`, `order`, `submittedBy` are
// excluded by virtue of not being in the allowlist for any PUT handler.
function diffMeta(oldMeta, newMeta, fields) {
  const changed = []
  const o = oldMeta || {}
  const n = newMeta || {}
  for (const f of fields) {
    if (stableStringify(o[f]) !== stableStringify(n[f])) {
      changed.push(f)
    }
  }
  return changed
}

// Build a Discord embed payload for a given event.  Returns the body to POST
// to the webhook (`{ username, embeds: [...] }`).
function buildDiscordEmbed(eventType, data) {
  const style = DISCORD_EVENT_STYLES[eventType] || { color: 0x607d8b, emoji: '📦', label: eventType }
  const fields = []
  let title = `${style.emoji} New ${style.label}`
  let description = ''
  let url = PUBLIC_BASE_URL || undefined
  let embed_image_url = ''

  // Auth lifecycle events (whitelist requests, approval, admin promotion).
  // `data.target` is either a request object or { discordId, profile }.
  // `data.reviewer` is the admin who acted (omit on self-submit events).
  const isAuthEvent = typeof eventType === 'string' &&
    (eventType.startsWith('whitelist_') || eventType.startsWith('admin_'))
  if (isAuthEvent) {
    const target = data.target || data
    const profile = target.profile || data.profile || {
      username: data.username, globalName: data.globalName, avatar: data.avatar,
    }
    const targetId = target.discordId || data.discordId || 'unknown'
    const handle = (profile && (profile.globalName || profile.username)) || targetId
    title = `${style.emoji} ${style.label}: ${handle}`
    const descLines = []
    descLines.push(`**Discord ID:** \`${targetId}\``)
    if (data.reason || target.reason) {
      const r = String(data.reason || target.reason).slice(0, 400)
      descLines.push(`**Reason:** ${r}`)
    }
    if (data.note || target.reviewNote) {
      descLines.push(`**Note:** ${String(data.note || target.reviewNote).slice(0, 300)}`)
    }
    if (data.reviewer && (data.reviewer.username || data.reviewer.globalName)) {
      descLines.push(`**By:** ${data.reviewer.globalName || data.reviewer.username}`)
    }
    if (eventType === 'whitelist_revoke' && data.demoted) {
      descLines.push('_Also demoted from admin._')
    }
    description = descLines.join('\n')
    if (profile && profile.avatar && targetId !== 'unknown') {
      embed_image_url = `https://cdn.discordapp.com/avatars/${targetId}/${profile.avatar}.png?size=128`
    }
  } else
  // Edit events share a single rendering path: title shows the resource label
  // + identifier, description is either the admin-supplied note or an
  // auto-generated "Changed: a, b, c" line based on `changedFields`.
  if (typeof eventType === 'string' && eventType.startsWith('edit_')) {
    const name =
      data.title ||
      data.name ||
      data.character ||
      data.characterName ||
      (data.id !== undefined ? `#${data.id}` : 'Untitled')
    title = `${style.emoji} Updated ${style.label}: ${name}`
    const note = typeof data.editNote === 'string' ? data.editNote.trim() : ''
    if (note) {
      description = `📝 ${note.slice(0, 500)}`
    } else if (Array.isArray(data.changedFields) && data.changedFields.length) {
      const labels = data.changedFields.map(humanizeField)
      description = `🔧 Changed: ${labels.join(', ')}`
    } else {
      description = '🔧 Edited (no field-level changes detected)'
    }
    if (data.thumbnailUrl) embed_image_url = data.thumbnailUrl
  } else if (eventType === 'new_lora') {
    title = `${style.emoji} New LoRA: ${data.character || 'Untitled'}`
    if (data.cloth) description = `**Outfit:** ${data.cloth}`
    if (data.gender)   fields.push({ name: 'Gender', value: String(data.gender), inline: true })
    if (data.company)  fields.push({ name: 'Company', value: String(data.company), inline: true })
    if (data.group)    fields.push({ name: 'Group', value: String(data.group), inline: true })
    // model is an array of either strings or { name, version } objects
    if (Array.isArray(data.model) && data.model.length) {
      const modelStr = data.model
        .map((m) => {
          if (m && typeof m === 'object') {
            const name = m.name || ''
            const version = m.version ? ` ${m.version}` : ''
            return `${name}${version}`.trim()
          }
          return String(m)
        })
        .filter(Boolean)
        .join(', ')
      if (modelStr) fields.push({ name: 'Model', value: modelStr, inline: true })
    }
    // Preview thumbnail (the 0.png square thumbnail uploaded by admin)
    if (data.thumbnailUrl) {
      embed_image_url = data.thumbnailUrl
    }
  } else if (eventType === 'new_fn_lora') {
    title = `${style.emoji} New Functional LoRA: ${data.title || 'Untitled'}`
    if (data['sub-title']) description = String(data['sub-title'])
    if (data.type)       fields.push({ name: 'Type', value: String(data.type), inline: true })
    if (data.sensitive)  fields.push({ name: 'Rating', value: String(data.sensitive), inline: true })
    if (data.weight !== undefined && data.weight !== null) {
      fields.push({ name: 'Weight', value: String(data.weight), inline: true })
    }
  } else if (eventType === 'new_prompt') {
    title = `${style.emoji} New Prompt: ${data.title || `#${data.id ?? ''}`}`
    if (data.author)     fields.push({ name: 'Author', value: String(data.author), inline: true })
    if (data.type)       fields.push({ name: 'Type', value: String(data.type), inline: true })
    if (data.sensitive)  fields.push({ name: 'Rating', value: String(data.sensitive), inline: true })
    if (data.place && data.place !== 'Unknown') {
      fields.push({ name: 'Place', value: String(data.place), inline: true })
    }
  } else if (eventType === 'new_costume') {
    title = `${style.emoji} New Costume: ${data.title || `#${data.id ?? ''}`}`
    if (data.costumePrompt) {
      const trimmed = String(data.costumePrompt).slice(0, 300)
      description = `\`\`\`${trimmed}${data.costumePrompt.length > 300 ? '…' : ''}\`\`\``
    }
    if (data.author)     fields.push({ name: 'Author', value: String(data.author), inline: true })
    if (data.sensitive)  fields.push({ name: 'Rating', value: String(data.sensitive), inline: true })
  } else if (eventType === 'new_workflow') {
    title = `${style.emoji} New Workflow: ${data.name || 'Untitled'}`
    if (data.description) description = String(data.description).slice(0, 500)
  } else if (eventType === 'new_request') {
    title = `${style.emoji} New Request`
    description = `**${data.characterName || 'Unknown'}**${data.outfit ? ` — ${data.outfit}` : ''}`
    if (data.notes) fields.push({ name: 'Notes', value: String(data.notes).slice(0, 500) })
  } else if (eventType === 'test') {
    title = `${style.emoji} Glyphforge webhook test`
    description = 'If you see this, Discord notifications are wired up.'
  }

  const embed = {
    title,
    color: style.color,
    timestamp: new Date().toISOString(),
    footer: { text: 'Glyphforge' },
  }
  if (description) embed.description = description
  if (fields.length) embed.fields = fields
  if (url) embed.url = url
  if (embed_image_url) embed.thumbnail = { url: embed_image_url }

  const persona = getDiscordPersona(eventType)
  const result = {
    username: persona.username,
    avatar_url: persona.avatar_url,
    embeds: [embed],
  }
  // Optional @mention via top-level `content`. Only top-level content pings
  // users on Discord — mentions inside embed bodies are display-only and
  // never produce a notification. Used by new_lora when fulfilling a
  // request: `<@id> 你委託的 ... LoRA 完成囉！`. `allowed_mentions` is
  // scoped to just the mentioned user so we can't accidentally @everyone.
  if (data.mentionContent && typeof data.mentionContent === 'string') {
    result.content = data.mentionContent.slice(0, 1800)
    if (data.mentionDiscordId) {
      result.allowed_mentions = { users: [String(data.mentionDiscordId)] }
    } else {
      result.allowed_mentions = { parse: [] }
    }
  }
  return result
}

// ─── Discord persona config (admin-editable JSON) ───────────────────────────
// Per-event-type webhook username + avatar_url overrides. Lives in
// `${CONFIG_FOLDER_PATH}/discord-personas.json`. Re-read on every send when
// the file's mtime changes — so admins can edit the JSON and see results on
// the next notification without rebuilding the container.
const DISCORD_PERSONAS_PATH = path.join(CONFIG_FOLDER_PATH, 'discord-personas.json')
let _personaCache = { mtimeMs: 0, data: null }
const PERSONA_FALLBACK = {
  default: {
    username: 'Glyphforge',
    avatar_url: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/static/personas/default.png` : '',
  },
}
function loadDiscordPersonas() {
  try {
    const st = fs.statSync(DISCORD_PERSONAS_PATH)
    if (st.mtimeMs === _personaCache.mtimeMs && _personaCache.data) {
      return _personaCache.data
    }
    const raw = fs.readFileSync(DISCORD_PERSONAS_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      _personaCache = { mtimeMs: st.mtimeMs, data: parsed }
      return parsed
    }
  } catch (_e) {
    // File missing or malformed — fall through to fallback. Don't spam logs.
  }
  return PERSONA_FALLBACK
}
function getDiscordPersona(eventType) {
  const personas = loadDiscordPersonas()
  const fallback = personas.default || PERSONA_FALLBACK.default
  const specific = (eventType && personas[eventType]) || {}
  return {
    username: specific.username || fallback.username || 'Glyphforge',
    avatar_url: specific.avatar_url || fallback.avatar_url || '',
  }
}

// Fire-and-forget Discord channel notification.  Errors are logged but never
// thrown; never await this from inside a request handler that's about to
// respond to the user.
function sendDiscordNotification(eventType, data) {
  if (!DISCORD_WEBHOOK_URL) return
  // Whitelist / admin lifecycle events are intentionally NOT sent to the public
  // webhook channel — they are admin-only signals and would leak Discord IDs
  // and review notes to all channel viewers. Visible only in the admin Users
  // tab + audit log.
  if (typeof eventType === 'string' &&
      (eventType.startsWith('whitelist_') || eventType.startsWith('admin_'))) {
    return
  }
  const payload = buildDiscordEmbed(eventType, data || {})
  fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((resp) => {
      if (!resp.ok) {
        // Don't log the URL — it's a secret.
        console.error(`[discord] webhook responded ${resp.status} for ${eventType}`)
      }
    })
    .catch((err) => {
      console.error(`[discord] webhook error for ${eventType}: ${err.message}`)
    })
}

// AUTHENTICATION — Discord OAuth only
// ============================================
// All login goes through Discord OAuth (see /api/auth/discord{,/callback}
// further down). Admin status is derived from auth-store: a user is admin
// iff their Discord ID is the SUPER_ADMIN_DISCORD_ID env value OR present
// in admins.json. The legacy bcrypt password login is GONE.
//
// Three middlewares stack:
//   requireLogin     — any valid Discord JWT (used for /me, request submit,
//                      whitelist self-request endpoints).
//   requireWhitelist — login + isWhitelisted (gates non-LoRA reads).
//   requireAdmin     — login + isAdmin (gates all writes).
//
// Each request re-derives auth flags from auth-store (with the 60s cache)
// so revocation is effective without waiting for token expiry.

const authStore = createAuthStore({
  authDir: AUTH_FOLDER_PATH,
  writeJsonAtomic,
  sendDiscordNotification,
})

// Extract Discord JWT from either the Authorization header (preferred,
// used by fetch() calls from the SPA) or the `gf_session` httpOnly cookie
// (used for static asset requests like <img src>, where the browser cannot
// attach custom headers but does send cookies on same-origin requests).
// Returns the decoded payload (which has at least `discordId`) or null.
// Never throws.
function parseDiscordJwt(req) {
  let token = null
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7)
  } else if (req.headers.cookie) {
    // Manual cookie parse to avoid pulling in cookie-parser
    const parts = req.headers.cookie.split(';')
    for (const p of parts) {
      const idx = p.indexOf('=')
      if (idx === -1) continue
      const k = p.slice(0, idx).trim()
      if (k === 'gf_session') {
        token = decodeURIComponent(p.slice(idx + 1).trim())
        break
      }
    }
  }
  if (!token) return null
  try {
    return jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return null
  }
}

// Build the Set-Cookie value for our session cookie. Centralized so
// callback / probe / logout all stay consistent.
function buildSessionCookie(req, token, { clear = false } = {}) {
  const isHttps = (req.headers['x-forwarded-proto'] === 'https') || req.secure
  return [
    clear ? 'gf_session=' : `gf_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    clear ? 'Max-Age=0' : `Max-Age=${30 * 24 * 60 * 60}`,
    'SameSite=Lax',
    ...(isHttps ? ['Secure'] : []),
  ].join('; ')
}

// Populate req.auth = { user, flags } when a valid token is present.
// Does not reject; downstream middlewares decide.
function attachAuth(req, _res, next) {
  const decoded = parseDiscordJwt(req)
  if (decoded && decoded.discordId) {
    const flags = authStore.getAuthFlags(decoded.discordId)
    req.auth = {
      user: {
        discordId: decoded.discordId,
        username: decoded.username,
        globalName: decoded.globalName,
        avatar: decoded.avatar,
      },
      ...flags,
    }
    // Lazy profile backfill: if we have JWT claims but no on-disk profile
    // (e.g. an old data-dir bug wiped it), refill from the JWT so admin UI
    // can render usernames instead of bare snowflake IDs. Cheap because
    // profiles are JSON-cached in memory after first load.
    try {
      const existing = authStore.getProfile(decoded.discordId)
      if (!existing && decoded.username) {
        authStore.upsertProfile({
          discordId: decoded.discordId,
          username: decoded.username,
          globalName: decoded.globalName || decoded.username,
          avatar: decoded.avatar,
        })
      }
    } catch (_e) { /* non-fatal */ }
  } else {
    req.auth = null
  }
  next()
}
app.use(attachAuth)

function requireLogin(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Login required' })
  return next()
}

function requireWhitelist(req, res, next) {
  if (!req.auth) {
    if (req.path.startsWith('/api/')) {
      console.log(`[auth-deny] 401 ${req.method} ${req.path} — no auth (cookie=${req.headers.cookie ? 'present' : 'none'}, bearer=${req.headers.authorization ? 'present' : 'none'})`)
    }
    return res.status(401).json({ error: 'Login required' })
  }
  if (!req.auth.isWhitelisted) {
    console.log(`[auth-deny] 403 ${req.method} ${req.path} — user=${req.auth.user.discordId} (${req.auth.user.username}) isAdmin=${req.auth.isAdmin} isSuper=${req.auth.isSuperAdmin}`)
    return res.status(403).json({ error: 'Whitelist approval required', needsWhitelist: true })
  }
  return next()
}

function requireAdmin(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Login required' })
  if (!req.auth.isAdmin) return res.status(403).json({ error: 'Admin required' })
  return next()
}

// Legacy aliases used by older route definitions in this file. Both now
// resolve to admin gating — every write path requires admin.
const authMiddleware = requireAdmin
const verifyToken = requireAdmin

// Per-IP+per-Discord rate limit for the self-service whitelist request
// endpoint. Keep it sane: spam-protection only, not a hard cap.
const requestAccessLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.auth?.discordId) return `discord:${req.auth.discordId}`
    return req.ip
  },
  message: { error: 'Too many access requests; try again later.' },
})

// ============================================
// END AUTHENTICATION SETUP
// ============================================


// Send webhook notification for new requests
async function sendWebhookNotification(eventType, data) {
  if (!WEBHOOK_ENABLED || !WEBHOOK_URL) {
    return
  }

  try {
    // Format message for Clawdbot
    let message = ''
    if (eventType === 'new_request') {
      const lines = [
        `🎨 **GlyphForge 收到新的 Request！**`,
        ``,
        `📝 類型: ${data.type === 'lora' ? 'LoRA 訓練' : data.type}`,
        `👤 角色: ${data.characterName || '未指定'}`,
      ]
      
      if (data.outfit) lines.push(`👗 服裝: ${data.outfit}`)
      if (data.notes) lines.push(`💬 備註: ${data.notes}`)
      
      lines.push(`🔖 ID: \`${data.id}\``)
      lines.push(``)
      
      // Add links section if any
      const links = []
      if (data.channelLink) links.push(`📺 [頻道](${data.channelLink})`)
      if (data.socialMediaLink) links.push(`🐦 [社群](${data.socialMediaLink})`)
      if (data.livestreamArchive) links.push(`🎬 [直播存檔](${data.livestreamArchive})`)
      
      if (links.length > 0) {
        lines.push(`🔗 相關連結: ${links.join(' | ')}`)
      }
      
      message = lines.join('\n')
    } else {
      message = `GlyphForge Event: ${eventType}\n${JSON.stringify(data, null, 2)}`
    }

    // Use Clawdbot webhook format
    const payload = {
      message: message,
      name: 'GlyphForge',
      deliver: true,
      channel: 'telegram'
    }

    const headers = {
      'Content-Type': 'application/json'
    }

    if (WEBHOOK_SECRET) {
      headers['Authorization'] = `Bearer ${WEBHOOK_SECRET}`
    }

    // Use /hooks/agent endpoint
    const webhookUrl = WEBHOOK_URL.replace(/\/hooks\/?$/, '/hooks/agent')
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      console.error(`Webhook notification failed: ${response.status} ${response.statusText}`)
    } else {
      console.log(`Webhook notification sent successfully for ${eventType}`)
    }
  } catch (error) {
    console.error('Error sending webhook notification:', error.message)
  }
}

// Serve static files from dist folder in production.
// CRITICAL: index.html MUST be served with no-cache so that browsers always
// fetch the latest one (which points at the latest hashed bundle filename).
// The hashed bundle files themselves are safe to long-cache because their
// filename changes on every build.
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, 'dist')
  // Serve index.html with strict no-cache headers
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    res.sendFile(path.join(distPath, 'index.html'))
  })
  // Everything else (hashed bundles, /assets/*, /icons/*, etc.) — default static
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      // Belt-and-suspenders: never cache any html
      if (filePath.endsWith('.html')) {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
        res.set('Pragma', 'no-cache')
        res.set('Expires', '0')
      } else if (/\.(js|css|woff2?|png|jpg|jpeg|webp|svg|ico)$/i.test(filePath)) {
        // Hashed bundles + static assets — safe to long-cache (filename has hash)
        res.set('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }))
}

// Cache options for static files - enable browser caching for images
const staticOptions = {
  maxAge: '1d',        // Cache for 1 day (86400000 ms)
  etag: true,          // Enable ETag for change detection
  lastModified: true,  // Use Last-Modified header
  immutable: false     // Allow revalidation
}

// Gallery has shorter cache time for frequent updates
const galleryOptions = {
  maxAge: '5m',        // Cache for 5 minutes only
  etag: true,          // Enable ETag for change detection
  lastModified: true,  // Use Last-Modified header
  immutable: false     // Allow revalidation
}

// Static file service - serve images from configured folder with caching.
// Non-LoRA folders are gated by requireWhitelist. Browsers can't attach
// custom headers to <img src>, so we rely on the gf_session httpOnly
// cookie (set during OAuth callback / /api/auth/me probe). LoRA folder
// stays public to match the "anon sees only LoRA tab" rule.
app.use(`/${PROMPT_FOLDER_NAME}`, requireWhitelist, express.static(PROMPT_FOLDER_PATH, staticOptions))
if (COSTUME_FOLDER_PATH) {
  app.use(`/${COSTUME_FOLDER_NAME}`, requireWhitelist, express.static(COSTUME_FOLDER_PATH, staticOptions))
}
app.use(`/${LORA_FOLDER_NAME}`, express.static(LORA_FOLDER_PATH, staticOptions))
// Public static assets (persona avatars etc.) — MUST be unauthenticated so
// Discord's CDN can fetch webhook avatar_url. Don't put sensitive files here.
app.use('/static', express.static(STATIC_FOLDER_PATH, staticOptions))
app.use(`/${GALLERY_FOLDER_NAME}`, requireWhitelist, express.static(GALLERY_FOLDER_PATH, galleryOptions))

// API route - get all prompt data
app.get('/api/prompts', requireWhitelist, async (req, res) => {
  try {
    const folders = fs.readdirSync(PROMPT_FOLDER_PATH).filter(file => {
      return fs.statSync(path.join(PROMPT_FOLDER_PATH, file)).isDirectory()
    })

    const prompts = folders.map(folder => {
      const folderPath = path.join(PROMPT_FOLDER_PATH, folder)
      const promptPath = path.join(folderPath, 'prompt.txt')
      const negativePath = path.join(folderPath, 'negative.txt')
      const metaPath = path.join(folderPath, 'meta.json')

      let promptText = ''
      if (fs.existsSync(promptPath)) {
        promptText = fs.readFileSync(promptPath, 'utf-8')
      }

      let negativePrompt = ''
      if (fs.existsSync(negativePath)) {
        negativePrompt = fs.readFileSync(negativePath, 'utf-8')
      }

      // Read meta.json if exists
      let meta = {
        character: 1,
        place: 'Unknown',
        sensitive: 'Unknown',
        type: 'Unknown',
        view: 'Unknown',
        nudity: 'Unknown',
        stability: null,
        author: null
      }
      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData }
        } catch (error) {
          console.error(`Error reading meta.json for ${folder}:`, error)
        }
      }

      // Scan all images in the folder
      const files = fs.readdirSync(folderPath)
      const imageFiles = files.filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
        .sort()

      const images = []
      let imageOrientation = 'unknown'

      // Detect image orientation from first image
      if (imageFiles.length > 0) {
        const firstImagePath = path.join(folderPath, imageFiles[0])
        try {
          const dimensions = sizeOf(firstImagePath)
          imageOrientation = dimensions.width > dimensions.height ? 'landscape' : 'portrait'
        } catch (error) {
          console.error(`Error reading image dimensions for ${firstImagePath}:`, error)
        }

        // Add all available images (up to 2) with their actual modification time as cache key
        imageFiles.slice(0, 2).forEach(file => {
          const filePath = path.join(folderPath, file)
          const stats = fs.statSync(filePath)
          const mtime = stats.mtimeMs.toString(36) // Use base36 for shorter string
          images.push(`/${PROMPT_FOLDER_NAME}/${folder}/${file}?v=${mtime}`)
        })
      }

      const imagesWithCacheBuster = images
      
      return {
        id: folder,
        thumbnail: imagesWithCacheBuster[0] || '',
        images: imagesWithCacheBuster,
        imageOrientation: imageOrientation,
        prompt: promptText,
        negativePrompt: negativePrompt,
        title: meta.title || '',
        character: meta.character || 1,
        place: meta.place || 'Unknown',
        sensitive: meta.sensitive || 'Unknown',
        type: meta.type || 'Unknown',
        view: meta.view || 'Unknown',
        nudity: meta.nudity || 'Unknown',
        stability: meta.stability || null,
        author: meta.author || 'dANNY',
        copyCount: meta.copyCount || 0,
        usedFnLoras: meta.usedFnLoras || []
      }
    })

    res.json(prompts)
  } catch (error) {
    console.error('Error reading prompts:', error)
    res.status(500).json({ error: 'Failed to load prompts' })
  }
})

// API route - get all costume data
app.get('/api/costumes', requireWhitelist, async (req, res) => {
  if (!COSTUME_FOLDER_PATH) {
    return res.json([])
  }
  
  try {
    const folders = fs.readdirSync(COSTUME_FOLDER_PATH).filter(file => {
      return fs.statSync(path.join(COSTUME_FOLDER_PATH, file)).isDirectory()
    })

    const costumes = folders.map(folder => {
      const folderPath = path.join(COSTUME_FOLDER_PATH, folder)
      const promptPath = path.join(folderPath, 'prompt.txt')
      const metaPath = path.join(folderPath, 'meta.json')

      let promptText = ''
      if (fs.existsSync(promptPath)) {
        promptText = fs.readFileSync(promptPath, 'utf-8')
      }

      // Read meta.json if exists
      let meta = {
        character: 1,
        place: 'Unknown',
        sensitive: 'Unknown',
        type: 'Costume',
        view: 'Unknown',
        nudity: 'Unknown',
        stability: null,
        author: null
      }
      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData }
        } catch (error) {
          console.error(`Error reading meta.json for costume ${folder}:`, error)
        }
      }

      // Scan all images in the folder
      const files = fs.readdirSync(folderPath)
      const imageFiles = files.filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
        .sort()

      const images = []
      let imageOrientation = 'unknown'

      // Detect image orientation from first image
      if (imageFiles.length > 0) {
        const firstImagePath = path.join(folderPath, imageFiles[0])
        try {
          const dimensions = sizeOf(firstImagePath)
          imageOrientation = dimensions.width > dimensions.height ? 'landscape' : 'portrait'
        } catch (error) {
          console.error(`Error reading image dimensions for ${firstImagePath}:`, error)
        }

        // Add all available images (up to 2) with their actual modification time as cache key
        imageFiles.slice(0, 2).forEach(file => {
          const filePath = path.join(folderPath, file)
          const stats = fs.statSync(filePath)
          const mtime = stats.mtimeMs.toString(36) // Use base36 for shorter string
          images.push(`/${COSTUME_FOLDER_NAME}/${folder}/${file}?v=${mtime}`)
        })
      }

      const imagesWithCacheBuster = images
      
      return {
        id: folder,
        thumbnail: imagesWithCacheBuster[0] || '',
        images: imagesWithCacheBuster,
        imageOrientation: imageOrientation,
        prompt: promptText,
        costumePrompt: meta.costumePrompt || '',  // Pure costume prompt (clothing only)
        title: meta.title || '',
        character: meta.character || 1,
        place: meta.place || 'Unknown',
        sensitive: meta.sensitive || 'Unknown',
        type: meta.type || 'Costume',
        view: meta.view || 'Unknown',
        nudity: meta.nudity || 'Unknown',
        stability: meta.stability || null,
        author: meta.author || 'dANNY',
        copyCount: meta.copyCount || 0
      }
    })

    // Load or create metadata
    const metadataPath = path.join(COSTUME_FOLDER_PATH, 'metadata.json')
    let metadata = { typeOrder: [], costumeOrder: {} }
    
    if (fs.existsSync(metadataPath)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
      } catch (error) {
        console.error('Error reading costume metadata:', error)
      }
    }

    // Get all unique types from costumes
    const allTypes = [...new Set(costumes.map(c => c.type).filter(t => t && t !== 'Unknown'))]
    
    // Check for new types and add them to typeOrder
    let metadataChanged = false
    allTypes.forEach(type => {
      if (!metadata.typeOrder.includes(type)) {
        metadata.typeOrder.push(type)
        metadataChanged = true
      }
    })
    
    // Remove types that no longer exist
    metadata.typeOrder = metadata.typeOrder.filter(type => allTypes.includes(type))
    
    // Initialize costumeOrder for new types and update existing ones
    allTypes.forEach(type => {
      const typeCostumes = costumes.filter(c => c.type === type).map(c => c.id)
      if (!metadata.costumeOrder[type]) {
        metadata.costumeOrder[type] = typeCostumes
        metadataChanged = true
      } else {
        // Add any new costumes to the end
        typeCostumes.forEach(id => {
          if (!metadata.costumeOrder[type].includes(id)) {
            metadata.costumeOrder[type].push(id)
            metadataChanged = true
          }
        })
        // Remove costumes that no longer exist or changed type
        metadata.costumeOrder[type] = metadata.costumeOrder[type].filter(id => typeCostumes.includes(id))
      }
    })
    
    // Remove costumeOrder entries for types that no longer exist
    Object.keys(metadata.costumeOrder).forEach(type => {
      if (!allTypes.includes(type)) {
        delete metadata.costumeOrder[type]
        metadataChanged = true
      }
    })
    
    // Save metadata if changed
    if (metadataChanged) {
      writeJsonAtomic(metadataPath, metadata)
    }

    res.json({ costumes, metadata })
  } catch (error) {
    console.error('Error reading costumes:', error)
    res.status(500).json({ error: 'Failed to load costumes' })
  }
})

// API route - update costume metadata (type order and costume order)
app.put('/api/costumes/metadata', authMiddleware, (req, res) => {
  if (!COSTUME_FOLDER_PATH) {
    return res.status(404).json({ error: 'Costume folder not configured' })
  }

  try {
    const { typeOrder, costumeOrder } = req.body
    const metadataPath = path.join(COSTUME_FOLDER_PATH, 'metadata.json')
    
    let metadata = { typeOrder: [], costumeOrder: {} }
    if (fs.existsSync(metadataPath)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
      } catch (error) {
        console.error('Error reading costume metadata:', error)
      }
    }
    
    if (typeOrder !== undefined) {
      metadata.typeOrder = typeOrder
    }
    if (costumeOrder !== undefined) {
      metadata.costumeOrder = { ...metadata.costumeOrder, ...costumeOrder }
    }
    
    writeJsonAtomic(metadataPath, metadata)


    res.json({ success: true, metadata })
  } catch (error) {
    console.error('Error updating costume metadata:', error)
    res.status(500).json({ error: 'Failed to update metadata' })
  }
})

// API route - get all LoRA data
app.get('/api/loras', async (req, res) => {
  try {
    const characterFolderPath = path.join(LORA_FOLDER_PATH, 'character')

    // Check if character folder exists
    if (!fs.existsSync(characterFolderPath)) {
      console.error('Character folder not found:', characterFolderPath)
      return res.json([])
    }

    const folders = fs.readdirSync(characterFolderPath).filter(file => {
      return fs.statSync(path.join(characterFolderPath, file)).isDirectory()
    })

    const loras = folders.map(folder => {
      const folderPath = path.join(characterFolderPath, folder)
      const metaPath = path.join(folderPath, 'meta.json')
      const thumbnailPath = path.join(folderPath, '0.png')
      const previewPath = path.join(folderPath, '1.png')

      // Read meta.json
      let meta = {
        character: folder,
        cloth: '',
        link: '',
        prompt: ''
      }
      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData }
        } catch (error) {
          console.error(`Error reading meta.json for ${folder}:`, error)
        }
      }

      // Generate display name: character or character-cloth
      const displayName = meta.cloth && meta.cloth.trim() !== ''
        ? `${meta.character}-${meta.cloth}`
        : meta.character

      // Find all .safetensors files
      const files = fs.readdirSync(folderPath)
      const safetensorsFiles = files.filter(file => file.endsWith('.safetensors'))

      // Process model information (support both array and string formats)
      let modelInfo = meta.model || ''
      let modelMap = {}

      // If model is an array, create a map for version lookup
      if (Array.isArray(meta.model)) {
        meta.model.forEach(m => {
          const key = m.name.toLowerCase()
          modelMap[key] = `${m.name} ${m.version}`
        })
        // For display, join all model info
        modelInfo = meta.model.map(m => `${m.name} ${m.version}`).join(', ')
      }

      // Build versions in meta.model order so the LoRA detail modal shows
      // them in the configured order; orphan .safetensors files (no matching
      // meta.model entry) go to the end. Versions configured in meta.model
      // but without a .safetensors file on disk are still listed (filePath
      // empty so the download button is hidden, but the version toggle and
      // per-version images still work).
      const allFiles = fs.readdirSync(folderPath)
      const collectImagesFor = (versionName) => {
        const out = []
        const lower = (versionName || '').toLowerCase()
        for (let i = 1; i <= 10; i++) {
          const match = allFiles.find(f => f.toLowerCase() === `${i}(${lower}).png`)
          if (match) {
            const imagePath = path.join(folderPath, match)
            const mtime = fs.statSync(imagePath).mtimeMs.toString(36)
            out.push(`/${LORA_FOLDER_NAME}/character/${folder}/${match}?v=${mtime}`)
          }
        }
        if (out.length === 0) {
          for (let i = 1; i <= 10; i++) {
            const imageFileName = `${i}.png`
            if (allFiles.includes(imageFileName)) {
              const imagePath = path.join(folderPath, imageFileName)
              const mtime = fs.statSync(imagePath).mtimeMs.toString(36)
              out.push(`/${LORA_FOLDER_NAME}/character/${folder}/${imageFileName}?v=${mtime}`)
            }
          }
        }
        return out
      }
      const findSafetensorByVersion = (versionName) => {
        const lower = (versionName || '').toLowerCase()
        return safetensorsFiles.find(f => {
          const m = f.match(/\(([^)]+)\)\.safetensors$/)
          return m && m[1].toLowerCase() === lower
        }) || null
      }

      const versions = []
      const usedSafetensors = new Set()
      if (Array.isArray(meta.model) && meta.model.length > 0) {
        meta.model.forEach(m => {
          if (!m || !m.name) return
          const versionName = m.name.toLowerCase()
          const file = findSafetensorByVersion(versionName)
          if (file) usedSafetensors.add(file)
          versions.push({
            name: versionName,
            displayName: `${m.name}${m.version ? ' ' + m.version : ''}`.trim(),
            fileName: file || '',
            filePath: file ? `/${LORA_FOLDER_NAME}/character/${folder}/${file}` : '',
            images: collectImagesFor(versionName),
            prompt: typeof m.prompt === 'string' ? m.prompt : (meta.prompt || ''),
          })
        })
      }
      // Append any orphan .safetensors files that weren't claimed by meta.model
      safetensorsFiles.forEach(file => {
        if (usedSafetensors.has(file)) return
        const match = file.match(/\(([^)]+)\)\.safetensors$/)
        const versionName = match ? match[1] : 'default'
        let displayName = versionName
        if (Object.keys(modelMap).length > 0) {
          displayName = modelMap[versionName.toLowerCase()] || versionName
        }
        versions.push({
          name: versionName,
          displayName,
          fileName: file,
          filePath: `/${LORA_FOLDER_NAME}/character/${folder}/${file}`,
          images: collectImagesFor(versionName),
          prompt: meta.prompt || '',
        })
      })

      // For backward compatibility, use first file as default
      const defaultVersion = versions[0] || { name: '', displayName: '', fileName: '', filePath: '' }

      // Get modification times for cache busting
      const thumbnailMtime = fs.existsSync(thumbnailPath) ? fs.statSync(thumbnailPath).mtimeMs.toString(36) : ''
      const previewMtime = fs.existsSync(previewPath) ? fs.statSync(previewPath).mtimeMs.toString(36) : ''

      return {
        id: folder,
        name: displayName,
        thumbnail: fs.existsSync(thumbnailPath) ? `/${LORA_FOLDER_NAME}/character/${folder}/0.png?v=${thumbnailMtime}` : '',
        preview: fs.existsSync(previewPath) ? `/${LORA_FOLDER_NAME}/character/${folder}/1.png?v=${previewMtime}` : '',
        link: meta.link || '',
        prompt: meta.prompt || '',
        // Legacy fields for backward compatibility
        safetensorsFile: defaultVersion.fileName,
        safetensorsPath: defaultVersion.filePath,
        // New fields for multiple versions
        versions: versions,
        hasMultipleVersions: versions.length > 1,
        // Include all meta fields
        character: meta.character || folder,
        cloth: meta.cloth || '',
        company: meta.company || '',
        group: meta.group || '',
        gender: meta.gender || '',
        characterCount: meta.characterCount || 1,
        model: modelInfo,
        modelRaw: Array.isArray(meta.model) ? meta.model : [], // Raw model array for editing
        copyCount: meta.copyCount || 0,
        downloadCount: meta.downloadCount || 0
      }
    })

    res.json(loras)
  } catch (error) {
    console.error('Error reading LoRAs:', error)
    res.status(500).json({ error: 'Failed to load LoRAs' })
  }
})

// API route - increment prompt copy count
app.post('/api/prompts/:id/copy', counterLimiter, (req, res) => {
  try {
    const { id } = req.params
    const metaPath = path.join(PROMPT_FOLDER_PATH, id, 'meta.json')

    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      meta.copyCount = (meta.copyCount || 0) + 1
      writeJsonAtomic(metaPath, meta)
      res.json({ success: true, copyCount: meta.copyCount })
    } else {
      res.status(404).json({ error: 'Meta file not found' })
    }
  } catch (error) {
    console.error('Error updating prompt copy count:', error)
    res.status(500).json({ error: 'Failed to update copy count' })
  }
})

// API route - increment costume copy count
app.post('/api/costumes/:id/copy', counterLimiter, (req, res) => {
  if (!COSTUME_FOLDER_PATH) {
    return res.status(404).json({ error: 'Costume folder not configured' })
  }
  
  try {
    const { id } = req.params
    const metaPath = path.join(COSTUME_FOLDER_PATH, id, 'meta.json')

    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      meta.copyCount = (meta.copyCount || 0) + 1
      writeJsonAtomic(metaPath, meta)
      res.json({ success: true, copyCount: meta.copyCount })
    } else {
      res.status(404).json({ error: 'Meta file not found' })
    }
  } catch (error) {
    console.error('Error updating costume copy count:', error)
    res.status(500).json({ error: 'Failed to update copy count' })
  }
})

// API route - create new costume (admin only)
app.post('/api/costumes', authMiddleware, (req, res) => {
  if (!COSTUME_FOLDER_PATH) {
    return res.status(404).json({ error: 'Costume folder not configured' })
  }

  try {
    const { title, prompt, costumePrompt, character, place, sensitive, type, view, nudity, stability, author } = req.body

    // Find next available ID (folder name)
    const existingFolders = fs.readdirSync(COSTUME_FOLDER_PATH)
      .filter(file => fs.statSync(path.join(COSTUME_FOLDER_PATH, file)).isDirectory())
      .map(f => parseInt(f))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b)

    const nextId = existingFolders.length > 0 ? Math.max(...existingFolders) + 1 : 0
    const newFolderPath = path.join(COSTUME_FOLDER_PATH, nextId.toString())

    // Create folder
    fs.mkdirSync(newFolderPath, { recursive: true })

    // Create prompt.txt (scene prompt)
    writeTextAtomic(path.join(newFolderPath, 'prompt.txt'), prompt || '')

    // Create meta.json
    const meta = {
      title: title || '',
      costumePrompt: costumePrompt || '',  // Pure costume prompt (clothing only)
      character: character || 1,
      place: place || 'Unknown',
      sensitive: sensitive || 'SFW',
      type: type || 'Costume',
      view: view || 'Unknown',
      nudity: nudity || 'Unknown',
      stability: stability || 1,
      author: author || 'dANNY',
      copyCount: 0
    }
    writeJsonAtomic(path.join(newFolderPath, 'meta.json'), meta)


    sendDiscordNotification('new_costume', { ...meta, id: nextId.toString() })
    res.json({
      success: true,
      message: 'Costume created successfully',
      id: nextId.toString()
    })
  } catch (error) {
    console.error('Error creating costume:', error)
    res.status(500).json({ error: 'Failed to create costume' })
  }
})

// API route - update costume (admin only)
app.put('/api/costumes/:id', authMiddleware, (req, res) => {
  if (!COSTUME_FOLDER_PATH) {
    return res.status(404).json({ error: 'Costume folder not configured' })
  }

  try {
    const { id } = req.params
    const { title, prompt, costumePrompt, character, place, sensitive, type, view, nudity, stability, author, editNote } = req.body
    const folderPath = path.join(COSTUME_FOLDER_PATH, id)
    const metaPath = path.join(folderPath, 'meta.json')
    const promptPath = path.join(folderPath, 'prompt.txt')

    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: 'Costume folder not found' })
    }

    // Snapshot old prompt.txt for diff
    let oldPrompt = ''
    if (fs.existsSync(promptPath)) {
      try { oldPrompt = fs.readFileSync(promptPath, 'utf-8') } catch { /* ignore */ }
    }

    // Update prompt.txt (scene prompt)
    if (prompt !== undefined) {
      writeTextAtomic(promptPath, prompt)
    }

    // Update meta.json
    let meta = {}
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    }
    const oldMeta = JSON.parse(JSON.stringify(meta))

    // Update meta fields if provided
    if (title !== undefined) meta.title = title
    if (costumePrompt !== undefined) meta.costumePrompt = costumePrompt  // Pure costume prompt
    if (character !== undefined) meta.character = character
    if (place !== undefined) meta.place = place
    if (sensitive !== undefined) meta.sensitive = sensitive
    if (type !== undefined) meta.type = type
    if (view !== undefined) meta.view = view
    if (nudity !== undefined) meta.nudity = nudity
    if (stability !== undefined) meta.stability = stability
    if (author !== undefined) meta.author = author

    writeJsonAtomic(metaPath, meta)

    try {
      const metaFields = ['title', 'costumePrompt', 'character', 'place', 'sensitive', 'type', 'view', 'nudity', 'stability', 'author']
      const changedFields = diffMeta(oldMeta, meta, metaFields)
      if (prompt !== undefined && prompt !== oldPrompt) changedFields.push('prompt')
      if (changedFields.length || (editNote && String(editNote).trim())) {
        const thumbPath = path.join(folderPath, '0.webp')
        let thumbnailUrl = ''
        if (PUBLIC_BASE_URL && fs.existsSync(thumbPath)) {
          const mtime = fs.statSync(thumbPath).mtimeMs
          thumbnailUrl = `${PUBLIC_BASE_URL}/${COSTUME_FOLDER_NAME}/${id}/0.webp?v=${mtime}`
        }
        sendDiscordNotification('edit_costume', { ...meta, id, changedFields, editNote, thumbnailUrl })
      }
    } catch (notifyErr) {
      console.error('[discord] failed to dispatch edit_costume:', notifyErr.message)
    }

    res.json({ success: true, message: 'Costume updated successfully' })
  } catch (error) {
    console.error('Error updating costume:', error)
    res.status(500).json({ error: 'Failed to update costume' })
  }
})

// Configure multer for costume image uploads - use temp directory first
const costumeUpload = multer({
  storage: multer.memoryStorage(), // Store in memory for processing
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF files are allowed'))
    }
  },
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB limit for source images
  }
})

// Helper function to convert image to WebP
async function convertToWebP(inputBuffer, outputPath, options = {}) {
  const { quality = 85, maxWidth = 2048 } = options
  
  let transformer = sharp(inputBuffer)
  
  // Get metadata to check dimensions
  const metadata = await transformer.metadata()
  
  // Resize if too large (maintain aspect ratio)
  if (metadata.width > maxWidth) {
    transformer = transformer.resize(maxWidth, null, { withoutEnlargement: true })
  }
  
  // Convert to WebP with good quality
  await transformer
    .webp({ quality })
    .toFile(outputPath)
  
  return outputPath
}

// API route - upload costume image (admin only) with WebP conversion
app.post('/api/costumes/:id/image/:imageIndex', authMiddleware, costumeUpload.single('image'), async (req, res) => {
  console.log('Upload costume image called:', { id: req.params.id, imageIndex: req.params.imageIndex, originalName: req.file?.originalname })
  
  if (!COSTUME_FOLDER_PATH) {
    return res.status(404).json({ error: 'Costume folder not configured' })
  }

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' })
    }

    const { id, imageIndex } = req.params
    const folderPath = path.join(COSTUME_FOLDER_PATH, id)
    const idx = parseInt(imageIndex)

    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: 'Costume folder not found' })
    }

    // Get existing images sorted
    const existingFiles = fs.readdirSync(folderPath)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort()
    
    // Delete existing file at this index if exists
    if (existingFiles[idx]) {
      const fileToDelete = path.join(folderPath, existingFiles[idx])
      console.log('Deleting existing costume file:', fileToDelete)
      fs.unlinkSync(fileToDelete)
    }

    // Convert to WebP and save
    const newFilename = `${idx}.webp`
    const outputPath = path.join(folderPath, newFilename)
    
    await convertToWebP(req.file.buffer, outputPath, { quality: 85 })
    console.log('Converted and saved costume image as WebP:', outputPath)

    // Get updated image list with cache busters
    const files = fs.readdirSync(folderPath)
    const imageFiles = files.filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file)).sort()
    const images = imageFiles.map(file => {
      const filePath = path.join(folderPath, file)
      const stats = fs.statSync(filePath)
      const mtime = stats.mtimeMs.toString(36)
      return `/${COSTUME_FOLDER_NAME}/${id}/${file}?v=${mtime}`
    })


    res.json({
      success: true,
      message: 'Image uploaded and converted to WebP successfully',
      filename: newFilename,
      images: images
    })
  } catch (error) {
    console.error('Error uploading costume image:', error)
    res.status(500).json({ error: 'Failed to upload image: ' + error.message })
  }
})

// API route - increment LoRA copy count
app.post('/api/loras/:id/copy', counterLimiter, (req, res) => {
  try {
    const { id } = req.params
    const metaPath = path.join(LORA_FOLDER_PATH, 'character', id, 'meta.json')

    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      meta.copyCount = (meta.copyCount || 0) + 1
      writeJsonAtomic(metaPath, meta)
      res.json({ success: true, copyCount: meta.copyCount })
    } else {
      res.status(404).json({ error: 'Meta file not found' })
    }
  } catch (error) {
    console.error('Error updating LoRA copy count:', error)
    res.status(500).json({ error: 'Failed to update copy count' })
  }
})

// API route - increment LoRA download count
app.post('/api/loras/:id/download', counterLimiter, (req, res) => {
  try {
    const { id } = req.params
    const metaPath = path.join(LORA_FOLDER_PATH, 'character', id, 'meta.json')

    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      meta.downloadCount = (meta.downloadCount || 0) + 1
      writeJsonAtomic(metaPath, meta)
      res.json({ success: true, downloadCount: meta.downloadCount })
    } else {
      res.status(404).json({ error: 'Meta file not found' })
    }
  } catch (error) {
    console.error('Error updating LoRA download count:', error)
    res.status(500).json({ error: 'Failed to update download count' })
  }
})

// ============================================
// FUNCTIONAL LORA API
// ============================================

// API route - get all functional LoRAs
app.get('/api/fn-loras', requireWhitelist, async (req, res) => {
  try {
    const fnLoraFolderPath = path.join(LORA_FOLDER_PATH, 'functional')

    // Check if functional folder exists
    if (!fs.existsSync(fnLoraFolderPath)) {
      console.log('Functional LoRA folder not found, creating:', fnLoraFolderPath)
      fs.mkdirSync(fnLoraFolderPath, { recursive: true })
      return res.json([])
    }

    const folders = fs.readdirSync(fnLoraFolderPath).filter(file => {
      const filePath = path.join(fnLoraFolderPath, file)
      return fs.statSync(filePath).isDirectory() && !file.startsWith('@')
    })

    const fnLoras = folders.map(folder => {
      const folderPath = path.join(fnLoraFolderPath, folder)
      const metaPath = path.join(folderPath, 'meta.json')
      const thumbnailPath = path.join(folderPath, '0.png')

      // Read meta.json
      let meta = {
        type: '',
        link: '',
        prompt: '',
        'serial-number': 0
      }
      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData }
        } catch (error) {
          console.error(`Error reading meta.json for ${folder}:`, error)
        }
      }

      // Find all .safetensors files
      const files = fs.readdirSync(folderPath)
      const safetensorsFiles = files.filter(file => file.endsWith('.safetensors'))

      // Process model information
      let modelInfo = meta.model || ''
      let modelMap = {}

      if (Array.isArray(meta.model)) {
        meta.model.forEach(m => {
          const key = m.name.toLowerCase()
          modelMap[key] = `${m.name} ${m.version}`
        })
        modelInfo = meta.model.map(m => `${m.name} ${m.version}`).join(', ')
      }

      // Build versions in meta.model order (see character branch above for rationale).
      const allFiles = fs.readdirSync(folderPath)
      const collectImagesFor = (versionName) => {
        const out = []
        const lower = (versionName || '').toLowerCase()
        for (let i = 1; i <= 10; i++) {
          const match = allFiles.find(f => f.toLowerCase() === `${i}(${lower}).png`)
          if (match) {
            const imagePath = path.join(folderPath, match)
            const mtime = fs.statSync(imagePath).mtimeMs.toString(36)
            out.push(`/${LORA_FOLDER_NAME}/functional/${folder}/${match}?v=${mtime}`)
          }
        }
        if (out.length === 0) {
          for (let i = 1; i <= 10; i++) {
            const imageFileName = `${i}.png`
            if (allFiles.includes(imageFileName)) {
              const imagePath = path.join(folderPath, imageFileName)
              const mtime = fs.statSync(imagePath).mtimeMs.toString(36)
              out.push(`/${LORA_FOLDER_NAME}/functional/${folder}/${imageFileName}?v=${mtime}`)
            }
          }
        }
        return out
      }
      const findSafetensorByVersion = (versionName) => {
        const lower = (versionName || '').toLowerCase()
        return safetensorsFiles.find(f => {
          const m = f.match(/\(([^)]+)\)\.safetensors$/)
          return m && m[1].toLowerCase() === lower
        }) || null
      }

      const versions = []
      const usedSafetensors = new Set()
      if (Array.isArray(meta.model) && meta.model.length > 0) {
        meta.model.forEach(m => {
          if (!m || !m.name) return
          const versionName = m.name.toLowerCase()
          const file = findSafetensorByVersion(versionName)
          if (file) usedSafetensors.add(file)
          versions.push({
            name: versionName,
            displayName: `${m.name}${m.version ? ' ' + m.version : ''}`.trim(),
            fileName: file || '',
            filePath: file ? `/${LORA_FOLDER_NAME}/functional/${folder}/${file}` : '',
            images: collectImagesFor(versionName),
            prompt: typeof m.prompt === 'string' ? m.prompt : (meta.prompt || ''),
          })
        })
      }
      safetensorsFiles.forEach(file => {
        if (usedSafetensors.has(file)) return
        const match = file.match(/\(([^)]+)\)\.safetensors$/)
        const versionName = match ? match[1] : 'default'
        let displayName = versionName
        if (Object.keys(modelMap).length > 0) {
          displayName = modelMap[versionName.toLowerCase()] || versionName
        }
        versions.push({
          name: versionName,
          displayName,
          fileName: file,
          filePath: `/${LORA_FOLDER_NAME}/functional/${folder}/${file}`,
          images: collectImagesFor(versionName),
          prompt: meta.prompt || '',
        })
      })

      const defaultVersion = versions[0] || { name: '', displayName: '', fileName: '', filePath: '' }
      const thumbnailMtime = fs.existsSync(thumbnailPath) ? fs.statSync(thumbnailPath).mtimeMs.toString(36) : ''

      return {
        id: folder,
        name: folder,
        title: meta.title || folder,
        subTitle: meta['sub-title'] || '',
        thumbnail: fs.existsSync(thumbnailPath) ? `/${LORA_FOLDER_NAME}/functional/${folder}/0.png?v=${thumbnailMtime}` : '',
        link: meta.link || '',
        prompt: meta.prompt || '',
        safetensorsFile: defaultVersion.fileName,
        safetensorsPath: defaultVersion.filePath,
        versions: versions,
        hasMultipleVersions: versions.length > 1,
        type: meta.type || '',
        model: modelInfo,
        modelRaw: Array.isArray(meta.model) ? meta.model : [],
        serialNumber: meta['serial-number'] || 0,
        stability: meta.stability || null,
        sensitive: meta.sensitive || 'SFW',
        weight: meta.weight || null,
        copyCount: meta.copyCount || 0,
        downloadCount: meta.downloadCount || 0
      }
    })

    // Sort by serial number
    fnLoras.sort((a, b) => a.serialNumber - b.serialNumber)

    res.json(fnLoras)
  } catch (error) {
    console.error('Error reading Functional LoRAs:', error)
    res.status(500).json({ error: 'Failed to load Functional LoRAs' })
  }
})

// API route - increment Fn LoRA copy count
app.post('/api/fn-loras/:id/copy', counterLimiter, (req, res) => {
  try {
    const { id } = req.params
    const metaPath = path.join(LORA_FOLDER_PATH, 'functional', id, 'meta.json')

    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      meta.copyCount = (meta.copyCount || 0) + 1
      writeJsonAtomic(metaPath, meta)
      res.json({ success: true, copyCount: meta.copyCount })
    } else {
      res.status(404).json({ error: 'Meta file not found' })
    }
  } catch (error) {
    console.error('Error updating Fn LoRA copy count:', error)
    res.status(500).json({ error: 'Failed to update copy count' })
  }
})

// API route - increment Fn LoRA download count
app.post('/api/fn-loras/:id/download', counterLimiter, (req, res) => {
  try {
    const { id } = req.params
    const metaPath = path.join(LORA_FOLDER_PATH, 'functional', id, 'meta.json')

    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      meta.downloadCount = (meta.downloadCount || 0) + 1
      writeJsonAtomic(metaPath, meta)
      res.json({ success: true, downloadCount: meta.downloadCount })
    } else {
      res.status(404).json({ error: 'Meta file not found' })
    }
  } catch (error) {
    console.error('Error updating Fn LoRA download count:', error)
    res.status(500).json({ error: 'Failed to update download count' })
  }
})

// ============================================
// FN LORA CRUD API (Admin)
// ============================================

// Multer storage for Fn LoRA images
const fnLoraImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!isSafeSlug(req.params.id)) return cb(new Error('Invalid id'))
    const fnLoraPath = safeResolveUnder(LORA_FOLDER_PATH, 'functional', req.params.id)
    if (!fnLoraPath) return cb(new Error('Invalid path'))
    if (!fs.existsSync(fnLoraPath)) {
      fs.mkdirSync(fnLoraPath, { recursive: true })
    }
    cb(null, fnLoraPath)
  },
  filename: (req, file, cb) => {
    const imageIndex = req.params.imageIndex || '0'
    if (!/^\d{1,3}$/.test(String(imageIndex))) return cb(new Error('Invalid imageIndex'))
    const version = req.query.version || req.body.version || ''
    if (version && !isSafeSlug(version)) return cb(new Error('Invalid version'))
    if (imageIndex === '0') {
      cb(null, '0.png')
    } else if (version) {
      cb(null, `${imageIndex}(${version}).png`)
    } else {
      cb(null, `${imageIndex}.png`)
    }
  }
})

const fnLoraImageUpload = multer({
  storage: fnLoraImageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('Only image files are allowed'))
    }
  }
})

// Multer storage for Fn LoRA safetensors files
const fnLoraSafetensorsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!isSafeSlug(req.params.id)) return cb(new Error('Invalid id'))
    const fnLoraPath = safeResolveUnder(LORA_FOLDER_PATH, 'functional', req.params.id)
    if (!fnLoraPath) return cb(new Error('Invalid path'))
    if (!fs.existsSync(fnLoraPath)) {
      fs.mkdirSync(fnLoraPath, { recursive: true })
    }
    cb(null, fnLoraPath)
  },
  filename: (req, file, cb) => {
    // Sanitize: take basename only, strip any path separators or NULs.
    const safe = path.basename(file.originalname || '').replace(/[\x00-\x1f]/g, '')
    if (!safe || safe === '.' || safe === '..' || !safe.endsWith('.safetensors')) {
      return cb(new Error('Invalid filename'))
    }
    cb(null, safe)
  }
})

const fnLoraSafetensorsUpload = multer({
  storage: fnLoraSafetensorsStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit for LoRA files
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.safetensors')) {
      cb(null, true)
    } else {
      cb(new Error('Only .safetensors files are allowed'))
    }
  }
})

// Create new Fn LoRA
app.post('/api/fn-loras', authMiddleware, (req, res) => {
  try {
    const { title, subTitle, type, model, link, prompt, stability, sensitive, weight } = req.body
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' })
    }

    const folderName = title.replace(/\s+/g, '_')
    const fnLoraPath = path.join(LORA_FOLDER_PATH, 'functional', folderName)

    if (fs.existsSync(fnLoraPath)) {
      return res.status(400).json({ error: 'Fn LoRA with this name already exists' })
    }

    // Find the next available serial number
    const functionalFolderPath = path.join(LORA_FOLDER_PATH, 'functional')
    let maxSerialNumber = 0
    if (fs.existsSync(functionalFolderPath)) {
      const folders = fs.readdirSync(functionalFolderPath).filter(file => {
        const filePath = path.join(functionalFolderPath, file)
        return fs.statSync(filePath).isDirectory() && !file.startsWith('@')
      })
      folders.forEach(folder => {
        const metaPath = path.join(functionalFolderPath, folder, 'meta.json')
        if (fs.existsSync(metaPath)) {
          try {
            const existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            const sn = existingMeta['serial-number'] || 0
            if (sn > maxSerialNumber) maxSerialNumber = sn
          } catch (err) {}
        }
      })
    }
    const nextSerialNumber = maxSerialNumber + 1

    fs.mkdirSync(fnLoraPath, { recursive: true })

    const meta = {
      title: title,
      'sub-title': subTitle || '',
      type: type || '',
      model: model || [],
      link: link || '',
      prompt: prompt || '',
      stability: stability || 1,
      sensitive: sensitive || 'SFW',
      weight: weight !== undefined ? parseFloat(weight) : null,
      'serial-number': nextSerialNumber,
      downloadCount: 0,
      copyCount: 0
    }

    writeJsonAtomic(path.join(fnLoraPath, 'meta.json'), meta)

    sendDiscordNotification('new_fn_lora', { ...meta, id: folderName })
    res.json({ 
      success: true, 
      id: folderName,
      meta: meta
    })
  } catch (error) {
    console.error('Error creating Fn LoRA:', error)
    res.status(500).json({ error: 'Failed to create Fn LoRA' })
  }
})

// Update Fn LoRA metadata
app.put('/api/fn-loras/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params
    const fnLoraPath = path.join(LORA_FOLDER_PATH, 'functional', id)
    const metaPath = path.join(fnLoraPath, 'meta.json')

    if (!fs.existsSync(fnLoraPath)) {
      return res.status(404).json({ error: 'Fn LoRA not found' })
    }

    let meta = {}
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    }
    const oldMeta = JSON.parse(JSON.stringify(meta))

    const { title, subTitle, type, model, link, prompt, stability, sensitive, weight, editNote } = req.body
    if (title !== undefined) meta.title = title
    if (subTitle !== undefined) meta['sub-title'] = subTitle
    if (type !== undefined) meta.type = type
    if (model !== undefined) meta.model = model
    if (link !== undefined) meta.link = link
    if (prompt !== undefined) meta.prompt = prompt
    if (stability !== undefined) meta.stability = stability
    if (sensitive !== undefined) meta.sensitive = sensitive
    if (weight !== undefined) meta.weight = weight !== null ? parseFloat(weight) : null

    writeJsonAtomic(metaPath, meta)

    try {
      const fields = ['title', 'sub-title', 'type', 'model', 'link', 'prompt', 'stability', 'sensitive', 'weight']
      const changedFields = diffMeta(oldMeta, meta, fields)
      if (changedFields.length || (editNote && String(editNote).trim())) {
        const thumbPath = path.join(fnLoraPath, '0.png')
        let thumbnailUrl = ''
        if (PUBLIC_BASE_URL && fs.existsSync(thumbPath)) {
          const mtime = fs.statSync(thumbPath).mtimeMs
          thumbnailUrl = `${PUBLIC_BASE_URL}/${LORA_FOLDER_NAME}/functional/${id}/0.png?v=${mtime}`
        }
        sendDiscordNotification('edit_fn_lora', { ...meta, id, changedFields, editNote, thumbnailUrl })
      }
    } catch (notifyErr) {
      console.error('[discord] failed to dispatch edit_fn_lora:', notifyErr.message)
    }

    res.json({ success: true, meta })
  } catch (error) {
    console.error('Error updating Fn LoRA:', error)
    res.status(500).json({ error: 'Failed to update Fn LoRA' })
  }
})

// Delete Fn LoRA
app.delete('/api/fn-loras/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params
    const fnLoraPath = path.join(LORA_FOLDER_PATH, 'functional', id)

    if (!fs.existsSync(fnLoraPath)) {
      return res.status(404).json({ error: 'Fn LoRA not found' })
    }

    fs.rmSync(fnLoraPath, { recursive: true, force: true })

    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting Fn LoRA:', error)
    res.status(500).json({ error: 'Failed to delete Fn LoRA' })
  }
})

// Upload Fn LoRA image
app.post('/api/fn-loras/:id/image/:imageIndex', authMiddleware, fnLoraImageUpload.single('image'), async (req, res) => {
  try {
    const { id, imageIndex } = req.params
    const fnLoraPath = path.join(LORA_FOLDER_PATH, 'functional', id)

    if (!fs.existsSync(fnLoraPath)) {
      return res.status(404).json({ error: 'Fn LoRA not found' })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' })
    }

    if (imageIndex === '0') {
      const tempPath = req.file.path + '_temp'
      fs.renameSync(req.file.path, tempPath)
      
      await sharp(tempPath)
        .resize(256, 256, { fit: 'cover' })
        .png()
        .toFile(req.file.path)
      
      fs.unlinkSync(tempPath)
    }

    const mtime = fs.statSync(req.file.path).mtimeMs.toString(36)
    res.json({
      success: true,
      path: `/${LORA_FOLDER_NAME}/functional/${id}/${req.file.filename}?v=${mtime}`
    })
  } catch (error) {
    console.error('Error uploading Fn LoRA image:', error)
    res.status(500).json({ error: 'Failed to upload image' })
  }
})

// Upload Fn LoRA safetensors file
app.post('/api/fn-loras/:id/safetensors', authMiddleware, fnLoraSafetensorsUpload.single('file'), async (req, res) => {
  try {
    const { id } = req.params
    const version = req.body.version || 'default'
    const fnLoraPath = path.join(LORA_FOLDER_PATH, 'functional', id)

    if (!fs.existsSync(fnLoraPath)) {
      return res.status(404).json({ error: 'Fn LoRA not found' })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    res.json({
      success: true,
      filename: req.file.filename,
      path: `/${LORA_FOLDER_NAME}/functional/${id}/${req.file.filename}`,
      version: version
    })
  } catch (error) {
    console.error('Error uploading Fn LoRA safetensors:', error)
    res.status(500).json({ error: 'Failed to upload safetensors file' })
  }
})

// Delete Fn LoRA safetensors file
app.delete('/api/fn-loras/:id/safetensors/:version', authMiddleware, (req, res) => {
  try {
    const { id, version } = req.params
    if (!requireSlug('id', id, res)) return
    if (!requireSlug('version', version, res)) return

    const fnLoraPath = safeResolveUnder(LORA_FOLDER_PATH, 'functional', id)
    if (!fnLoraPath) return res.status(400).json({ error: 'Invalid path' })

    const filename = `${id}(${version}).safetensors`
    const filePath = safeResolveUnder(fnLoraPath, filename)
    if (!filePath) return res.status(400).json({ error: 'Invalid path' })

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      // Also delete corresponding version images
      const files = fs.readdirSync(fnLoraPath)
      files.forEach(file => {
        if (file.includes(`(${version}).png`) && file !== '0.png') {
          fs.unlinkSync(path.join(fnLoraPath, file))
        }
      })
      res.json({ success: true })
    } else {
      res.status(404).json({ error: 'File not found' })
    }
  } catch (error) {
    console.error('Error deleting Fn LoRA safetensors:', error)
    res.status(500).json({ error: 'Failed to delete safetensors file' })
  }
})

// ============================================
// LORA CRUD API (Admin)
// ============================================

// Multer storage for LoRA images
const loraImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!isSafeSlug(req.params.id)) return cb(new Error('Invalid id'))
    const loraPath = safeResolveUnder(LORA_FOLDER_PATH, 'character', req.params.id)
    if (!loraPath) return cb(new Error('Invalid path'))
    if (!fs.existsSync(loraPath)) {
      fs.mkdirSync(loraPath, { recursive: true })
    }
    cb(null, loraPath)
  },
  filename: (req, file, cb) => {
    const imageIndex = req.params.imageIndex || '0'
    if (!/^\d{1,3}$/.test(String(imageIndex))) return cb(new Error('Invalid imageIndex'))
    // For images 1 and 2, include version suffix if provided
    // Support both query param and body (query takes precedence, body requires correct FormData order)
    const version = req.query.version || req.body.version || ''
    if (version && !isSafeSlug(version)) return cb(new Error('Invalid version'))
    if (imageIndex === '0') {
      cb(null, '0.png')
    } else if (version) {
      cb(null, `${imageIndex}(${version}).png`)
    } else {
      cb(null, `${imageIndex}.png`)
    }
  }
})

const loraImageUpload = multer({
  storage: loraImageStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('Only image files are allowed'))
    }
  }
})

// Multer storage for Character LoRA safetensors files
const loraSafetensorsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!isSafeSlug(req.params.id)) return cb(new Error('Invalid id'))
    const loraPath = safeResolveUnder(LORA_FOLDER_PATH, 'character', req.params.id)
    if (!loraPath) return cb(new Error('Invalid path'))
    if (!fs.existsSync(loraPath)) {
      fs.mkdirSync(loraPath, { recursive: true })
    }
    cb(null, loraPath)
  },
  filename: (req, file, cb) => {
    const safe = path.basename(file.originalname || '').replace(/[\x00-\x1f]/g, '')
    if (!safe || safe === '.' || safe === '..' || !safe.endsWith('.safetensors')) {
      return cb(new Error('Invalid filename'))
    }
    cb(null, safe)
  }
})

const loraSafetensorsUpload = multer({
  storage: loraSafetensorsStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit for LoRA files
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.safetensors')) {
      cb(null, true)
    } else {
      cb(new Error('Only .safetensors files are allowed'))
    }
  }
})

// Create new LoRA
app.post('/api/loras', authMiddleware, (req, res) => {
  try {
    const { character, cloth, company, group, gender, characterCount, model, link, prompt, linkedRequestId } = req.body
    
    if (!character) {
      return res.status(400).json({ error: 'Character name is required' })
    }

    // Generate folder name: character-cloth or just character
    const folderName = cloth ? `${character.replace(/\s+/g, '_')}-${cloth}` : character.replace(/\s+/g, '_')
    const loraPath = path.join(LORA_FOLDER_PATH, 'character', folderName)

    if (fs.existsSync(loraPath)) {
      return res.status(400).json({ error: 'LoRA with this name already exists' })
    }

    // If a linked request was provided, validate it exists and snapshot
    // submittedBy. The request itself isn't marked completed until the
    // thumbnail upload (where new_lora actually fires).
    let linkedSubmittedBy = null
    let validLinkedRequestId = ''
    if (linkedRequestId && typeof linkedRequestId === 'string' && isSafeSlug(linkedRequestId)) {
      const reqMetaPath = path.join(REQUEST_FOLDER_PATH, linkedRequestId, 'meta.json')
      if (fs.existsSync(reqMetaPath)) {
        try {
          const reqMeta = JSON.parse(fs.readFileSync(reqMetaPath, 'utf-8'))
          if (reqMeta && reqMeta.submittedBy && reqMeta.submittedBy.discordId) {
            linkedSubmittedBy = reqMeta.submittedBy
          }
          validLinkedRequestId = linkedRequestId
        } catch (_e) {
          // ignore — link silently dropped
        }
      }
    }

    // Find the next available serial number
    const characterFolderPath = path.join(LORA_FOLDER_PATH, 'character')
    let maxSerialNumber = 0
    if (fs.existsSync(characterFolderPath)) {
      const folders = fs.readdirSync(characterFolderPath).filter(file => {
        return fs.statSync(path.join(characterFolderPath, file)).isDirectory()
      })
      folders.forEach(folder => {
        const metaPath = path.join(characterFolderPath, folder, 'meta.json')
        if (fs.existsSync(metaPath)) {
          try {
            const existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            const sn = existingMeta['serial-number'] || 0
            if (sn > maxSerialNumber) maxSerialNumber = sn
          } catch (err) {
            // ignore parse errors
          }
        }
      })
    }
    const nextSerialNumber = maxSerialNumber + 1

    fs.mkdirSync(loraPath, { recursive: true })

    // Create meta.json
    const meta = {
      gender: gender || 'Girl',
      character: character,
      cloth: cloth || '',
      company: company || 'N/A',
      group: group || 'N/A',
      characterCount: characterCount || 1,
      model: model || [],
      link: link || '',
      prompt: prompt || '',
      'serial-number': nextSerialNumber,
      downloadCount: 0,
      copyCount: 0,
      ...(validLinkedRequestId ? { linkedRequestId: validLinkedRequestId } : {}),
      ...(linkedSubmittedBy ? { submittedBy: linkedSubmittedBy } : {}),
    }

    writeJsonAtomic(path.join(loraPath, 'meta.json'), meta)


    // Defer the Discord notification until the thumbnail (0.png) is
    // uploaded so the embed can include the preview image. Triggered
    // from POST /api/loras/:id/image/:imageIndex when imageIndex === '0'.
    res.json({ 
      success: true, 
      id: folderName,
      meta: meta
    })
  } catch (error) {
    console.error('Error creating LoRA:', error)
    res.status(500).json({ error: 'Failed to create LoRA' })
  }
})

// Update LoRA metadata
app.put('/api/loras/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params
    const loraPath = path.join(LORA_FOLDER_PATH, 'character', id)
    const metaPath = path.join(loraPath, 'meta.json')

    if (!fs.existsSync(loraPath)) {
      return res.status(404).json({ error: 'LoRA not found' })
    }

    let meta = {}
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    }
    const oldMeta = JSON.parse(JSON.stringify(meta))

    // Update allowed fields
    const { character, cloth, company, group, gender, characterCount, model, link, prompt, editNote } = req.body
    if (character !== undefined) meta.character = character
    if (cloth !== undefined) meta.cloth = cloth
    if (company !== undefined) meta.company = company
    if (group !== undefined) meta.group = group
    if (gender !== undefined) meta.gender = gender
    if (characterCount !== undefined) meta.characterCount = characterCount
    if (model !== undefined) meta.model = model
    if (link !== undefined) meta.link = link
    if (prompt !== undefined) meta.prompt = prompt

    writeJsonAtomic(metaPath, meta)

    // Fire edit notification (skip if pre-thumbnail: avoid double-ping with new_lora)
    try {
      if (meta.discordNotified) {
        const fields = ['character', 'cloth', 'company', 'group', 'gender', 'characterCount', 'model', 'link', 'prompt']
        const changedFields = diffMeta(oldMeta, meta, fields)
        if (changedFields.length || (editNote && String(editNote).trim())) {
          const thumbPath = path.join(loraPath, '0.png')
          let thumbnailUrl = ''
          if (PUBLIC_BASE_URL && fs.existsSync(thumbPath)) {
            const mtime = fs.statSync(thumbPath).mtimeMs
            thumbnailUrl = `${PUBLIC_BASE_URL}/${LORA_FOLDER_NAME}/character/${id}/0.png?v=${mtime}`
          }
          sendDiscordNotification('edit_lora', { ...meta, id, changedFields, editNote, thumbnailUrl })
        }
      }
    } catch (notifyErr) {
      console.error('[discord] failed to dispatch edit_lora:', notifyErr.message)
    }

    res.json({ success: true, meta })
  } catch (error) {
    console.error('Error updating LoRA:', error)
    res.status(500).json({ error: 'Failed to update LoRA' })
  }
})

// Delete LoRA
app.delete('/api/loras/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params
    const loraPath = path.join(LORA_FOLDER_PATH, 'character', id)

    if (!fs.existsSync(loraPath)) {
      return res.status(404).json({ error: 'LoRA not found' })
    }

    fs.rmSync(loraPath, { recursive: true, force: true })
    

    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting LoRA:', error)
    res.status(500).json({ error: 'Failed to delete LoRA' })
  }
})

// Upload LoRA image (0=thumbnail, 1=preview1, 2=preview2)
app.post('/api/loras/:id/image/:imageIndex', authMiddleware, loraImageUpload.single('image'), async (req, res) => {
  try {
    const { id, imageIndex } = req.params
    const loraPath = path.join(LORA_FOLDER_PATH, 'character', id)

    if (!fs.existsSync(loraPath)) {
      return res.status(404).json({ error: 'LoRA not found' })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' })
    }

    // If it's the thumbnail (0), resize to square
    if (imageIndex === '0') {
      const tempPath = req.file.path + '_temp'
      fs.renameSync(req.file.path, tempPath)
      
      await sharp(tempPath)
        .resize(256, 256, { fit: 'cover' })
        .png()
        .toFile(req.file.path)
      
      fs.unlinkSync(tempPath)

      // Fire the deferred new_lora Discord notification on FIRST thumbnail
      // upload only. Subsequent thumbnail edits don't re-notify.
      try {
        const metaPath = path.join(loraPath, 'meta.json')
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          if (!meta.discordNotified) {
            const mtime = Date.now()
            const thumbnailUrl = PUBLIC_BASE_URL
              ? `${PUBLIC_BASE_URL}/${LORA_FOLDER_NAME}/character/${id}/0.png?v=${mtime}`
              : ''

            // If this LoRA was created against a linked request, mark that
            // request completed BEFORE firing the webhook, so the embed
            // shows the up-to-date state and we can @mention the submitter.
            let mentionDiscordId = ''
            let mentionContent = ''
            if (meta.linkedRequestId) {
              try {
                const reqMetaPath = path.join(REQUEST_FOLDER_PATH, meta.linkedRequestId, 'meta.json')
                if (fs.existsSync(reqMetaPath)) {
                  const reqMeta = JSON.parse(fs.readFileSync(reqMetaPath, 'utf-8'))
                  if (reqMeta && reqMeta.status !== 'completed') {
                    reqMeta.status = 'completed'
                    reqMeta.updatedAt = new Date().toISOString()
                    writeJsonAtomic(reqMetaPath, reqMeta)
                  }
                  if (reqMeta && reqMeta.submittedBy && reqMeta.submittedBy.discordId) {
                    mentionDiscordId = String(reqMeta.submittedBy.discordId)
                  }
                }
              } catch (linkErr) {
                console.error('[linked-request] failed to mark completed:', linkErr.message)
              }
            }
            // Fallback: use submittedBy snapshot stored on the LoRA itself
            // (set at LoRA create time even if the request file was later
            // moved or deleted).
            if (!mentionDiscordId && meta.submittedBy && meta.submittedBy.discordId) {
              mentionDiscordId = String(meta.submittedBy.discordId)
            }
            if (mentionDiscordId) {
              const outfit = meta.cloth ? ` ${meta.cloth}` : ''
              mentionContent = `<@${mentionDiscordId}> 你委託的 ${meta.character || ''}${outfit} LoRA 完成囉！`
            }

            sendDiscordNotification('new_lora', {
              ...meta,
              id,
              thumbnailUrl,
              ...(mentionContent ? { mentionContent, mentionDiscordId } : {}),
            })
            meta.discordNotified = true
            writeJsonAtomic(metaPath, meta)
          } else {
            // Subsequent thumbnail replacements — emit a quiet edit notification
            // (changedFields includes a synthetic 'thumbnail' marker so the
            // webhook hint isn't blank).
            const mtime = Date.now()
            const thumbnailUrl = PUBLIC_BASE_URL
              ? `${PUBLIC_BASE_URL}/${LORA_FOLDER_NAME}/character/${id}/0.png?v=${mtime}`
              : ''
            sendDiscordNotification('edit_lora', {
              ...meta,
              id,
              changedFields: ['thumbnail'],
              editNote: '',
              thumbnailUrl,
            })
          }
        }
      } catch (notifyErr) {
        console.error('[discord] failed to dispatch deferred new_lora:', notifyErr.message)
      }
    }


    res.json({ 
      success: true, 
      filename: req.file.filename,
      path: `/${LORA_FOLDER_NAME}/character/${id}/${req.file.filename}`
    })
  } catch (error) {
    console.error('Error uploading LoRA image:', error)
    res.status(500).json({ error: 'Failed to upload image: ' + error.message })
  }
})

// Upload Character LoRA safetensors file
app.post('/api/loras/:id/safetensors', authMiddleware, loraSafetensorsUpload.single('file'), async (req, res) => {
  try {
    const { id } = req.params
    const loraPath = path.join(LORA_FOLDER_PATH, 'character', id)

    if (!fs.existsSync(loraPath)) {
      return res.status(404).json({ error: 'LoRA not found' })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No safetensors file uploaded' })
    }

    console.log('Character LoRA safetensors uploaded:', req.file.originalname, 'to', loraPath)

    res.json({ 
      success: true, 
      filename: req.file.filename,
      path: `/${LORA_FOLDER_NAME}/character/${id}/${req.file.filename}`
    })
  } catch (error) {
    console.error('Error uploading Character LoRA safetensors:', error)
    res.status(500).json({ error: 'Failed to upload safetensors: ' + error.message })
  }
})

// Delete Character LoRA safetensors file
app.delete('/api/loras/:id/safetensors/:filename', authMiddleware, (req, res) => {
  try {
    const { id, filename } = req.params
    if (!requireSlug('id', id, res)) return
    if (!requireSlug('filename', filename, res)) return

    const filePath = safeResolveUnder(LORA_FOLDER_PATH, 'character', id, filename)
    if (!filePath) return res.status(400).json({ error: 'Invalid path' })

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' })
    }

    fs.unlinkSync(filePath)
    console.log('Character LoRA safetensors deleted:', filename)

    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting Character LoRA safetensors:', error)
    res.status(500).json({ error: 'Failed to delete safetensors: ' + error.message })
  }
})

// API route - get statistics
app.get('/api/statistics', requireWhitelist, (req, res) => {
  try {
    // Get sensitivity filter from query params (sfw, nsfw, all)
    const sensitivityFilter = req.query.sensitivity || 'all'

    const stats = {
      prompts: {
        total: 0,
        byCharacter: {},
        byPlace: {},
        byType: {},
        topCopied: [],
        bySensitivity: { SFW: 0, NSFW: 0 }
      },
      costumes: {
        total: 0,
        byType: {},
        byView: {},
        topCopied: [],
        bySensitivity: { SFW: 0, NSFW: 0 },
        totalCopies: 0
      },
      loras: {
        total: 0,
        byGender: {},
        byModel: {},
        topDownloaded: [],
        totalDownloads: 0
      }
    }

    // Collect prompt statistics
    const promptFolders = fs.readdirSync(PROMPT_FOLDER_PATH)
      .filter(item => fs.statSync(path.join(PROMPT_FOLDER_PATH, item)).isDirectory())

    promptFolders.forEach(folder => {
      const folderPath = path.join(PROMPT_FOLDER_PATH, folder)
      const metaPath = path.join(folderPath, 'meta.json')
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

        // Apply sensitivity filter
        const promptSensitive = meta.sensitive || 'SFW'
        if (sensitivityFilter === 'sfw' && promptSensitive !== 'SFW') return
        if (sensitivityFilter === 'nsfw' && promptSensitive !== 'NSFW') return
        // if sensitivityFilter === 'all', include everything
        stats.prompts.total++

        // By character count
        const charCount = meta.character || 1
        stats.prompts.byCharacter[charCount] = (stats.prompts.byCharacter[charCount] || 0) + 1

        // By place
        const place = meta.place || 'Unknown'
        stats.prompts.byPlace[place] = (stats.prompts.byPlace[place] || 0) + 1

        // By type
        const type = meta.type || 'Unknown'
        stats.prompts.byType[type] = (stats.prompts.byType[type] || 0) + 1

        // By sensitivity
        const sensitive = meta.sensitive || 'SFW'
        stats.prompts.bySensitivity[sensitive] = (stats.prompts.bySensitivity[sensitive] || 0) + 1

        // Top copied
        // Find first available image (prefer 1.png, fallback to 0.png or any image)
        const imageFiles = fs.readdirSync(folderPath)
          .filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
          .sort()
        const firstImage = imageFiles.length > 0 ? imageFiles[0] : null

        // Create unique display name using serial number and type
        const serialNumber = meta['serial-number'] !== undefined ? meta['serial-number'] : folder
        const displayName = `#${serialNumber} - ${meta.type || 'Unknown'}`
        stats.prompts.topCopied.push({
          id: folder,
          name: displayName,
          type: meta.type || 'Unknown',
          place: meta.place || 'Unknown',
          character: meta.character || 1,
          copyCount: meta.copyCount || 0,
          thumbnail: firstImage ? `/${PROMPT_FOLDER_NAME}/${folder}/${firstImage}` : ''
        })
      }
    })

    // Sort top copied prompts
    stats.prompts.topCopied.sort((a, b) => b.copyCount - a.copyCount)
    stats.prompts.topCopied = stats.prompts.topCopied.slice(0, 10)

    // Collect Costume statistics
    if (COSTUME_FOLDER_PATH) {
      const costumeFolders = fs.readdirSync(COSTUME_FOLDER_PATH)
        .filter(item => fs.statSync(path.join(COSTUME_FOLDER_PATH, item)).isDirectory())

      costumeFolders.forEach(folder => {
        const folderPath = path.join(COSTUME_FOLDER_PATH, folder)
        const metaPath = path.join(folderPath, 'meta.json')
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

          // Apply sensitivity filter
          const costumeSensitive = meta.sensitive || 'SFW'
          if (sensitivityFilter === 'sfw' && costumeSensitive !== 'SFW') return
          if (sensitivityFilter === 'nsfw' && costumeSensitive !== 'NSFW') return

          stats.costumes.total++

          // By type
          const type = meta.type || 'Unknown'
          stats.costumes.byType[type] = (stats.costumes.byType[type] || 0) + 1

          // By view
          const view = meta.view || 'Unknown'
          stats.costumes.byView[view] = (stats.costumes.byView[view] || 0) + 1

          // By sensitivity
          stats.costumes.bySensitivity[costumeSensitive] = (stats.costumes.bySensitivity[costumeSensitive] || 0) + 1

          // Track total copies
          const copyCount = meta.copyCount || 0
          stats.costumes.totalCopies += copyCount

          // Find first available image for thumbnail
          const imageFiles = fs.readdirSync(folderPath)
            .filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
            .sort()
          const firstImage = imageFiles.length > 0 ? imageFiles[0] : null

          // Create display name
          const serialNumber = meta['serial-number'] !== undefined ? meta['serial-number'] : folder
          const displayName = `#${serialNumber} - ${meta.type || 'Unknown'}`
          stats.costumes.topCopied.push({
            id: folder,
            name: displayName,
            type: meta.type || 'Unknown',
            view: meta.view || 'Unknown',
            copyCount: copyCount,
            thumbnail: firstImage ? `/${COSTUME_FOLDER_NAME}/${folder}/${firstImage}` : ''
          })
        }
      })

      // Sort top copied costumes
      stats.costumes.topCopied.sort((a, b) => b.copyCount - a.copyCount)
      stats.costumes.topCopied = stats.costumes.topCopied.slice(0, 10)
    }

    // Collect LoRA statistics
    const loraCharacterPath = path.join(LORA_FOLDER_PATH, 'character')
    const loraFolders = fs.readdirSync(loraCharacterPath)
      .filter(item => fs.statSync(path.join(loraCharacterPath, item)).isDirectory())

    loraFolders.forEach(folder => {
      const metaPath = path.join(loraCharacterPath, folder, 'meta.json')
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        stats.loras.total++

        // By gender
        const gender = meta.gender || 'Unknown'
        stats.loras.byGender[gender] = (stats.loras.byGender[gender] || 0) + 1

        // By model
        let modelInfo = 'Unknown'
        if (Array.isArray(meta.model)) {
          meta.model.forEach(m => {
            const modelName = m.name || 'Unknown'
            stats.loras.byModel[modelName] = (stats.loras.byModel[modelName] || 0) + 1
          })
        } else if (meta.model) {
          stats.loras.byModel[meta.model] = (stats.loras.byModel[meta.model] || 0) + 1
        }

        // Top downloaded
        const downloadCount = meta.downloadCount || 0
        stats.loras.totalDownloads += downloadCount
        const loraThumbnailPath = path.join(loraCharacterPath, folder, '0.png')

        // Generate display name: character-cloth (same logic as main LoRA list)
        const loraDisplayName = meta.cloth && meta.cloth.trim() !== ''
          ? `${meta.character}-${meta.cloth}`
          : meta.character

        stats.loras.topDownloaded.push({
          id: folder,
          name: loraDisplayName || folder,
          downloadCount: downloadCount,
          thumbnail: fs.existsSync(loraThumbnailPath) ? `/${LORA_FOLDER_NAME}/character/${folder}/0.png` : ''
        })
      }
    })

    // Sort top downloaded LoRAs
    stats.loras.topDownloaded.sort((a, b) => b.downloadCount - a.downloadCount)
    stats.loras.topDownloaded = stats.loras.topDownloaded.slice(0, 10)

    res.json(stats)
  } catch (error) {
    console.error('Error getting statistics:', error)
    res.status(500).json({ error: 'Failed to get statistics' })
  }
})

// API route - get configuration
app.get('/api/config', (req, res) => {
  res.json(config)
})

// ============================================
// ===============================================
// PROMPT ADMIN APIs
// ===============================================

// API route - create new prompt (admin only)
app.post('/api/prompts', authMiddleware, (req, res) => {
  try {
    const { title, prompt, negativePrompt, character, place, sensitive, type, view, nudity, stability, author, usedFnLoras } = req.body

    // Find next available ID (folder name)
    const existingFolders = fs.readdirSync(PROMPT_FOLDER_PATH)
      .filter(file => fs.statSync(path.join(PROMPT_FOLDER_PATH, file)).isDirectory())
      .map(f => parseInt(f))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b)

    const nextId = existingFolders.length > 0 ? Math.max(...existingFolders) + 1 : 0
    const newFolderPath = path.join(PROMPT_FOLDER_PATH, nextId.toString())

    // Create folder
    fs.mkdirSync(newFolderPath, { recursive: true })

    // Create prompt.txt
    writeTextAtomic(path.join(newFolderPath, 'prompt.txt'), prompt || '')

    // Create negative.txt if provided
    if (negativePrompt && negativePrompt.trim()) {
      fs.writeFileSync(path.join(newFolderPath, 'negative.txt'), negativePrompt, 'utf-8')
    }

    // Create meta.json
    const meta = {
      title: title || '',
      character: character || 1,
      place: place || 'Unknown',
      sensitive: sensitive || 'SFW',
      type: type || 'Unknown',
      view: view || 'Unknown',
      nudity: nudity || 'Unknown',
      stability: stability || 1,
      author: author || 'dANNY',
      copyCount: 0,
      usedFnLoras: usedFnLoras || []
    }
    writeJsonAtomic(path.join(newFolderPath, 'meta.json'), meta)


    // Create placeholder images (1.png will be required to upload)
    sendDiscordNotification('new_prompt', { ...meta, id: nextId.toString() })
    res.json({
      success: true,
      message: 'Prompt created successfully',
      id: nextId.toString()
    })
  } catch (error) {
    console.error('Error creating prompt:', error)
    res.status(500).json({ error: 'Failed to create prompt' })
  }
})

// API route - get unique field values for prompts
app.get('/api/prompts/fields', requireWhitelist, (req, res) => {
  try {
    const folders = fs.readdirSync(PROMPT_FOLDER_PATH).filter(file => {
      return fs.statSync(path.join(PROMPT_FOLDER_PATH, file)).isDirectory()
    })

    const fields = {
      place: new Set(),
      type: new Set(),
      view: new Set(),
      nudity: new Set()
    }

    folders.forEach(folder => {
      const metaPath = path.join(PROMPT_FOLDER_PATH, folder, 'meta.json')
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          if (meta.place && meta.place !== 'Unknown') fields.place.add(meta.place)
          if (meta.type && meta.type !== 'Unknown') fields.type.add(meta.type)
          if (meta.view && meta.view !== 'Unknown') fields.view.add(meta.view)
          if (meta.nudity && meta.nudity !== 'Unknown') fields.nudity.add(meta.nudity)
        } catch (e) {}
      }
    })

    res.json({
      place: Array.from(fields.place).sort(),
      type: Array.from(fields.type).sort(),
      view: Array.from(fields.view).sort(),
      nudity: Array.from(fields.nudity).sort()
    })
  } catch (error) {
    console.error('Error getting prompt fields:', error)
    res.status(500).json({ error: 'Failed to get fields' })
  }
})

// API route - update prompt (admin only)
app.put('/api/prompts/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params
    const { title, prompt, negativePrompt, character, place, sensitive, type, view, nudity, stability, author, usedFnLoras, editNote } = req.body
    const folderPath = path.join(PROMPT_FOLDER_PATH, id)
    const metaPath = path.join(folderPath, 'meta.json')
    const promptPath = path.join(folderPath, 'prompt.txt')
    const negativePath = path.join(folderPath, 'negative.txt')

    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: 'Prompt folder not found' })
    }

    // Snapshot old prompt / negative for diff
    let oldPrompt = ''
    let oldNegative = ''
    if (fs.existsSync(promptPath)) {
      try { oldPrompt = fs.readFileSync(promptPath, 'utf-8') } catch { /* ignore */ }
    }
    if (fs.existsSync(negativePath)) {
      try { oldNegative = fs.readFileSync(negativePath, 'utf-8') } catch { /* ignore */ }
    }

    // Update prompt.txt
    if (prompt !== undefined) {
      writeTextAtomic(promptPath, prompt)
    }

    // Update negative.txt
    if (negativePrompt !== undefined) {
      if (negativePrompt.trim()) {
        fs.writeFileSync(negativePath, negativePrompt, 'utf-8')
      } else if (fs.existsSync(negativePath)) {
        // Remove negative.txt if empty
        fs.unlinkSync(negativePath)
      }
    }

    // Update meta.json
    let meta = {}
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    }
    const oldMeta = JSON.parse(JSON.stringify(meta))

    // Update meta fields if provided
    if (title !== undefined) meta.title = title
    if (character !== undefined) meta.character = character
    if (place !== undefined) meta.place = place
    if (sensitive !== undefined) meta.sensitive = sensitive
    if (type !== undefined) meta.type = type
    if (view !== undefined) meta.view = view
    if (nudity !== undefined) meta.nudity = nudity
    if (stability !== undefined) meta.stability = stability
    if (author !== undefined) meta.author = author
    if (usedFnLoras !== undefined) meta.usedFnLoras = usedFnLoras

    writeJsonAtomic(metaPath, meta)

    try {
      const metaFields = ['title', 'character', 'place', 'sensitive', 'type', 'view', 'nudity', 'stability', 'author', 'usedFnLoras']
      const changedFields = diffMeta(oldMeta, meta, metaFields)
      if (prompt !== undefined && prompt !== oldPrompt) changedFields.push('prompt')
      if (negativePrompt !== undefined && (negativePrompt || '') !== oldNegative) changedFields.push('negativePrompt')
      if (changedFields.length || (editNote && String(editNote).trim())) {
        const thumbPath = path.join(folderPath, '0.webp')
        let thumbnailUrl = ''
        if (PUBLIC_BASE_URL && fs.existsSync(thumbPath)) {
          const mtime = fs.statSync(thumbPath).mtimeMs
          thumbnailUrl = `${PUBLIC_BASE_URL}/${PROMPT_FOLDER_NAME}/${id}/0.webp?v=${mtime}`
        }
        sendDiscordNotification('edit_prompt', { ...meta, id, changedFields, editNote, thumbnailUrl })
      }
    } catch (notifyErr) {
      console.error('[discord] failed to dispatch edit_prompt:', notifyErr.message)
    }

    res.json({ success: true, message: 'Prompt updated successfully' })
  } catch (error) {
    console.error('Error updating prompt:', error)
    res.status(500).json({ error: 'Failed to update prompt' })
  }
})

// Configure multer for prompt image uploads - use memory storage for WebP conversion
const promptUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF files are allowed'))
    }
  },
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB limit for source images
  }
})

// API route - upload prompt image (admin only) with WebP conversion
app.post('/api/prompts/:id/image/:imageIndex', authMiddleware, promptUpload.single('image'), async (req, res) => {
  console.log('Upload prompt image called:', { id: req.params.id, imageIndex: req.params.imageIndex, originalName: req.file?.originalname })
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' })
    }

    const { id, imageIndex } = req.params
    const folderPath = path.join(PROMPT_FOLDER_PATH, id)
    const idx = parseInt(imageIndex)

    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: 'Prompt folder not found' })
    }

    // Get existing images sorted
    const existingFiles = fs.readdirSync(folderPath)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort()
    
    // Delete existing file at this index if exists
    if (existingFiles[idx]) {
      const fileToDelete = path.join(folderPath, existingFiles[idx])
      console.log('Deleting existing prompt file:', fileToDelete)
      fs.unlinkSync(fileToDelete)
    }

    // Convert to WebP and save
    const newFilename = `${idx}.webp`
    const outputPath = path.join(folderPath, newFilename)
    
    await convertToWebP(req.file.buffer, outputPath, { quality: 85 })
    console.log('Converted and saved prompt image as WebP:', outputPath)

    // Get updated image list with cache busters
    const files = fs.readdirSync(folderPath)
    const imageFiles = files.filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file)).sort()
    const images = imageFiles.map(file => {
      const filePath = path.join(folderPath, file)
      const stats = fs.statSync(filePath)
      const mtime = stats.mtimeMs.toString(36)
      return `/${PROMPT_FOLDER_NAME}/${id}/${file}?v=${mtime}`
    })


    res.json({
      success: true,
      message: 'Image uploaded and converted to WebP successfully',
      filename: newFilename,
      images: images
    })
  } catch (error) {
    console.error('Error uploading prompt image:', error)
    res.status(500).json({ error: 'Failed to upload image: ' + error.message })
  }
})

// ===============================================
// GALLERY UPLOAD CONFIGURATION
// ===============================================

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { type, albumId } = req.params
    if (!GALLERY_TYPES.has(type)) return cb(new Error('Invalid gallery type'))
    if (!isSafeSlug(albumId)) return cb(new Error('Invalid albumId'))
    const uploadPath = safeResolveUnder(GALLERY_FOLDER_PATH, type, albumId)
    if (!uploadPath) return cb(new Error('Invalid path'))

    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true })
    }

    cb(null, uploadPath)
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp + random + original extension
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 8)
    const ext = path.extname(file.originalname)
    const uniqueFilename = `${timestamp}_${random}${ext}`
    cb(null, uniqueFilename)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit (increased for videos)
  fileFilter: (req, file, cb) => {
    // Accept images and videos
    const allowedImageTypes = /jpeg|jpg|png|gif|webp/
    const allowedVideoTypes = /mp4|mov|avi|webm|mkv|flv|wmv|m4v/
    const ext = path.extname(file.originalname).toLowerCase().substring(1)

    const isImage = allowedImageTypes.test(ext) && file.mimetype.startsWith('image/')
    const isVideo = allowedVideoTypes.test(ext) && file.mimetype.startsWith('video/')

    if (isImage || isVideo) {
      cb(null, true)
    } else {
      cb(new Error('Only image and video files are allowed'))
    }
  }
})

// API route - get all static galleries
app.get('/api/gallery/static', requireWhitelist, async (req, res) => {
  try {
    const staticPath = path.join(GALLERY_FOLDER_PATH, 'static')

    if (!fs.existsSync(staticPath)) {
      return res.json([])
    }

    const folders = fs.readdirSync(staticPath).filter(file => {
      return fs.statSync(path.join(staticPath, file)).isDirectory()
    })

    const albums = folders.map(folder => {
      const folderPath = path.join(staticPath, folder)
      const metaPath = path.join(folderPath, 'meta.json')

      // Default metadata
      let meta = {
        id: folder,
        title: folder,
        description: '',
        author: '',
        sensitive: 'SFW',
        category: '',
        tags: [],
        order: 0,
        viewCount: 0,
        images: []
      }

      // Read meta.json
      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData }
        } catch (error) {
          console.error(`Error parsing meta.json for ${folder}:`, error)
        }
      }

      // Convert image filenames to full URLs
      const images = meta.images.map(filename =>
        `/${GALLERY_FOLDER_NAME}/static/${folder}/${filename}`
      )

      // Determine cover image
      const coverPath = path.join(folderPath, 'cover.jpg')
      const cover = fs.existsSync(coverPath)
        ? `/${GALLERY_FOLDER_NAME}/static/${folder}/cover.jpg`
        : images[0] || ''

      return {
        ...meta,
        cover,
        images,
        imageCount: images.length
      }
    })

    // Sort by order field
    albums.sort((a, b) => (a.order || 0) - (b.order || 0))

    res.json(albums)
  } catch (error) {
    console.error('Error reading static galleries:', error)
    res.status(500).json({ error: 'Failed to load galleries' })
  }
})

// API route - get all video galleries
app.get('/api/gallery/video', requireWhitelist, async (req, res) => {
  try {
    const videoPath = path.join(GALLERY_FOLDER_PATH, 'video')

    if (!fs.existsSync(videoPath)) {
      return res.json([])
    }

    const folders = fs.readdirSync(videoPath).filter(file => {
      return fs.statSync(path.join(videoPath, file)).isDirectory()
    })

    const albums = folders.map(folder => {
      const folderPath = path.join(videoPath, folder)
      const metaPath = path.join(folderPath, 'meta.json')

      let meta = {
        id: folder,
        title: folder,
        description: '',
        author: '',
        sensitive: 'SFW',
        category: '',
        tags: [],
        order: 0,
        viewCount: 0,
        images: []
      }

      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData }
        } catch (error) {
          console.error(`Error parsing meta.json for ${folder}:`, error)
        }
      }

      const images = meta.images.map(filename =>
        `/${GALLERY_FOLDER_NAME}/video/${folder}/${filename}`
      )

      const coverPath = path.join(folderPath, 'cover.jpg')
      const cover = fs.existsSync(coverPath)
        ? `/${GALLERY_FOLDER_NAME}/video/${folder}/cover.jpg`
        : images[0] || ''

      return {
        ...meta,
        cover,
        images,
        imageCount: images.length
      }
    })

    albums.sort((a, b) => (a.order || 0) - (b.order || 0))

    res.json(albums)
  } catch (error) {
    console.error('Error reading video galleries:', error)
    res.status(500).json({ error: 'Failed to load galleries' })
  }
})

// API route - get all story galleries (list view)
app.get('/api/gallery/story', requireWhitelist, async (req, res) => {
  try {
    const storyPath = path.join(GALLERY_FOLDER_PATH, 'story')

    if (!fs.existsSync(storyPath)) {
      return res.json([])
    }

    const folders = fs.readdirSync(storyPath).filter(file => {
      return fs.statSync(path.join(storyPath, file)).isDirectory()
    })

    const stories = folders.map(folder => {
      const folderPath = path.join(storyPath, folder)
      const metaPath = path.join(folderPath, 'meta.json')

      let meta = {
        id: folder,
        title: folder,
        description: '',
        author: '',
        sensitive: 'SFW',
        tags: [],
        order: 0,
        viewCount: 0,
        estimatedTime: '',
        pages: []
      }

      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData }
        } catch (error) {
          console.error(`Error parsing meta.json for ${folder}:`, error)
        }
      }

      const coverPath = path.join(folderPath, 'cover.jpg')
      const cover = fs.existsSync(coverPath)
        ? `/${GALLERY_FOLDER_NAME}/story/${folder}/cover.jpg`
        : ''

      // Return metadata only (no pages for list view)
      return {
        id: meta.id,
        title: meta.title,
        description: meta.description,
        author: meta.author,
        sensitive: meta.sensitive,
        tags: meta.tags,
        order: meta.order,
        viewCount: meta.viewCount,
        estimatedTime: meta.estimatedTime,
        cover,
        pageCount: meta.pages?.length || 0
      }
    })

    stories.sort((a, b) => (a.order || 0) - (b.order || 0))

    res.json(stories)
  } catch (error) {
    console.error('Error reading stories:', error)
    res.status(500).json({ error: 'Failed to load stories' })
  }
})

// API route - get specific story with pages
app.get('/api/gallery/story/:id', requireWhitelist, async (req, res) => {
  try {
    const { id } = req.params
    const storyPath = path.join(GALLERY_FOLDER_PATH, 'story', id)
    const metaPath = path.join(storyPath, 'meta.json')

    if (!fs.existsSync(storyPath)) {
      return res.status(404).json({ error: 'Story not found' })
    }

    let meta = { pages: [] }
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      } catch (error) {
        return res.status(500).json({ error: 'Invalid meta.json' })
      }
    }

    // Convert relative image paths to absolute URLs
    const pages = meta.pages.map(page => {
      const convertedPage = { ...page }

      // Convert simple image path
      if (convertedPage.image) {
        convertedPage.image = `/${GALLERY_FOLDER_NAME}/story/${id}/${convertedPage.image}`
      }

      // Convert background path (for VN-style)
      if (convertedPage.background) {
        convertedPage.background = `/${GALLERY_FOLDER_NAME}/story/${id}/${convertedPage.background}`
      }

      // Convert character image path
      if (convertedPage.character?.image) {
        convertedPage.character.image = `/${GALLERY_FOLDER_NAME}/story/${id}/${convertedPage.character.image}`
      }

      return convertedPage
    })

    res.json({
      ...meta,
      pages
    })
  } catch (error) {
    console.error('Error reading story:', error)
    res.status(500).json({ error: 'Failed to load story' })
  }
})

// API route - increment gallery view count
app.post('/api/gallery/:type/:id/view', async (req, res) => {
  try {
    const { type, id } = req.params
    const metaPath = path.join(GALLERY_FOLDER_PATH, type, id, 'meta.json')

    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      meta.viewCount = (meta.viewCount || 0) + 1
      writeJsonAtomic(metaPath, meta)
      res.json({ success: true, viewCount: meta.viewCount })
    } else {
      res.status(404).json({ error: 'Meta file not found' })
    }
  } catch (error) {
    console.error('Error updating view count:', error)
    res.status(500).json({ error: 'Failed to update view count' })
  }
})

// Admin API - Upload files (simplified - no conversion)
app.post('/api/gallery/admin/:type/:albumId/upload',
  validatePathParams(['albumId']),
  authMiddleware,
  upload.array('images', 50),
  async (req, res) => {
    try {
      const { type, albumId } = req.params
      const uploadedFiles = req.files.map(file => file.filename)


      // Return uploaded filenames immediately
      res.json({
        message: 'Files uploaded successfully',
        files: uploadedFiles
      })
    } catch (error) {
      console.error('❌ [Upload] Error processing files:', error)
      res.status(500).json({ error: 'Failed to process uploaded files' })
    }
  }
)

// Admin API - Create album
app.post('/api/gallery/admin/:type/create', validatePathParams(), authMiddleware, async (req, res) => {
  try {
    const { type } = req.params
    const { id, meta } = req.body

    const albumPath = path.join(GALLERY_FOLDER_PATH, type, id)
    const metaPath = path.join(albumPath, 'meta.json')

    // Check if album already exists (has meta.json)
    if (fs.existsSync(metaPath)) {
      return res.status(400).json({ error: 'Album already exists' })
    }

    // Create directory if it doesn't exist (might already exist from file uploads)
    if (!fs.existsSync(albumPath)) {
      fs.mkdirSync(albumPath, { recursive: true })
    }

    // Create meta.json
    writeJsonAtomic(metaPath, meta)


    res.json({ success: true, id })
  } catch (error) {
    console.error('Error creating album:', error)
    res.status(500).json({ error: 'Failed to create album' })
  }
})

// Admin API - Update album order (MUST come before /:type/:id to avoid route conflict)
app.put('/api/gallery/admin/:type/reorder-albums', validatePathParams(), authMiddleware, async (req, res) => {
  try {
    const { type } = req.params
    const { albums } = req.body

    console.log('🔄 [REORDER-ALBUMS] Received request:', { type, albumCount: albums?.length })

    if (!albums || !Array.isArray(albums)) {
      console.log('❌ [REORDER-ALBUMS] Invalid albums array')
      return res.status(400).json({ error: 'Albums array is required' })
    }

    const typePath = path.join(GALLERY_FOLDER_PATH, type)

    if (!fs.existsSync(typePath)) {
      console.log('❌ [REORDER-ALBUMS] Type folder not found:', typePath)
      return res.status(404).json({ error: 'Gallery type not found' })
    }

    // Update order for each album
    let updatedCount = 0
    const notFoundAlbums = []

    for (const albumUpdate of albums) {
      const albumPath = path.join(typePath, albumUpdate.id)
      const metaPath = path.join(albumPath, 'meta.json')

      console.log(`🔍 [REORDER-ALBUMS] Checking album:`, {
        id: albumUpdate.id,
        order: albumUpdate.order,
        albumPath,
        metaPath,
        exists: fs.existsSync(metaPath)
      })

      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        meta.order = albumUpdate.order
        writeJsonAtomic(metaPath, meta)
        updatedCount++
      } else {
        notFoundAlbums.push(albumUpdate.id)
      }
    }

    console.log(`✅ [REORDER-ALBUMS] Successfully updated ${updatedCount}/${albums.length} albums`)

    if (notFoundAlbums.length > 0) {
      console.log(`⚠️ [REORDER-ALBUMS] Albums not found:`, notFoundAlbums)
    }


    res.json({ success: true, updatedCount, notFoundAlbums })
  } catch (error) {
    console.error('❌ [REORDER-ALBUMS] Error reordering albums:', error)
    res.status(500).json({ error: 'Failed to reorder albums' })
  }
})

// Admin API - Update album metadata
app.put('/api/gallery/admin/:type/:id', validatePathParams(['id']), authMiddleware, async (req, res) => {
  try {
    const { type, id } = req.params
    const { meta } = req.body

    const metaPath = path.join(GALLERY_FOLDER_PATH, type, id, 'meta.json')

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Album not found' })
    }

    writeJsonAtomic(metaPath, meta)


    res.json({ success: true })
  } catch (error) {
    console.error('Error updating album:', error)
    res.status(500).json({ error: 'Failed to update album' })
  }
})

// Admin API - Delete album
app.delete('/api/gallery/admin/:type/:id', validatePathParams(['id']), authMiddleware, async (req, res) => {
  try {
    const { type, id } = req.params
    const albumPath = path.join(GALLERY_FOLDER_PATH, type, id)

    if (!fs.existsSync(albumPath)) {
      return res.status(404).json({ error: 'Album not found' })
    }

    // Delete directory and all contents
    fs.rmSync(albumPath, { recursive: true, force: true })


    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting album:', error)
    res.status(500).json({ error: 'Failed to delete album' })
  }
})

// Admin API - Delete single image from album
app.delete('/api/gallery/admin/:type/:id/image', validatePathParams(['id']), authMiddleware, async (req, res) => {
  try {
    const { type, id } = req.params
    const { imagePath } = req.body

    if (!imagePath) {
      return res.status(400).json({ error: 'Image path is required' })
    }

    const albumPath = path.join(GALLERY_FOLDER_PATH, type, id)
    const metaPath = path.join(albumPath, 'meta.json')

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Album not found' })
    }

    // Read current meta
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    // Extract filename from path (e.g., "/gallery/static/album_id/image.jpg" -> "image.jpg")
    const filename = imagePath.split('/').pop()

    // Remove from images array
    if (!meta.images || !meta.images.includes(filename)) {
      return res.status(404).json({ error: 'Image not found in album' })
    }

    meta.images = meta.images.filter(img => img !== filename)

    // Delete the physical file
    const filePath = path.join(albumPath, filename)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    // Update meta.json
    writeJsonAtomic(metaPath, meta)


    res.json({ success: true, images: meta.images })
  } catch (error) {
    console.error('Error deleting image:', error)
    res.status(500).json({ error: 'Failed to delete image' })
  }
})

// Admin API - Update image order in album
app.put('/api/gallery/admin/:type/:id/reorder', validatePathParams(['id']), authMiddleware, async (req, res) => {
  try {
    const { type, id } = req.params
    const { images } = req.body

    console.log('🔄 [REORDER] Received request:', { type, id, images })

    if (!images || !Array.isArray(images)) {
      console.log('❌ [REORDER] Invalid images array')
      return res.status(400).json({ error: 'Images array is required' })
    }

    const albumPath = path.join(GALLERY_FOLDER_PATH, type, id)
    const metaPath = path.join(albumPath, 'meta.json')

    console.log('📁 [REORDER] Paths:', { albumPath, metaPath })

    if (!fs.existsSync(metaPath)) {
      console.log('❌ [REORDER] Album not found:', metaPath)
      return res.status(404).json({ error: 'Album not found' })
    }

    // Read current meta
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    console.log('📖 [REORDER] Current meta images:', meta.images)

    // Extract filenames from paths if needed
    const newImageOrder = images.map(img => {
      if (img.includes('/')) {
        return img.split('/').pop()
      }
      return img
    })

    console.log('🔄 [REORDER] New image order:', newImageOrder)

    // Update images order
    meta.images = newImageOrder

    // Update meta.json
    writeJsonAtomic(metaPath, meta)


    console.log('✅ [REORDER] Successfully saved new order')

    res.json({ success: true, images: meta.images })
  } catch (error) {
    console.error('❌ [REORDER] Error reordering images:', error)
    res.status(500).json({ error: 'Failed to reorder images' })
  }
})

// ============================================
// NOTIFICATIONS API
// ============================================

const NOTIFICATIONS_FILE = path.join(path.dirname(PROMPT_FOLDER_PATH), 'notifications.json')

// Get notifications
app.get('/api/notifications', requireWhitelist, (req, res) => {
  try {
    if (!fs.existsSync(NOTIFICATIONS_FILE)) {
      return res.json({ version: 0, updates: [] })
    }
    const data = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'))
    res.json(data)
  } catch (error) {
    console.error('❌ [NOTIFICATIONS] Error reading notifications:', error)
    res.status(500).json({ error: 'Failed to read notifications' })
  }
})

// Add notification (admin only)
app.post('/api/notifications', authMiddleware, (req, res) => {
  try {
    const { type, category, message } = req.body
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' })
    }
    
    let data = { version: 0, updates: [] }
    if (fs.existsSync(NOTIFICATIONS_FILE)) {
      data = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'))
    }
    
    // Increment version and add new notification
    data.version += 1
    const newNotification = {
      id: data.version,
      timestamp: new Date().toISOString(),
      type: type || 'update',
      category: category || 'lora',
      message
    }
    
    // Add to beginning of array (newest first)
    data.updates.unshift(newNotification)
    
    // Keep only last 50 notifications
    if (data.updates.length > 50) {
      data.updates = data.updates.slice(0, 50)
    }
    
    writeJsonAtomic(NOTIFICATIONS_FILE, data)
    
    console.log(`📢 [NOTIFICATIONS] Added: ${message}`)
    res.json({ success: true, notification: newNotification, version: data.version })
  } catch (error) {
    console.error('❌ [NOTIFICATIONS] Error adding notification:', error)
    res.status(500).json({ error: 'Failed to add notification' })
  }
})

// API route - get metadata with last modified timestamps
app.get('/api/metadata', requireWhitelist, (req, res) => {
  try {
    const metadata = {
      prompts: { lastModified: 0 },
      loras: { lastModified: 0 },
      gallery: {
        static: { lastModified: 0 },
        video: { lastModified: 0 },
        story: { lastModified: 0 }
      }
    }

    // Get prompts folder last modified time
    if (fs.existsSync(PROMPT_FOLDER_PATH)) {
      const stats = fs.statSync(PROMPT_FOLDER_PATH)
      metadata.prompts.lastModified = stats.mtimeMs

      // Also check all subdirectories for the most recent change
      const folders = fs.readdirSync(PROMPT_FOLDER_PATH)
        .filter(file => fs.statSync(path.join(PROMPT_FOLDER_PATH, file)).isDirectory())

      folders.forEach(folder => {
        const folderPath = path.join(PROMPT_FOLDER_PATH, folder)
        const folderStats = fs.statSync(folderPath)
        if (folderStats.mtimeMs > metadata.prompts.lastModified) {
          metadata.prompts.lastModified = folderStats.mtimeMs
        }
      })
    }

    // Get loras folder last modified time
    const loraCharacterPath = path.join(LORA_FOLDER_PATH, 'character')
    if (fs.existsSync(loraCharacterPath)) {
      const stats = fs.statSync(loraCharacterPath)
      metadata.loras.lastModified = stats.mtimeMs

      // Check all subdirectories
      const folders = fs.readdirSync(loraCharacterPath)
        .filter(file => fs.statSync(path.join(loraCharacterPath, file)).isDirectory())

      folders.forEach(folder => {
        const folderPath = path.join(loraCharacterPath, folder)
        const folderStats = fs.statSync(folderPath)
        if (folderStats.mtimeMs > metadata.loras.lastModified) {
          metadata.loras.lastModified = folderStats.mtimeMs
        }
      })
    }

    // Get gallery folders last modified times
    const galleryTypes = ['static', 'video', 'story']
    galleryTypes.forEach(type => {
      const typePath = path.join(GALLERY_FOLDER_PATH, type)
      if (fs.existsSync(typePath)) {
        const stats = fs.statSync(typePath)
        metadata.gallery[type].lastModified = stats.mtimeMs

        // Check all subdirectories
        const folders = fs.readdirSync(typePath)
          .filter(file => fs.statSync(path.join(typePath, file)).isDirectory())

        folders.forEach(folder => {
          const folderPath = path.join(typePath, folder)
          const folderStats = fs.statSync(folderPath)
          if (folderStats.mtimeMs > metadata.gallery[type].lastModified) {
            metadata.gallery[type].lastModified = folderStats.mtimeMs
          }

          // Also check meta.json file modification time inside each album folder
          const metaPath = path.join(folderPath, 'meta.json')
          if (fs.existsSync(metaPath)) {
            const metaStats = fs.statSync(metaPath)
            if (metaStats.mtimeMs > metadata.gallery[type].lastModified) {
              metadata.gallery[type].lastModified = metaStats.mtimeMs
            }
          }
        })
      }
    })

    res.json(metadata)
  } catch (error) {
    console.error('Error reading metadata:', error)
    res.status(500).json({ error: 'Failed to load metadata' })
  }
})

// ========================================
// REQUESTS API
// ========================================

// Ensure request directory exists
const ensureRequestDir = () => {
  if (!fs.existsSync(REQUEST_FOLDER_PATH)) {
    fs.mkdirSync(REQUEST_FOLDER_PATH, { recursive: true })
  }
}

// Get all requests
app.get('/api/requests', requireWhitelist, (req, res) => {
  try {
    ensureRequestDir()

    // submittedBy visibility — derived from cookie-auth (req.auth populated
    // by attachAuth middleware). The legacy Bearer-token `role: 'admin'`
    // check is gone: admin status now lives in authStore flags, not the JWT.
    const isAdmin = !!(req.auth && req.auth.isAdmin)
    const discordUserId = req.auth && req.auth.user ? req.auth.user.discordId : null

    const folders = fs.readdirSync(REQUEST_FOLDER_PATH).filter(file => {
      const fullPath = path.join(REQUEST_FOLDER_PATH, file)
      return fs.statSync(fullPath).isDirectory()
    })

    const requests = folders.map(folder => {
      const folderPath = path.join(REQUEST_FOLDER_PATH, folder)
      const metaPath = path.join(folderPath, 'meta.json')

      // Default metadata
      let meta = {
        id: folder,
        type: 'lora',
        status: 'pending',
        characterName: '',
        outfit: '',
        channelLink: '',
        socialMediaLink: '',
        createdAt: new Date().toISOString(),
        order: 999999
      }

      // Read meta.json
      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData, id: folder } // Ensure id matches folder name
        } catch (error) {
          console.error(`Error parsing meta.json for request ${folder}:`, error)
        }
      }

      // Handle submittedBy visibility
      if (meta.submittedBy) {
        if (isAdmin) {
          // Admin sees full submittedBy info
        } else if (discordUserId && meta.submittedBy.discordId === discordUserId) {
          // Discord user sees their own submittedBy info (to enable edit button)
        } else {
          // Others don't see submittedBy
          delete meta.submittedBy
        }
      }

      return meta
    })

    // Sort by order field (lowest first)
    requests.sort((a, b) => (a.order || 999999) - (b.order || 999999))

    res.json(requests)
  } catch (error) {
    console.error('Error reading requests:', error)
    res.status(500).json({ error: 'Failed to load requests' })
  }
})

// Create new request (requires Discord authentication)
app.post('/api/requests', submitLimiter, (req, res) => {
  try {
    // Verify Discord token if Discord OAuth is configured
    let submittedBy = null
    const authHeader = req.headers.authorization
    
    if (DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET) {
      // Discord OAuth is configured, require authentication
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Discord authentication required' })
      }

      const token = authHeader.split(' ')[1]
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        submittedBy = {
          discordId: decoded.discordId,
          username: decoded.username,
          globalName: decoded.globalName,
          avatar: decoded.avatar
        }
      } catch (error) {
        return res.status(401).json({ error: 'Invalid Discord token' })
      }
    }

    ensureRequestDir()

    const id = Date.now().toString()
    const requestPath = path.join(REQUEST_FOLDER_PATH, id)

    // Create request folder
    fs.mkdirSync(requestPath, { recursive: true })

    // Get highest order number from existing requests
    const folders = fs.readdirSync(REQUEST_FOLDER_PATH).filter(file => {
      const fullPath = path.join(REQUEST_FOLDER_PATH, file)
      return fs.statSync(fullPath).isDirectory()
    })

    let maxOrder = -1
    folders.forEach(folder => {
      const metaPath = path.join(REQUEST_FOLDER_PATH, folder, 'meta.json')
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          if (meta.order !== undefined && meta.order > maxOrder) {
            maxOrder = meta.order
          }
        } catch (error) {
          // Ignore parsing errors
        }
      }
    })

    // Allowlist of fields a submitter can set on creation. Anything else
    // (status, order, id, createdAt, submittedBy, etc.) is server-controlled.
    const REQUEST_CREATE_FIELDS = [
      'type', 'characterName', 'outfit',
      'livestreamArchive', 'channelLink', 'socialMediaLink',
      'fnLoraTitle', 'fnLoraSubTitle',
      'usedFnLoras',
      'note',
    ]
    const cleanBody = {}
    for (const k of REQUEST_CREATE_FIELDS) {
      if (req.body[k] !== undefined) cleanBody[k] = req.body[k]
    }

    const newRequest = {
      id,
      ...cleanBody,
      status: 'pending',
      createdAt: new Date().toISOString(),
      order: maxOrder + 1,
      submittedBy // Discord user info (null if OAuth not configured)
    }

    // Write meta.json
    const metaPath = path.join(requestPath, 'meta.json')
    writeJsonAtomic(metaPath, newRequest)


    // Send webhook notification for new request
    sendWebhookNotification('new_request', newRequest)
    sendDiscordNotification('new_request', newRequest)

    // Return request without submittedBy for non-admin response
    const publicRequest = { ...newRequest }
    delete publicRequest.submittedBy
    res.status(201).json(publicRequest)
  } catch (error) {
    console.error('Error creating request:', error)
    res.status(500).json({ error: 'Failed to create request' })
  }
})

// Reorder requests (admin only)
// IMPORTANT: must be registered BEFORE /api/requests/:id routes,
// otherwise Express matches "reorder" as the :id parameter and returns 404.
app.put('/api/requests/reorder', verifyToken, (req, res) => {
  try {
    const { orderedIds } = req.body

    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array' })
    }

    // Update order field in each request's meta.json
    orderedIds.forEach((id, index) => {
      const metaPath = path.join(REQUEST_FOLDER_PATH, id, 'meta.json')
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta.order = index
          writeJsonAtomic(metaPath, meta)
        } catch (error) {
          console.error(`Error updating order for request ${id}:`, error)
        }
      }
    })

    // Return updated requests
    const requests = orderedIds.map(id => {
      const metaPath = path.join(REQUEST_FOLDER_PATH, id, 'meta.json')
      if (fs.existsSync(metaPath)) {
        try {
          return JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        } catch (error) {
          return null
        }
      }
      return null
    }).filter(Boolean)

    res.json(requests)
  } catch (error) {
    console.error('Error reordering requests:', error)
    res.status(500).json({ error: 'Failed to reorder requests' })
  }
})

// Update request status (admin only)
app.put('/api/requests/:id/status', verifyToken, (req, res) => {
  try {
    const { id } = req.params
    const { status, rejectReason } = req.body
    const metaPath = path.join(REQUEST_FOLDER_PATH, id, 'meta.json')

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Request not found' })
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    meta.status = status
    meta.updatedAt = new Date().toISOString()

    // Handle reject reason
    if (status === 'rejected' && rejectReason !== undefined) {
      meta.rejectReason = rejectReason
    } else if (status !== 'rejected') {
      // Clear reject reason if status is no longer rejected
      delete meta.rejectReason
    }

    writeJsonAtomic(metaPath, meta)


    res.json(meta)
  } catch (error) {
    console.error('Error updating request status:', error)
    res.status(500).json({ error: 'Failed to update request status' })
  }
})

// Update request by owner (Discord user editing their own request)
app.put('/api/requests/:id/owner', (req, res) => {
  try {
    const { id } = req.params
    const metaPath = path.join(REQUEST_FOLDER_PATH, id, 'meta.json')

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Request not found' })
    }

    // Verify Discord token
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Discord authentication required' })
    }

    const token = authHeader.split(' ')[1]
    let discordUser
    try {
      discordUser = jwt.verify(token, process.env.JWT_SECRET)
    } catch (error) {
      return res.status(401).json({ error: 'Invalid Discord token' })
    }

    // Read existing request
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    // Verify ownership
    if (!meta.submittedBy || meta.submittedBy.discordId !== discordUser.discordId) {
      return res.status(403).json({ error: 'You can only edit your own requests' })
    }

    // Only allow editing pending requests
    if (meta.status !== 'pending') {
      return res.status(403).json({ error: 'Can only edit pending requests' })
    }

    // Update allowed fields only
    const { type, characterName, outfit, livestreamArchive, channelLink, socialMediaLink } = req.body

    if (type !== undefined) meta.type = type
    if (characterName !== undefined) meta.characterName = characterName
    if (outfit !== undefined) meta.outfit = outfit
    if (livestreamArchive !== undefined) meta.livestreamArchive = livestreamArchive
    if (channelLink !== undefined) meta.channelLink = channelLink
    if (socialMediaLink !== undefined) meta.socialMediaLink = socialMediaLink

    meta.updatedAt = new Date().toISOString()

    writeJsonAtomic(metaPath, meta)

    // Return request without full submittedBy for response
    const publicMeta = { ...meta }
    delete publicMeta.submittedBy

    res.json(publicMeta)
  } catch (error) {
    console.error('Error updating request by owner:', error)
    res.status(500).json({ error: 'Failed to update request' })
  }
})

// Update entire request (admin only)
app.put('/api/requests/:id', verifyToken, (req, res) => {
  try {
    const { id } = req.params
    if (!requireSlug('id', id, res)) return
    const metaPath = path.join(REQUEST_FOLDER_PATH, id, 'meta.json')

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Request not found' })
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    // Allowlist of fields an admin may overwrite. Identity, ordering, and
    // ownership fields are preserved server-side and cannot be replayed
    // through the request body.
    const REQUEST_ADMIN_FIELDS = [
      'type', 'characterName', 'outfit',
      'livestreamArchive', 'channelLink', 'socialMediaLink',
      'fnLoraTitle', 'fnLoraSubTitle',
      'usedFnLoras',
      'note',
      'status', 'rejectReason',
    ]
    const cleanBody = {}
    for (const k of REQUEST_ADMIN_FIELDS) {
      if (req.body[k] !== undefined) cleanBody[k] = req.body[k]
    }

    const updatedMeta = {
      ...meta,
      ...cleanBody,
      id, // Preserve original ID
      createdAt: meta.createdAt, // Preserve creation date
      order: meta.order, // Preserve order
      submittedBy: meta.submittedBy, // Preserve original submitter identity
      updatedAt: new Date().toISOString()
    }

    writeJsonAtomic(metaPath, updatedMeta)

    try {
      const changedFields = diffMeta(meta, updatedMeta, REQUEST_ADMIN_FIELDS)
      const editNote = req.body.editNote
      if (changedFields.length || (editNote && String(editNote).trim())) {
        sendDiscordNotification('edit_request', { ...updatedMeta, id, changedFields, editNote })
      }
    } catch (notifyErr) {
      console.error('[discord] failed to dispatch edit_request:', notifyErr.message)
    }

    res.json(updatedMeta)
  } catch (error) {
    console.error('Error updating request:', error)
    res.status(500).json({ error: 'Failed to update request' })
  }
})

// Delete request (admin only)
app.delete('/api/requests/:id', verifyToken, (req, res) => {
  try {
    const { id } = req.params
    const requestPath = path.join(REQUEST_FOLDER_PATH, id)

    if (!fs.existsSync(requestPath)) {
      return res.status(404).json({ error: 'Request not found' })
    }

    // Delete entire folder
    fs.rmSync(requestPath, { recursive: true, force: true })


    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting request:', error)
    res.status(500).json({ error: 'Failed to delete request' })
  }
})

// ============================================
// WORKFLOW API
// ============================================

// Ensure workflow directory exists
function ensureWorkflowDir() {
  if (!fs.existsSync(WORKFLOW_FOLDER_PATH)) {
    fs.mkdirSync(WORKFLOW_FOLDER_PATH, { recursive: true })
  }
}

// Multer storage for workflow files (preserve original filename)
const workflowStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!isSafeSlug(req.params.id)) return cb(new Error('Invalid id'))
    const workflowPath = safeResolveUnder(WORKFLOW_FOLDER_PATH, req.params.id, 'files')
    if (!workflowPath) return cb(new Error('Invalid path'))
    if (!fs.existsSync(workflowPath)) {
      fs.mkdirSync(workflowPath, { recursive: true })
    }
    cb(null, workflowPath)
  },
  filename: (req, file, cb) => {
    const safe = path.basename(file.originalname || '').replace(/[\x00-\x1f]/g, '')
    if (!safe || safe === '.' || safe === '..') return cb(new Error('Invalid filename'))
    cb(null, safe)
  }
})

// Allowed extensions for workflow attachments. Reject scripts and binaries.
const WORKFLOW_ALLOWED_EXT = new Set([
  '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.txt', '.md',
  '.safetensors', '.ckpt', '.pt', '.bin', '.yaml', '.yml',
])
const workflowUpload = multer({
  storage: workflowStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit for large model files
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase()
    if (!WORKFLOW_ALLOWED_EXT.has(ext)) {
      return cb(new Error(`File type ${ext || '(none)'} is not allowed for workflow uploads`))
    }
    cb(null, true)
  },
})

// Get all workflows
app.get('/api/workflows', requireWhitelist, (req, res) => {
  try {
    ensureWorkflowDir()

    const folders = fs.readdirSync(WORKFLOW_FOLDER_PATH).filter(file => {
      const fullPath = path.join(WORKFLOW_FOLDER_PATH, file)
      return fs.statSync(fullPath).isDirectory()
    })

    const workflows = folders.map(folder => {
      const folderPath = path.join(WORKFLOW_FOLDER_PATH, folder)
      const metaPath = path.join(folderPath, 'meta.json')

      let meta = {
        id: folder,
        name: 'Untitled Workflow',
        description: '',
        workflowFile: null,
        attachments: [],
        createdAt: new Date().toISOString(),
        order: 999999
      }

      if (fs.existsSync(metaPath)) {
        try {
          const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          meta = { ...meta, ...metaData, id: folder }
        } catch (error) {
          console.error(`Error parsing meta.json for workflow ${folder}:`, error)
        }
      }

      return meta
    })

    workflows.sort((a, b) => (a.order || 999999) - (b.order || 999999))
    res.json(workflows)
  } catch (error) {
    console.error('Error reading workflows:', error)
    res.status(500).json({ error: 'Failed to load workflows' })
  }
})

// Create new workflow
app.post('/api/workflows', authMiddleware, (req, res) => {
  try {
    ensureWorkflowDir()

    const id = Date.now().toString()
    const workflowPath = path.join(WORKFLOW_FOLDER_PATH, id)
    const filesPath = path.join(workflowPath, 'files')

    fs.mkdirSync(workflowPath, { recursive: true })
    fs.mkdirSync(filesPath, { recursive: true })

    const meta = {
      id,
      name: req.body.name || 'Untitled Workflow',
      description: req.body.description || '',
      workflowFile: null,
      attachments: [],
      createdAt: new Date().toISOString(),
      order: 0
    }

    writeJsonAtomic(path.join(workflowPath, 'meta.json'), meta)


    sendDiscordNotification('new_workflow', meta)
    res.json(meta)
  } catch (error) {
    console.error('Error creating workflow:', error)
    res.status(500).json({ error: 'Failed to create workflow' })
  }
})

// Admin-only: send a test Discord notification.  Returns 503 if the webhook
// URL is not configured, so the admin UI / curl can tell.
app.post('/api/admin/test-discord-webhook', authMiddleware, (req, res) => {
  if (!DISCORD_WEBHOOK_URL) {
    return res.status(503).json({ error: 'DISCORD_WEBHOOK_URL is not configured' })
  }
  sendDiscordNotification('test', { triggeredAt: new Date().toISOString() })
  res.json({ success: true, message: 'Test notification dispatched (fire-and-forget — check the channel).' })
})

// Update workflow metadata
app.put('/api/workflows/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params
    const workflowPath = path.join(WORKFLOW_FOLDER_PATH, id)
    const metaPath = path.join(workflowPath, 'meta.json')

    if (!fs.existsSync(workflowPath)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let meta = { id }
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    }
    const oldMeta = JSON.parse(JSON.stringify(meta))

    // Update allowed fields
    if (req.body.name !== undefined) meta.name = req.body.name
    if (req.body.description !== undefined) meta.description = req.body.description
    if (req.body.workflowFile !== undefined) meta.workflowFile = req.body.workflowFile
    if (req.body.attachments !== undefined) meta.attachments = req.body.attachments

    writeJsonAtomic(metaPath, meta)

    try {
      const fields = ['name', 'description', 'workflowFile', 'attachments']
      const changedFields = diffMeta(oldMeta, meta, fields)
      const editNote = req.body.editNote
      if (changedFields.length || (editNote && String(editNote).trim())) {
        sendDiscordNotification('edit_workflow', { ...meta, id, changedFields, editNote })
      }
    } catch (notifyErr) {
      console.error('[discord] failed to dispatch edit_workflow:', notifyErr.message)
    }

    res.json(meta)
  } catch (error) {
    console.error('Error updating workflow:', error)
    res.status(500).json({ error: 'Failed to update workflow' })
  }
})

// Delete workflow
app.delete('/api/workflows/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params
    const workflowPath = path.join(WORKFLOW_FOLDER_PATH, id)

    if (!fs.existsSync(workflowPath)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    fs.rmSync(workflowPath, { recursive: true, force: true })


    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting workflow:', error)
    res.status(500).json({ error: 'Failed to delete workflow' })
  }
})

// Reorder workflows
app.put('/api/workflows/reorder', authMiddleware, (req, res) => {
  try {
    const { orderedIds } = req.body

    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array' })
    }

    const workflows = orderedIds.map((id, index) => {
      const workflowPath = path.join(WORKFLOW_FOLDER_PATH, id)
      const metaPath = path.join(workflowPath, 'meta.json')

      if (!fs.existsSync(workflowPath)) return null

      let meta = { id, order: index }
      if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        meta.order = index
      }

      writeJsonAtomic(metaPath, meta)
      return meta
    }).filter(Boolean)


    res.json(workflows)
  } catch (error) {
    console.error('Error reordering workflows:', error)
    res.status(500).json({ error: 'Failed to reorder workflows' })
  }
})

// Upload file to workflow
app.post('/api/workflows/:id/upload', authMiddleware, workflowUpload.single('file'), (req, res) => {
  try {
    const { id } = req.params
    const { fileType } = req.body // 'workflow' or 'attachment'
    const workflowPath = path.join(WORKFLOW_FOLDER_PATH, id)
    const metaPath = path.join(workflowPath, 'meta.json')

    if (!fs.existsSync(workflowPath)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    let meta = { id, workflowFile: null, attachments: [] }
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    }

    const filename = req.file.originalname

    if (fileType === 'workflow') {
      // If there was a previous workflow file, optionally delete it
      if (meta.workflowFile && meta.workflowFile !== filename) {
        const oldPath = path.join(workflowPath, 'files', meta.workflowFile)
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath)
        }
      }
      meta.workflowFile = filename
    } else {
      // Add to attachments if not already there
      if (!meta.attachments) meta.attachments = []
      if (!meta.attachments.includes(filename)) {
        meta.attachments.push(filename)
      }
    }

    writeJsonAtomic(metaPath, meta)


    res.json({ success: true, filename, meta })
  } catch (error) {
    console.error('Error uploading file:', error)
    res.status(500).json({ error: 'Failed to upload file' })
  }
})

// Delete file from workflow
app.delete('/api/workflows/:id/file/:filename', authMiddleware, (req, res) => {
  try {
    const { id, filename } = req.params
    if (!requireSlug('id', id, res)) return
    if (!requireFilename('filename', filename, res)) return
    const workflowPath = safeResolveUnder(WORKFLOW_FOLDER_PATH, id)
    if (!workflowPath) return res.status(400).json({ error: 'Invalid path' })
    const metaPath = safeResolveUnder(workflowPath, 'meta.json')
    const filePath = safeResolveUnder(workflowPath, 'files', filename)
    if (!metaPath || !filePath) return res.status(400).json({ error: 'Invalid path' })

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' })
    }

    fs.unlinkSync(filePath)

    // Update meta
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      if (meta.workflowFile === filename) {
        meta.workflowFile = null
      }
      if (meta.attachments) {
        meta.attachments = meta.attachments.filter(f => f !== filename)
      }
      writeJsonAtomic(metaPath, meta)
    }


    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting file:', error)
    res.status(500).json({ error: 'Failed to delete file' })
  }
})

// Download file from workflow
app.get('/api/workflows/:id/download/:filename', requireWhitelist, (req, res) => {
  try {
    const { id, filename } = req.params
    if (!requireSlug('id', id, res)) return
    if (!requireFilename('filename', filename, res)) return

    const filePath = safeResolveUnder(WORKFLOW_FOLDER_PATH, id, 'files', filename)
    if (!filePath) {
      return res.status(400).json({ error: 'Invalid path' })
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' })
    }

    // Set Content-Disposition to force download with original filename
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    res.sendFile(filePath)
  } catch (error) {
    console.error('Error downloading file:', error)
    res.status(500).json({ error: 'Failed to download file' })
  }
})

// =====================
// Discord OAuth2 Routes
// =====================

// Generate Discord OAuth2 authorization URL
app.get('/api/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(500).json({ error: 'Discord OAuth not configured' })
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  })

  const authUrl = `https://discord.com/api/oauth2/authorize?${params.toString()}`
  res.json({ authUrl })
})

// Discord OAuth2 callback
app.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query

  if (!code) {
    return res.redirect('/?error=no_code')
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    })

    if (!tokenResponse.ok) {
      console.error('Discord token error:', await tokenResponse.text())
      return res.redirect('/?error=token_failed')
    }

    const tokenData = await tokenResponse.json()

    // Get user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    })

    if (!userResponse.ok) {
      console.error('Discord user info error:', await userResponse.text())
      return res.redirect('/?error=user_info_failed')
    }

    const userData = await userResponse.json()

    // Persist profile (used by admin UI to show friendly username/avatar)
    try {
      authStore.upsertProfile({
        discordId: userData.id,
        username: userData.username,
        globalName: userData.global_name || userData.username,
        avatar: userData.avatar,
      })
    } catch (err) {
      console.error('[auth] profile upsert failed:', err.message)
    }

    // Audit
    const flags = authStore.getAuthFlags(userData.id)
    authStore.audit('login', {
      discordId: userData.id,
      username: userData.username,
      isWhitelisted: flags.isWhitelisted,
      isAdmin: flags.isAdmin,
    })

    // Create a JWT token with Discord user info. Flags are NOT embedded —
    // attachAuth re-derives them from auth-store on every request so
    // promote/demote/revoke take effect within the cache TTL (60s).
    const discordToken = jwt.sign(
      {
        discordId: userData.id,
        username: userData.username,
        globalName: userData.global_name || userData.username,
        avatar: userData.avatar
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    )

    // Set httpOnly cookie so <img>/static asset requests authenticate
    // automatically (browsers can't attach Authorization headers to those).
    res.setHeader('Set-Cookie', buildSessionCookie(req, discordToken))

    // Redirect back to the app with the token
    res.redirect(`/?discord_token=${discordToken}`)
  } catch (error) {
    console.error('Discord OAuth error:', error)
    res.redirect('/?error=oauth_failed')
  }
})

// Verify Discord token and get user info + live auth flags.
// Frontend calls this on app boot (with stored token) to know what the
// user sees. Flags come from auth-store, not the JWT, so promote/revoke
// is effective immediately.
app.get('/api/auth/discord/me', (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'Invalid or missing token' })
  res.json({
    discordId: req.auth.user.discordId,
    username: req.auth.user.username,
    globalName: req.auth.user.globalName,
    avatar: req.auth.user.avatar,
    isWhitelisted: req.auth.isWhitelisted,
    isAdmin: req.auth.isAdmin,
    isSuperAdmin: req.auth.isSuperAdmin,
  })
})

// Alias matching the plan's naming, same payload as /api/auth/discord/me.
app.get('/api/auth/me', (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'Login required' })
  // Opportunistically (re-)issue the httpOnly cookie. Lets users who logged
  // in before the cookie was introduced pick one up on their next probe
  // without having to log out and back in.
  if (!req.headers.cookie || !req.headers.cookie.includes('gf_session=')) {
    const header = req.headers.authorization
    if (header && header.startsWith('Bearer ')) {
      res.setHeader('Set-Cookie', buildSessionCookie(req, header.slice(7)))
    }
  }
  res.json({
    discordId: req.auth.user.discordId,
    username: req.auth.user.username,
    globalName: req.auth.user.globalName,
    avatar: req.auth.user.avatar,
    isWhitelisted: req.auth.isWhitelisted,
    isAdmin: req.auth.isAdmin,
    isSuperAdmin: req.auth.isSuperAdmin,
  })
})

// Clear the httpOnly session cookie. The SPA also drops its localStorage
// token in parallel; this endpoint exists so static asset requests stop
// being authenticated after logout.
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', buildSessionCookie(req, null, { clear: true }))
  res.json({ ok: true })
})

// ============================================
// Whitelist self-request flow
// ============================================

// Submit (or re-submit after rejection) a request to be whitelisted.
// Body: { reason: string }
app.post('/api/auth/whitelist-request', requireLogin, requestAccessLimiter, (req, res) => {
  try {
    if (req.auth.isWhitelisted) {
      return res.status(400).json({ error: 'Already whitelisted', alreadyWhitelisted: true })
    }
    const reason = String(req.body?.reason || '').trim()
    // Make sure we have a profile on file for this user. With long-lived JWTs
    // (30d) it's possible the user's profile row got wiped (e.g. by an old
    // data-dir bug) while their JWT is still valid. Backfill from JWT claims
    // so the pending-request card shows a proper username instead of bare ID.
    try {
      authStore.upsertProfile({
        discordId: req.auth.user.discordId,
        username: req.auth.user.username,
        globalName: req.auth.user.globalName || req.auth.user.username,
        avatar: req.auth.user.avatar,
      })
    } catch (_e) { /* non-fatal */ }
    const newReq = authStore.createRequest({ discordId: req.auth.user.discordId, reason })
    authStore.audit('whitelist_request_submit', {
      discordId: req.auth.discordId, username: req.auth.user.username, requestId: newReq.id,
    })
    sendDiscordNotification('whitelist_request', {
      discordId: req.auth.discordId,
      username: req.auth.user.username,
      globalName: req.auth.user.globalName,
      avatar: req.auth.user.avatar,
      reason: newReq.reason,
      requestId: newReq.id,
    })
    res.status(201).json(newReq)
  } catch (err) {
    if (err.code === 'PENDING_EXISTS') {
      return res.status(409).json({ error: 'A pending request already exists', pendingExists: true })
    }
    if (err.code === 'ALREADY_WHITELISTED') {
      return res.status(400).json({ error: 'Already whitelisted', alreadyWhitelisted: true })
    }
    console.error('[auth] whitelist-request submit failed:', err)
    res.status(500).json({ error: 'Failed to submit access request' })
  }
})

// Get the caller's most recent request (any status). null if none.
app.get('/api/auth/whitelist-request/mine', requireLogin, (req, res) => {
  const all = authStore.listRequests()
  const mine = all
    .filter((r) => r.discordId === req.auth.discordId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  res.json(mine[0] || null)
})

// Cancel a still-pending request.
app.delete('/api/auth/whitelist-request/mine', requireLogin, (req, res) => {
  try {
    const pending = authStore.findPendingByUser(req.auth.discordId)
    if (!pending) return res.status(404).json({ error: 'No pending request' })
    authStore.cancelRequest({ requestId: pending.id, discordId: req.auth.discordId })
    authStore.audit('whitelist_request_cancel', { discordId: req.auth.discordId, requestId: pending.id })
    res.json({ success: true })
  } catch (err) {
    console.error('[auth] whitelist-request cancel failed:', err)
    res.status(500).json({ error: 'Cancel failed' })
  }
})

// ============================================
// Admin user management
// ============================================

// Combined user view: each entry is { discordId, profile, isAdmin,
// isSuperAdmin, isWhitelisted, addedVia? }. Sorted: super-admin first,
// then admins, then plain whitelist.
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const whitelist = authStore.loadWhitelist().discord
  const adminList = authStore.loadAdmins().discord
  const superId = authStore.getSuperAdminId()
  const ids = new Set([...whitelist, ...adminList])
  if (superId) ids.add(superId)
  const profiles = authStore.loadProfiles().discord
  const out = []
  for (const id of ids) {
    out.push({
      discordId: id,
      profile: profiles[id] || null,
      isSuperAdmin: id === superId,
      isAdmin: id === superId || adminList.includes(id),
      isWhitelisted: id === superId || adminList.includes(id) || whitelist.includes(id),
    })
  }
  out.sort((a, b) => {
    if (a.isSuperAdmin !== b.isSuperAdmin) return a.isSuperAdmin ? -1 : 1
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1
    return a.discordId.localeCompare(b.discordId)
  })
  res.json({ users: out })
})

// List pending requests (most recent first). Re-joins on-disk profile so a
// stale `profile:null` (from a request submitted before profile was on file)
// still shows a friendly username/avatar once the user logs in again or hits
// any authenticated endpoint (attachAuth backfills).
app.get('/api/admin/whitelist-requests', requireAdmin, (req, res) => {
  const all = authStore.listRequests()
  const status = req.query.status ? String(req.query.status) : null
  const filtered = status ? all.filter((r) => r.status === status) : all
  filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  const enriched = filtered.map((r) => ({
    ...r,
    profile: r.profile || authStore.getProfile(r.discordId) || null,
  }))
  res.json({ requests: enriched })
})

function reviewHandler(decision) {
  return (req, res) => {
    try {
      const { id } = req.params
      const note = String(req.body?.note || '').trim() || undefined
      const reviewed = authStore.reviewRequest({
        requestId: id,
        status: decision,
        reviewerId: req.auth.discordId,
        reviewNote: note,
      })
      authStore.audit(`whitelist_request_${decision}`, {
        requestId: id, target: reviewed.discordId, by: req.auth.discordId, note,
      })
      sendDiscordNotification(decision === 'approved' ? 'whitelist_approve' : 'whitelist_deny', {
        target: reviewed,
        reviewer: req.auth.user,
        note,
      })
      res.json(reviewed)
    } catch (err) {
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Request not found' })
      if (err.code === 'NOT_PENDING') return res.status(409).json({ error: err.message })
      console.error('[auth] review failed:', err)
      res.status(500).json({ error: 'Review failed' })
    }
  }
}
app.post('/api/admin/whitelist-requests/:id/approve', requireAdmin, reviewHandler('approved'))
app.post('/api/admin/whitelist-requests/:id/deny', requireAdmin, reviewHandler('denied'))

// Manually add to whitelist (bypass request flow).
app.post('/api/admin/whitelist', requireAdmin, (req, res) => {
  const discordId = String(req.body?.discordId || '').trim()
  if (!/^\d{17,20}$/.test(discordId)) {
    return res.status(400).json({ error: 'Invalid Discord ID' })
  }
  const added = authStore.addWhitelist(discordId)
  authStore.audit('whitelist_add_direct', { target: discordId, by: req.auth.discordId, alreadyPresent: !added })
  sendDiscordNotification('whitelist_add_direct', {
    target: { discordId, profile: authStore.getProfile(discordId) },
    reviewer: req.auth.user,
  })
  res.json({ success: true, added })
})

// Revoke whitelist. Also demotes from admin if applicable.
app.delete('/api/admin/whitelist/:discordId', requireAdmin, (req, res) => {
  const discordId = String(req.params.discordId).trim()
  if (authStore.isSuperAdmin(discordId)) {
    return res.status(403).json({ error: 'Cannot revoke super-admin' })
  }
  let demoted = false
  try { demoted = authStore.demoteAdmin(discordId) } catch { /* ignore */ }
  const removed = authStore.removeWhitelist(discordId)
  authStore.audit('whitelist_revoke', { target: discordId, by: req.auth.discordId, removed, demoted })
  sendDiscordNotification('whitelist_revoke', {
    target: { discordId, profile: authStore.getProfile(discordId) },
    reviewer: req.auth.user,
    demoted,
  })
  res.json({ success: true, removed, demoted })
})

// Promote a whitelisted user to admin (auto-adds to whitelist if missing).
app.post('/api/admin/admins', requireAdmin, (req, res) => {
  const discordId = String(req.body?.discordId || '').trim()
  if (!/^\d{17,20}$/.test(discordId)) {
    return res.status(400).json({ error: 'Invalid Discord ID' })
  }
  try {
    const promoted = authStore.promoteAdmin(discordId)
    authStore.audit('admin_promote', { target: discordId, by: req.auth.discordId, alreadyAdmin: !promoted })
    sendDiscordNotification('admin_promote', {
      target: { discordId, profile: authStore.getProfile(discordId) },
      reviewer: req.auth.user,
    })
    res.json({ success: true, promoted })
  } catch (err) {
    console.error('[auth] promote failed:', err)
    res.status(500).json({ error: 'Promote failed' })
  }
})

// Demote — refuses super-admin.
app.delete('/api/admin/admins/:discordId', requireAdmin, (req, res) => {
  const discordId = String(req.params.discordId).trim()
  try {
    const demoted = authStore.demoteAdmin(discordId)
    authStore.audit('admin_demote', { target: discordId, by: req.auth.discordId, demoted })
    sendDiscordNotification('admin_demote', {
      target: { discordId, profile: authStore.getProfile(discordId) },
      reviewer: req.auth.user,
    })
    res.json({ success: true, demoted })
  } catch (err) {
    if (err.message === 'Cannot demote the super-admin') {
      return res.status(403).json({ error: err.message })
    }
    console.error('[auth] demote failed:', err)
    res.status(500).json({ error: 'Demote failed' })
  }
})

// Check if Discord OAuth is configured
app.get('/api/auth/discord/status', (req, res) => {
  res.json({
    configured: !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET),
    required: true // Set to true to require Discord login for requests
  })
})

// Unmatched /api/* routes must return JSON 404, not the SPA HTML.
// This handler must run AFTER all real /api/* routes but BEFORE the
// catch-all SPA route below.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' })
})

// Serve index.html for all other routes in production (SPA support)
if (process.env.NODE_ENV === 'production') {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`)
})
