// MizuCanvas auto-sync — fire-and-forget POST when LoRAs are created/updated.
//
// 沿用既有的 fire-and-forget pattern（如 Discord webhook），不擋本地 response。
// 失敗時 log 並透過 sendDiscordNotification 告警（caller 注入）。
//
// 啟用條件：MIZUCANVAS_SYNC_ENABLED=true && MIZUCANVAS_API_URL && MIZUCANVAS_API_KEY 都有值。
// 缺任一就 silent no-op，本地行為完全不變。
//
// Architecture 對應：
//   meta.model[i].name 含 'Illustrious' → sdxl
//   meta.model[i].name 含 'Anima'        → qwen_image
//   其他                                  → 跳過該版本 + warn
//
// Glyphforge 端 LoRA 資料夾預期內容：
//   <loraId>(anima).safetensors        / <loraId>(illustrious).safetensors
//   0.png 主縮圖，1(<tag>).png 為每架構偏好縮圖
//
// label 一律送 LoRA 資料夾名（= loraId），跨同 LoRA 一致，配合 MizuCanvas 端
// 的 (owner, arch, label) upsert：同 label 再傳會替換實體檔。

import fs from 'fs'
import path from 'path'

const CHUNK_SIZE = 50 * 1024 * 1024 // 50MB，配合 MizuCanvas 提供的 hint，也避開 CF Tunnel 100MB

// In-memory per-LoRA sync status. Used by GET /api/loras/:id/mizu-sync-status
// so the frontend can decouple "Glyphforge upload done" from "MizuCanvas sync
// done" instead of both fates riding on the single safetensors POST promise.
//
// Status shape:
//   { state: 'running'|'done'|'failed'|'partial',
//     kind: 'full'|'thumbnail',
//     startedAt: epoch_ms,
//     finishedAt?: epoch_ms,
//     results?: [{arch, ok, error?}],
//   }
// Old entries are pruned after MIZU_STATUS_TTL_MS so the map never leaks.
const MIZU_STATUS_TTL_MS = 30 * 60 * 1000 // 30min
const syncStatus = new Map()

function pruneSyncStatus() {
  const cutoff = Date.now() - MIZU_STATUS_TTL_MS
  for (const [k, v] of syncStatus) {
    if (v.finishedAt && v.finishedAt < cutoff) syncStatus.delete(k)
  }
}

export function getSyncStatus(loraId) {
  pruneSyncStatus()
  return syncStatus.get(loraId) || null
}

export function markSyncStart(loraId, kind = 'full') {
  syncStatus.set(loraId, {
    state: 'running',
    kind,
    startedAt: Date.now(),
  })
}

export function markSyncDone(loraId, results) {
  const prev = syncStatus.get(loraId) || { kind: 'full', startedAt: Date.now() }
  const arr = Array.isArray(results) ? results : []
  const okCount = arr.filter((r) => r.ok).length
  const failCount = arr.filter((r) => !r.ok).length
  let state
  if (arr.length === 0) state = 'done' // nothing to do counts as success
  else if (failCount === 0) state = 'done'
  else if (okCount === 0) state = 'failed'
  else state = 'partial'
  syncStatus.set(loraId, {
    ...prev,
    state,
    finishedAt: Date.now(),
    results: arr.map((r) => ({ arch: r.arch, ok: !!r.ok, error: r.error })),
  })
}

export function isEnabled() {
  return (
    process.env.MIZUCANVAS_SYNC_ENABLED === 'true' &&
    !!process.env.MIZUCANVAS_API_URL &&
    !!process.env.MIZUCANVAS_API_KEY
  )
}

function baseUrl() {
  return (process.env.MIZUCANVAS_API_URL || '').replace(/\/+$/, '')
}

function headers(extra = {}) {
  return {
    'X-API-Key': process.env.MIZUCANVAS_API_KEY,
    ...extra,
  }
}

/** Map a Glyphforge model name → MizuCanvas architecture (or null if unknown). */
export function mapArchitecture(modelName) {
  if (!modelName) return null
  const n = String(modelName).trim().toLowerCase()
  if (n.includes('illustrious')) return 'sdxl'
  if (n.includes('anima')) return 'qwen_image'
  return null
}

/** Short filename tag: 'anima' for qwen_image, 'illustrious' for sdxl. */
export function archTag(arch) {
  return arch === 'qwen_image' ? 'anima' : 'illustrious'
}

