import type { TranslationFrame, TranslationRect } from '../types/translation'

export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('已取消', 'AbortError')
}

export function normalizeRect(rect: TranslationRect): TranslationRect {
  const x = Math.max(0, Math.min(1, rect.x))
  const y = Math.max(0, Math.min(1, rect.y))
  return { x, y, width: Math.max(0, Math.min(1 - x, rect.width)), height: Math.max(0, Math.min(1 - y, rect.height)) }
}

// Pointer coordinates are measured in the rotated screen rectangle, then mapped
// back to the unrotated page. All stored boxes remain independent of zoom and DPR.
export function pagePoint(clientX: number, clientY: number, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, rotation: number) {
  const u = Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)))
  const v = Math.max(0, Math.min(1, (clientY - bounds.top) / Math.max(1, bounds.height)))
  if (rotation === 90) return { x: v, y: 1 - u }
  if (rotation === 180) return { x: 1 - u, y: 1 - v }
  if (rotation === 270) return { x: 1 - v, y: u }
  return { x: u, y: v }
}

export function encodeTranslationFrame(image: CanvasImageSource, width: number, height: number, region?: TranslationRect): TranslationFrame {
  const rect = normalizeRect(region || { x: 0, y: 0, width: 1, height: 1 })
  if (rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) throw new Error('所选区域没有可识别的图像。')
  const sourceWidth = width * rect.width, sourceHeight = height * rect.height
  const scale = Math.min(1, 2200 / Math.max(sourceWidth, sourceHeight), Math.sqrt(4_000_000 / (sourceWidth * sourceHeight)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法读取页面图像。')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, width * rect.x, height * rect.y, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
  const frame = { dataUrl: canvas.toDataURL('image/jpeg', 0.94), width: canvas.width, height: canvas.height }
  canvas.width = 0; canvas.height = 0
  return frame
}

export async function frameFromBlob(blob: Blob, signal: AbortSignal, region?: TranslationRect) {
  throwIfAborted(signal)
  const bitmap = await createImageBitmap(blob)
  try {
    throwIfAborted(signal)
    return encodeTranslationFrame(bitmap, bitmap.width, bitmap.height, region)
  } finally { bitmap.close() }
}

export async function hashTranslationImage(dataUrl: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
