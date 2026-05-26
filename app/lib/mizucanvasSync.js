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

/** Find thumbnail: prefer `1(<tag>).png`, fall back to `0.png`. */
export function findThumbnail(loraDir, arch) {
  const tag = archTag(arch)
  const candidates = [`1(${tag}).png`, `1(${tag}).jpg`, `0.png`, `0.jpg`]
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
  return results
}