/** Find safetensors file matching `*(<tag>).safetensors|.pt|.ckpt`. */
export function findSafetensors(loraDir, arch) {
  const tag = archTag(arch).toLowerCase()
  const exts = ['.safetensors', '.pt', '.ckpt']
  let entries
  try {
    entries = fs.readdirSync(loraDir)
  } catch {
    return null
  }
  const needle = `(${tag})`
  for (const f of entries) {
    if (f.startsWith('.') || f === '@eaDir') continue
    const fl = f.toLowerCase()
    if (!fl.includes(needle)) continue
    if (exts.some((e) => fl.endsWith(e))) {
      return path.join(loraDir, f)
    }
  }
  return null
}

/** Find thumbnail. Per-arch (`0(<tag>).png`) wins; otherwise fall back to the
 *  shared primary 0.png. We intentionally DO NOT fall back to `1(<tag>).png`
 *  — those are full-body preview shots, not square thumbnails, and using
 *  them as the LoRA card image looks awful on MizuCanvas (the image gets
 *  stretched/cropped weirdly). The primary 0.png is always square (sharp
 *  256x256), and is a safe fallback for any arch without its own thumb. */
export function findThumbnail(loraDir, arch) {
  const tag = archTag(arch)
  const candidates = [
    `0(${tag}).png`, `0(${tag}).jpg`,
    `0.png`, `0.jpg`,
  ]
  for (const c of candidates) {
    const p = path.join(loraDir, c)
    if (fs.existsSync(p)) return p
  }
  return null
}

/** Chunked upload one (architecture, file) → MizuCanvas. */
export async function uploadOneVersion({ label, arch, triggerWords, safetensorsPath, thumbnailPath }) {
  const url = baseUrl()
  const stat = fs.statSync(safetensorsPath)
  const totalSize = stat.size
  const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE))
  const filename = path.basename(safetensorsPath)

  // 1. init
  const initResp = await fetch(`${url}/api/service/loras/upload/init`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      filename,
      architecture: arch,
      label,
      trigger_words: triggerWords || '',
      total_size: totalSize,
      total_chunks: totalChunks,
    }),
  })
  if (!initResp.ok) {
    const txt = await initResp.text().catch(() => '')
    throw new Error(`init ${initResp.status}: ${txt.slice(0, 300)}`)
  }
  const { upload_id } = await initResp.json()

  // 2. chunks
  const fh = await fs.promises.open(safetensorsPath, 'r')
  try {
    for (let i = 0; i < totalChunks; i++) {
      const offset = i * CHUNK_SIZE
      const len = Math.min(CHUNK_SIZE, totalSize - offset)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, offset)

      const fd = new FormData()
      fd.append('upload_id', upload_id)
      fd.append('chunk_index', String(i))
      fd.append('file', new Blob([buf]), `chunk_${i}`)

      const cresp = await fetch(`${url}/api/service/loras/upload/chunk`, {
        method: 'POST',
        headers: headers(),
        body: fd,
      })
      if (!cresp.ok) {
        const txt = await cresp.text().catch(() => '')
        throw new Error(`chunk ${i} ${cresp.status}: ${txt.slice(0, 300)}`)
      }
    }
  } finally {
    await fh.close()
  }

  // 3. finish (with optional thumbnail)
  const finishFd = new FormData()
  finishFd.append('upload_id', upload_id)
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try {
      const thumbBuf = await fs.promises.readFile(thumbnailPath)
      const thumbName = path.basename(thumbnailPath)
      const ext = path.extname(thumbName).toLowerCase()
      const mime =
        ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/png'
      finishFd.append('thumbnail', new Blob([thumbBuf], { type: mime }), thumbName)
    } catch (e) {
      console.warn(`[mizu-sync] thumbnail read failed (${thumbnailPath}): ${e.message}`)
    }
  }

  const fresp = await fetch(`${url}/api/service/loras/upload/finish`, {
    method: 'POST',
    headers: headers(),
    body: finishFd,
  })
  if (!fresp.ok) {
    const txt = await fresp.text().catch(() => '')
    throw new Error(`finish ${fresp.status}: ${txt.slice(0, 300)}`)
  }
  return await fresp.json()
}

