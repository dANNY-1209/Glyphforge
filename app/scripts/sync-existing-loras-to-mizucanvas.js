#!/usr/bin/env node
/**
 * Backfill: 把現有所有 Glyphforge character LoRA 推到 MizuCanvas。
 *
 * 用法：
 *     # dry-run（預設）：只列出每個 LoRA 將送什麼，不真的送
 *     node scripts/sync-existing-loras-to-mizucanvas.js
 *
 *     # 真的送
 *     node scripts/sync-existing-loras-to-mizucanvas.js --execute
 *
 *     # 限定特定 LoRA（重複 --only 多次）
 *     node scripts/sync-existing-loras-to-mizucanvas.js --execute --only KSP-4th-Anniversary
 *
 * 需要 env：MIZUCANVAS_SYNC_ENABLED=true、MIZUCANVAS_API_URL、MIZUCANVAS_API_KEY。
 * 從 ../.env 自動載入（dotenv）。
 *
 * 序列執行（一次一個 LoRA、一個 arch），避免吃滿 NAS 上傳頻寬。
 * 完成後寫 CSV 結果到 scripts/sync-result-<timestamp>.csv。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

// 動態 import 拿到模組（dotenv 必須在 import 之前）
const mizuSync = await import('../lib/mizucanvasSync.js')

// 解析 CLI
const args = process.argv.slice(2)
const execute = args.includes('--execute')
const only = args.filter((a, i) => args[i - 1] === '--only')

// 找 LoRA 根目錄。優先 env，否則用 Glyphforge 預設路徑。
const loraRoot =
  process.env.LORA_FOLDER_PATH ||
  '/var/services/homes/dannyho/deployment_datas/Glyphforge/LoRA'
const charDir = path.join(loraRoot, 'character')

if (!fs.existsSync(charDir)) {
  console.error(`character LoRA 根目錄不存在：${charDir}`)
  console.error('請設 LORA_FOLDER_PATH env 或確認 mount 路徑。')
  process.exit(2)
}

if (!mizuSync.isEnabled() && execute) {
  console.error('MIZUCANVAS_SYNC_ENABLED / MIZUCANVAS_API_URL / MIZUCANVAS_API_KEY 必須都設定。')
  process.exit(2)
}

console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
console.log(`LoRA root: ${charDir}`)
if (only.length) console.log(`Only: ${only.join(', ')}`)
console.log('')

let allDirs = fs
  .readdirSync(charDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '@eaDir')
  .map((d) => d.name)
  .sort()

if (only.length) {
  allDirs = allDirs.filter((n) => only.includes(n))
}

console.log(`Total candidates: ${allDirs.length}`)
console.log('')

const csvRows = [['lora_id', 'arch', 'status', 'safetensors', 'thumbnail', 'mizu_id', 'error']]
let idx = 0
for (const loraId of allDirs) {
  idx++
  const loraDir = path.join(charDir, loraId)
  const metaPath = path.join(loraDir, 'meta.json')
  if (!fs.existsSync(metaPath)) {
    console.log(`[${idx}/${allDirs.length}] ${loraId}: SKIP (no meta.json)`)
    csvRows.push([loraId, '', 'skip-no-meta', '', '', '', ''])
    continue
  }
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
  } catch (e) {
    console.log(`[${idx}/${allDirs.length}] ${loraId}: SKIP (bad meta.json: ${e.message})`)
    csvRows.push([loraId, '', 'skip-bad-meta', '', '', '', e.message])
    continue
  }
  if (!Array.isArray(meta.model) || meta.model.length === 0) {
    console.log(`[${idx}/${allDirs.length}] ${loraId}: SKIP (no meta.model[])`)
    csvRows.push([loraId, '', 'skip-no-model', '', '', '', ''])
    continue
  }

  // 列每個 arch
  const seen = new Set()
  for (const v of meta.model) {
    const arch = mizuSync.mapArchitecture(v && v.name)
    if (!arch) {
      console.log(`[${idx}/${allDirs.length}] ${loraId}: SKIP arch unknown (${v && v.name})`)
      csvRows.push([loraId, v && v.name, 'skip-unknown-arch', '', '', '', ''])
      continue
    }
    if (seen.has(arch)) continue
    seen.add(arch)

    const safetensors = mizuSync.findSafetensors(loraDir, arch)
    const thumbnail = mizuSync.findThumbnail(loraDir, arch)
    if (!safetensors) {
      console.log(`[${idx}/${allDirs.length}] ${loraId} [${arch}]: SKIP (no safetensors)`)
      csvRows.push([loraId, arch, 'skip-no-safetensors', '', '', '', ''])
      continue
    }
    const sizeMb = (fs.statSync(safetensors).size / (1024 * 1024)).toFixed(1)

    if (!execute) {
      console.log(
        `[${idx}/${allDirs.length}] ${loraId} [${arch}]: WOULD send ${path.basename(safetensors)} (${sizeMb}MB)` +
          (thumbnail ? ` + thumb ${path.basename(thumbnail)}` : ' (no thumb)'),
      )
      csvRows.push([loraId, arch, 'dry-run', path.basename(safetensors), thumbnail ? path.basename(thumbnail) : '', '', ''])
      continue
    }

    // 實際送
    const triggerWords = (v && v.prompt) || meta.prompt || ''
    process.stdout.write(
      `[${idx}/${allDirs.length}] ${loraId} [${arch}] uploading ${path.basename(safetensors)} (${sizeMb}MB)... `,
    )
    try {
      const result = await mizuSync.uploadOneVersion({
        label: loraId,
        arch,
        triggerWords,
        safetensorsPath: safetensors,
        thumbnailPath: thumbnail,
      })
      console.log(`OK id=${result.id} upserted=${result.upserted}`)
      csvRows.push([
        loraId,
        arch,
        result.upserted ? 'upserted' : 'created',
        path.basename(safetensors),
        thumbnail ? path.basename(thumbnail) : '',
        String(result.id),
        '',
      ])
    } catch (e) {
      console.log(`FAIL: ${e.message}`)
      csvRows.push([loraId, arch, 'error', path.basename(safetensors), thumbnail ? path.basename(thumbnail) : '', '', e.message])
    }
  }
}

// 寫 CSV
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = path.join(__dirname, `sync-result-${execute ? 'exec' : 'dry'}-${ts}.csv`)
fs.writeFileSync(outPath, csvRows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'))
console.log('')
console.log(`Results CSV: ${outPath}`)

const summary = csvRows.slice(1).reduce((acc, r) => {
  acc[r[2]] = (acc[r[2]] || 0) + 1
  return acc
}, {})
console.log('Summary:', summary)
