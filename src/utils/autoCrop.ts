/** Detects a mostly solid scan border at thumbnail resolution and crops the original page on demand. */
export async function autoCropFileToUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const sampleScale = Math.min(1, 384 / Math.max(bitmap.width, bitmap.height))
    const sample = document.createElement('canvas')
    sample.width = Math.max(1, Math.round(bitmap.width * sampleScale))
    sample.height = Math.max(1, Math.round(bitmap.height * sampleScale))
    const context = sample.getContext('2d', { willReadFrequently: true })!
    context.drawImage(bitmap, 0, 0, sample.width, sample.height)
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data
    const corners = [[0, 0], [sample.width - 1, 0], [0, sample.height - 1], [sample.width - 1, sample.height - 1]]
    const border = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, [x, y]) => sum + pixels[(y * sample.width + x) * 4 + channel], 0) / corners.length))
    const different = (x: number, y: number) => {
      const at = (y * sample.width + x) * 4
      return Math.abs(pixels[at] - border[0]) + Math.abs(pixels[at + 1] - border[1]) + Math.abs(pixels[at + 2] - border[2]) > 54
    }
    const rowHasInk = (y: number) => {
      let hits = 0
      for (let x = 0; x < sample.width; x += 2) if (different(x, y)) hits++
      return hits >= Math.max(2, sample.width * 0.004)
    }
    const columnHasInk = (x: number) => {
      let hits = 0
      for (let y = 0; y < sample.height; y += 2) if (different(x, y)) hits++
      return hits >= Math.max(2, sample.height * 0.004)
    }
    let top = 0, bottom = sample.height - 1, left = 0, right = sample.width - 1
    while (top < bottom && !rowHasInk(top)) top++
    while (bottom > top && !rowHasInk(bottom)) bottom--
    while (left < right && !columnHasInk(left)) left++
    while (right > left && !columnHasInk(right)) right--
    const padding = 2
    left = Math.max(0, left - padding); top = Math.max(0, top - padding)
    right = Math.min(sample.width - 1, right + padding); bottom = Math.min(sample.height - 1, bottom + padding)
    const sourceX = Math.round(left / sampleScale)
    const sourceY = Math.round(top / sampleScale)
    const sourceWidth = Math.max(1, Math.round((right - left + 1) / sampleScale))
    const sourceHeight = Math.max(1, Math.round((bottom - top + 1) / sampleScale))
    if (sourceWidth >= bitmap.width * 0.98 && sourceHeight >= bitmap.height * 0.98) return URL.createObjectURL(file)
    const output = document.createElement('canvas')
    output.width = Math.min(sourceWidth, bitmap.width - sourceX)
    output.height = Math.min(sourceHeight, bitmap.height - sourceY)
    output.getContext('2d')!.drawImage(bitmap, sourceX, sourceY, output.width, output.height, 0, 0, output.width, output.height)
    const blob = await new Promise<Blob>((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error('裁边输出失败')), 'image/webp', 0.92))
    output.width = 0; output.height = 0
    return URL.createObjectURL(blob)
  } finally {
    bitmap.close()
  }
}
