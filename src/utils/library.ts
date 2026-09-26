import type { ComicFormat, ComicSource } from '../types'

export function sourceIssueLabel(source: ComicSource): string {
  if (!source.status || source.status === 'available') return ''
  if (source.status === 'content-changed') return '需要重新扫描'
  if (source.type === 'input' || source.type === 'web-cache') return '需要重新导入'
  if (source.type === 'fsa-dir' || source.type === 'fsa-file') return '需要重新授权'
  return '需要重新关联'
}

export const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i
export const ARCHIVE_RE = /\.(cbz|cbr|zip|rar)$/i

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLocaleLowerCase()
}

/** Fast deterministic key; it is an identity key, not a security hash. */
export function makeSourceKey(path: string, size = 0, modified = 0, pages: string[] = []): string {
  const input = [normalizeSourcePath(path), size, modified, ...pages.map(normalizeSourcePath)].join('|')
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `src_${(hash >>> 0).toString(36)}`
}

export function makeSourceId(path: string): string {
  return makeSourceKey(path)
}

export function makeContentSignature(size = 0, modified = 0, pages: string[] = []): string {
  return makeSourceKey('content', size, modified, pages)
}

export interface GroupedInputBook {
  key: string
  sourcePath: string
  title: string
  format: ComicFormat
  files: File[]
}

/** Groups images by their complete parent path, so series/chapter/page stays one book per chapter. */
export function groupInputBooks(files: File[]): GroupedInputBook[] {
  const books = new Map<string, GroupedInputBook>()
  for (const file of files) {
    const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/')
    if (IMAGE_RE.test(file.name)) {
      const parts = rel.split('/').filter(Boolean)
      const parentParts = parts.slice(0, -1)
      // Drop only the picker root. Preserve every nested directory below it.
      const sourcePath = (parentParts.length > 1 ? parentParts.slice(1) : parentParts).join('/') || parentParts[0] || 'images'
      const title = parentParts.at(-1) || '未命名漫画'
      const key = `images:${normalizeSourcePath(sourcePath)}`
      const current = books.get(key) || { key, sourcePath, title, format: 'images' as const, files: [] }
      current.files.push(file)
      books.set(key, current)
    } else if (/\.pdf$/i.test(file.name)) {
      const key = `pdf:${normalizeSourcePath(rel)}`
      books.set(key, {
        key,
        sourcePath: rel,
        title: file.name.replace(/\.pdf$/i, ''),
        format: 'pdf',
        files: [file],
      })
    }
  }
  for (const book of books.values()) book.files.sort((a, b) => naturalCompare(a.name, b.name))
  return [...books.values()].sort((a, b) => naturalCompare(a.sourcePath, b.sourcePath))
}
