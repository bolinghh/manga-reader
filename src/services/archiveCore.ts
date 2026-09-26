// 漫画归档解压：CBZ/CBR、ZIP/RAR。
// - CBZ / zip：纯 JS（jszip），无 wasm 依赖，绝对稳定。
// - CBR / rar：node-unrar-js（Emscripten wasm）。通过 `?url` 预取 wasm 二进制并传入
//   `wasmBinary`，避免库内部 XHR 在 COOP/COEP 跨源隔离下失败（同域且走同一份二进制）。
// 返回值统一为按文件名自然序排列的图片 File[]。

// @ts-ignore - Vite ?url 资源导入（vite/client 已声明 *?url 为 string）
import wasmUrl from 'node-unrar-js/dist/js/unrar.wasm?url'
import JSZip from 'jszip'

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i
const isImage = (n: string) => IMAGE_RE.test(n)
const MAX_EXPANDED = 768 * 1024 * 1024
const MAX_PAGE = 128 * 1024 * 1024
function checkSize(size: number, total: number) {
  if (size > MAX_PAGE || total > MAX_EXPANDED) throw new Error('解压后的图片过大，请使用桌面版按页读取。')
}
let wasmPromise: Promise<ArrayBuffer> | undefined

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
}
function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] || 'application/octet-stream'
}

// 把 Uint8Array 规整为独立 ArrayBuffer, 规避 TS lib 中 Uint8Array<ArrayBufferLike>
// 与 BlobPart(要求 ArrayBufferView<ArrayBuffer>) 的类型不兼容。
function toBlobPart(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
}

// 自然序排序（1.jpg < 2.jpg < 10.jpg）
function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

export function isArchive(name: string): boolean {
  return /\.(cbz|cbr|zip|rar)$/i.test(name)
}

/** 判断归档后缀对应的解压后端是否受支持 */
export function archiveSupported(name: string): boolean {
  const lower = name.toLowerCase()
  return /\.(cbz|zip|cbr|rar)$/.test(lower)
}

type PageSink = (file: File, index: number) => Promise<void>
export async function extractArchiveImages(buf: ArrayBuffer, name: string, onPage?: PageSink): Promise<File[]> {
  if (buf.byteLength > 500 * 1024 * 1024) throw new Error('压缩包超过 500MB，请使用桌面版按页读取。')
  const lower = name.toLowerCase()
  if (/\.(cbz|zip)$/.test(lower)) return extractZip(buf, onPage)
  if (/\.(cbr|rar)$/.test(lower)) return extractRar(buf, onPage)
  throw new Error('不支持的压缩包格式，仅支持 CBZ / CBR。')
}

async function extractZip(buf: ArrayBuffer, onPage?: PageSink): Promise<File[]> {
  const zip = await JSZip.loadAsync(buf)
  const entries: { path: string; entry: JSZip.JSZipObject }[] = []
  zip.forEach((path, entry) => {
    if (entry.dir) return
    if (!isImage(path)) return
    entries.push({ path, entry })
  })
  if (!entries.length) return []
  entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  const files: File[] = []
  let total = 0
  let pageIndex = 0
  for (const { path, entry } of entries) {
      const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0
      checkSize(declared, total + declared)
      const bytes = await entry.async('uint8array')
      total += bytes.byteLength
      checkSize(bytes.byteLength, total)
      const fname = path.split('/').pop() || path
      const file = new File([toBlobPart(bytes)], fname, { type: mimeOf(fname) })
      if (onPage) await onPage(file, pageIndex++)
      else files.push(file)
  }
  return files
}

async function extractRar(buf: ArrayBuffer, onPage?: PageSink): Promise<File[]> {
  // 动态导入，避免未用到 CBR 时也打进主包
  const { createExtractorFromData } = await import('node-unrar-js')
  // 预取 wasm 二进制并直接交给 Emscripten（wasmBinary），避开库内置的 XHR locateFile，
  // 在 COOP/COEP 跨源隔离环境下同样可用。
  wasmPromise ||= fetch(wasmUrl).then(response => { if (!response.ok) throw new Error('无法加载 RAR 解压组件'); return response.arrayBuffer() }).catch(error => { wasmPromise = undefined; throw error })
  const wasmBinary = await wasmPromise
  const extractor = await createExtractorFromData({ data: buf, wasmBinary })
  let declared = 0
  const headers = [...extractor.getFileList().fileHeaders].filter(header => !header.flags.directory && isImage(header.name)).sort(byName)
  const pageIndices = new Map(headers.map((header, index) => [header.name, index]))
  for (const header of headers) {
    if (!header.flags.directory && isImage(header.name)) { declared += header.unpSize; checkSize(header.unpSize, declared) }
  }
  const { files } = extractor.extract({ files: header => !header.flags.directory && isImage(header.name) })
  const out: File[] = []
  let total = 0
  for (const f of files) {
    if (f.fileHeader.flags.directory) continue
    if (!isImage(f.fileHeader.name)) continue
    const bytes = f.extraction as Uint8Array | undefined
    if (!bytes || !bytes.byteLength) continue
    total += bytes.byteLength
    checkSize(bytes.byteLength, total)
    const fname = f.fileHeader.name.split('/').pop() || f.fileHeader.name
    const index = pageIndices.get(f.fileHeader.name)!
    const file = new File([toBlobPart(bytes)], fname, { type: mimeOf(fname) })
    if (onPage) await onPage(file, index)
    else out[index] = file
  }
  return out.filter(Boolean)
}