/**
 * Sync a Glyphforge character LoRA → MizuCanvas. One MizuCanvas row per
 * meta.model[] entry that maps to a known architecture.
 *
 * Fire-and-forget by default — callers `.catch()` or `void` the promise.
 *
 * @param {object} opts
 * @param {string} opts.loraId         folder name = MizuCanvas label
 * @param {string} opts.loraDir        absolute path to .../character/<loraId>
 * @param {object} opts.meta           parsed meta.json
 * @param {(eventType: string, data: object) => void} [opts.notifyDiscord]
 * @returns {Promise<Array<{arch, ok, error?, result?}>>}
 */
export async function syncCharacterLora({ loraId, loraDir, meta, notifyDiscord }) {
  if (!isEnabled()) return []
  if (!meta || !Array.isArray(meta.model) || meta.model.length === 0) return []

  markSyncStart(loraId, 'full')
  const seenArchs = new Set()
  const results = []
  for (const v of meta.model) {
    const arch = mapArchitecture(v && v.name)
    if (!arch) {
      console.warn(`[mizu-sync] ${loraId}: model "${v && v.name}" 不認識架構，跳過`)
      continue
    }
    if (seenArchs.has(arch)) continue // 同架構多版本只送一次（取第一個）
    seenArchs.add(arch)

    const safetensorsPath = findSafetensors(loraDir, arch)
    if (!safetensorsPath) {
      const msg = `safetensors 找不到（預期 *(${archTag(arch)}).safetensors）`
      console.warn(`[mizu-sync] ${loraId} [${arch}]: ${msg}`)
      results.push({ arch, ok: false, error: msg })
      continue
    }
    const thumbnailPath = findThumbnail(loraDir, arch)
    const triggerWords = (v && v.prompt) || meta.prompt || ''

    try {
      const result = await uploadOneVersion({
        label: loraId,
        arch,
        triggerWords,
        safetensorsPath,
        thumbnailPath,
      })
      console.log(
        `[mizu-sync] ${loraId} [${arch}] → MizuCanvas id=${result.id} upserted=${result.upserted} public=${result.is_public}`,
      )
      results.push({ arch, ok: true, result })
    } catch (e) {
      console.error(`[mizu-sync] ${loraId} [${arch}] 失敗：${e.message}`)
      results.push({ arch, ok: false, error: e.message })
    }
  }

  if (notifyDiscord) {
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      try {
        notifyDiscord('mizu_sync_failed', {
          loraId,
          label: meta.character || loraId,
          failures: failed.map((f) => `${f.arch}: ${f.error}`).join('\n'),
        })
      } catch (e) {
        console.error(`[mizu-sync] notify dispatch failed: ${e.message}`)
      }
    }
  }
  markSyncDone(loraId, results)
  return results
}

/** Push a thumbnail-only update to MizuCanvas for one (label, arch).
 *
 * Uses MizuCanvas service endpoint `PUT /api/service/loras/by-label/thumbnail`,
 * which replaces the LoRA row's WEBP without re-uploading the .safetensors
 * (which would be 200-400 MB per call). 404 from that endpoint means the
 * LoRA row doesn't exist on MizuCanvas yet for that arch — caller should
 * fall back to the full `uploadOneVersion` path or just skip silently.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} opts.arch          'sdxl' | 'qwen_image'
 * @param {string} opts.thumbnailPath absolute path
 * @returns {Promise<{ok: boolean, status?: number, body?: any, error?: string}>}
 */
export async function pushThumbnailOnly({ label, arch, thumbnailPath }) {
  const url = baseUrl()
  const buf = await fs.promises.readFile(thumbnailPath)
  const name = path.basename(thumbnailPath)
  const ext = path.extname(name).toLowerCase()
  const mime =
    ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : 'application/octet-stream'

  const fd = new FormData()
  fd.append('label', label)
  fd.append('architecture', arch)
  fd.append('thumbnail', new Blob([buf], { type: mime }), name)

  const resp = await fetch(`${url}/api/service/loras/by-label/thumbnail`, {
    method: 'PUT',
    headers: headers(),
    body: fd,
  })
  const text = await resp.text().catch(() => '')
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }

  if (!resp.ok) {
    return { ok: false, status: resp.status, error: typeof body === 'string' ? body.slice(0, 300) : (body?.detail || `HTTP ${resp.status}`) }
  }
  return { ok: true, status: resp.status, body }
}

