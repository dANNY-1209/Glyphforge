// Discord-style square thumbnail cropper backed by react-easy-crop.
// Opens with a source image (File or URL), lets the user pan / zoom inside a
// square viewport, and on confirm hands back a square PNG File via onConfirm.
//
// Designed for the LoRA edit modal's "0.png" tile: source defaults to the
// currently-shown "1.png" (pending File or existing URL), with an optional
// "選別張圖" file picker for ad-hoc replacement. Output is fixed at 512×512 PNG.

import { useCallback, useEffect, useRef, useState } from 'react'
import Cropper from 'react-easy-crop'

const OUTPUT_SIZE = 512

/** Load an HTMLImageElement from a File / Blob / URL. */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(e)
    img.src = src
  })
}

/** Render the cropped region to a square canvas and return a PNG File. */
async function cropToFile(srcUrl, areaPx, fileName) {
  const img = await loadImage(srcUrl)
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    img,
    areaPx.x, areaPx.y, areaPx.width, areaPx.height,
    0, 0, OUTPUT_SIZE, OUTPUT_SIZE
  )
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('canvas.toBlob returned null')
  return new File([blob], fileName, { type: 'image/png' })
}

export default function ThumbnailCropperModal({
  open,
  source,           // File | string URL | null
  onConfirm,        // (croppedFile: File) => void
  onClose,          // () => void
  title = 'Crop Thumbnail',
}) {
  const [srcUrl, setSrcUrl] = useState(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [areaPx, setAreaPx] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const objectUrlRef = useRef(null)
  const fileInputRef = useRef(null)

  // Resolve `source` → object URL (revoked on unmount/change).
  useEffect(() => {
    if (!open) return
    setErr(null)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setAreaPx(null)
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    if (!source) { setSrcUrl(null); return }
    if (typeof source === 'string') {
      setSrcUrl(source)
    } else {
      const u = URL.createObjectURL(source)
      objectUrlRef.current = u
      setSrcUrl(u)
    }
  }, [source, open])

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  const onCropComplete = useCallback((_, areaPixels) => {
    setAreaPx(areaPixels)
  }, [])

  const pickLocalFile = () => fileInputRef.current?.click()

  const onLocalFileChange = (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const u = URL.createObjectURL(f)
    objectUrlRef.current = u
    setSrcUrl(u)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
  }

  const handleConfirm = async () => {
    if (!srcUrl || !areaPx) return
    setBusy(true)
    setErr(null)
    try {
      const file = await cropToFile(srcUrl, areaPx, 'thumbnail.png')
      onConfirm?.(file)
    } catch (e) {
      console.error('[ThumbnailCropper] crop failed:', e)
      setErr(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="popup-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="popup-content thumb-cropper-modal" onClick={(e) => e.stopPropagation()}>
        <button className="close-button" onClick={onClose}>×</button>
        <h3 className="edit-modal-title">{title}</h3>

        <div className="thumb-cropper-stage">
          {srcUrl ? (
            <Cropper
              image={srcUrl}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              minZoom={1}
              maxZoom={5}
              restrictPosition={true}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
            />
          ) : (
            <div className="thumb-cropper-empty">
              <p>No source image.</p>
              <button className="btn" onClick={pickLocalFile}>📁 Pick a file</button>
            </div>
          )}
        </div>

        <div className="thumb-cropper-controls">
          <label className="thumb-cropper-zoom">
            <span>Zoom</span>
            <input
              type="range"
              min={1}
              max={5}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              disabled={!srcUrl}
            />
          </label>
          <button className="btn ghost" onClick={pickLocalFile} disabled={busy}>
            📁 Change source
          </button>
        </div>

        {err && <div className="thumb-cropper-error">⚠ {err}</div>}

        <div className="thumb-cropper-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={handleConfirm} disabled={!srcUrl || !areaPx || busy}>
            {busy ? 'Cropping…' : 'Apply crop'}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onLocalFileChange}
        />
      </div>
    </div>
  )
}