/**
 * Sync a thumbnail change for a character LoRA → MizuCanvas. Triggered by
 * Glyphforge's /api/loras/:id/image/0 endpoint after a 0.png or per-arch
 * 0(<tag>).png has been written to disk.
 *
 * Behaviour:
 *   - If `version` is given (e.g. 'illustrious' / 'anima'), only that arch
 *     is pushed.
 *   - If `version` is empty (primary 0.png upload, no version field), every
 *     arch present in `meta.model[]` that does NOT have its own
 *     0(<tag>).png override gets the new primary pushed (those are the
 *     arches whose MizuCanvas thumbnail is sourced from 0.png via
 *     `findThumbnail`'s fallback chain).
 *
 * Fire-and-forget; results are logged + reported via Discord on failure.
 *
 * @param {object} opts
 * @param {string} opts.loraId      folder name = MizuCanvas label
 * @param {string} opts.loraDir     absolute path to .../character/<loraId>
 * @param {object} opts.meta        parsed meta.json (for model[] arches)
 * @param {string} [opts.version]   '' for primary, else lowercase arch tag
 * @param {(eventType: string, data: object) => void} [opts.notifyDiscord]
 * @returns {Promise<Array<{arch, ok, error?}>>}
 */
export async function syncCharacterLoraThumbnail({ loraId, loraDir, meta, version, notifyDiscord }) {
  if (!isEnabled()) return []
  if (!meta || !Array.isArray(meta.model) || meta.model.length === 0) return []

  markSyncStart(loraId, 'thumbnail')
  // Decide which (arch, thumbnailPath) tuples to push.
  const targets = []
  if (version) {
    // Single per-arch tile was just updated.
    const tag = String(version).toLowerCase()
    const arch = tag === 'anima' ? 'qwen_image' : tag === 'illustrious' ? 'sdxl' : null
    if (!arch) {
      console.warn(`[mizu-sync] ${loraId}: thumbnail version "${version}" 不認識架構，跳過`)
      return []
    }
    const thumbPath = findThumbnail(loraDir, arch)
    if (thumbPath) targets.push({ arch, thumbnailPath: thumbPath })
  } else {
    // Primary 0.png was updated. Push it to every arch that doesn't have
    // its own 0(<tag>).png override on disk (those arches' MizuCanvas
    // thumbnail comes from 0.png via the fallback chain).
    const seen = new Set()
    for (const v of meta.model) {
      const arch = mapArchitecture(v && v.name)
      if (!arch || seen.has(arch)) continue
      seen.add(arch)
      const tag = archTag(arch)
      const override = path.join(loraDir, `0(${tag}).png`)
      if (fs.existsSync(override)) continue // per-arch tile wins; don't clobber it with primary
      const primary = path.join(loraDir, '0.png')
      if (!fs.existsSync(primary)) continue
      targets.push({ arch, thumbnailPath: primary })
    }
  }

  if (targets.length === 0) {
    markSyncDone(loraId, [])
    return []
  }

  const results = []
  for (const t of targets) {
    try {
      const r = await pushThumbnailOnly({ label: loraId, arch: t.arch, thumbnailPath: t.thumbnailPath })
      if (r.ok) {
        console.log(`[mizu-sync] ${loraId} [${t.arch}] thumbnail → MizuCanvas id=${r.body?.id} (${path.basename(t.thumbnailPath)})`)
        results.push({ arch: t.arch, ok: true })
      } else if (r.status === 404) {
        console.log(`[mizu-sync] ${loraId} [${t.arch}] thumbnail skipped — LoRA row not on MizuCanvas yet (404)`)
        results.push({ arch: t.arch, ok: true, skipped: true })
      } else {
        console.error(`[mizu-sync] ${loraId} [${t.arch}] thumbnail failed: ${r.status} ${r.error}`)
        results.push({ arch: t.arch, ok: false, error: `${r.status}: ${r.error}` })
      }
    } catch (e) {
      console.error(`[mizu-sync] ${loraId} [${t.arch}] thumbnail exception: ${e.message}`)
      results.push({ arch: t.arch, ok: false, error: e.message })
    }
  }

  if (notifyDiscord) {
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      try {
        notifyDiscord('mizu_sync_failed', {
          loraId,
          label: meta.character || loraId,
          failures: failed.map((f) => `${f.arch} (thumbnail): ${f.error}`).join('\n'),
        })
      } catch (e) {
        console.error(`[mizu-sync] notify dispatch failed: ${e.message}`)
      }
    }
  }
  markSyncDone(loraId, results)
  return results
}
