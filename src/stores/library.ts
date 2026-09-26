import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import Dexie from 'dexie'
import type { Bookmark, Comic, ComicFormat, ComicSource, ImportResult, ReaderFile, ReadingSession } from '../types'
import { extractArchiveImages, isArchive, archiveSupported } from '../services/archive'
import { groupInputBooks, makeContentSignature, makeSourceId, makeSourceKey, naturalCompare } from '../utils/library'
import { isNativeDirectory, nativeAvailable, nativeFileInfo, pickNativeDirectory, pickNativeFiles, readNativeAsFile, scanNativeDirectory, type NativeBookCandidate } from '../services/nativeFiles'
import { remove as removeNativeFile } from '@tauri-apps/plugin-fs'
import { clearNativeReaderCache, closeNativeReaderFiles, openNativeReaderSource } from '../services/nativeReader'
import { clearAllTranslations, clearBookTranslations } from '../services/translationCache'
import { clearBrowserPages, deleteBrowserPages, saveBrowserPages } from '../services/browserPageCache'

// 持久化 input 类型导入的「原始文件字节」。浏览器无法持久化 File/Blob 对象
// (本环境开启 COOP/COEP 后尤甚, 直接 put 会抛 DataCloneError), 但 ArrayBuffer
// 是可结构化克隆的, 因此落盘时用 ArrayBuffer, 重开时再重建为 File。
interface ComicBlob {
  id: string
  // Directory images use a lightweight manifest; individual page bytes are read on demand.
  pages?: { name: string; type: string }[]
  // 已解压图片 / 单文件(PDF): 直接存源文件字节, 重开时重建 File[]
  files?: { name: string; type: string; data: ArrayBuffer }[]
  // 压缩包: 只存「原始压缩包一个文件」(而非解压后的全部图片字节), 重开时再解压。
  // 这样 IndexedDB 占用从「未压缩图片总和」降到「一个压缩包」, 通常小好几倍。
  archive?: { name: string; type: string; data: ArrayBuffer }
}

interface CoverRecord {
  comicId: string
  blob: Blob
  updatedAt: number
}

function dataUrlToBlob(value: string): Blob {
  const [header, body = ''] = value.split(',', 2)
  const mime = header.match(/^data:([^;,]+)/)?.[1] || 'image/jpeg'
  const bytes = header.includes(';base64') ? Uint8Array.from(atob(body), (char) => char.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body))
  return new Blob([bytes], { type: mime })
}

class LuminaDB extends Dexie {
  comics!: Dexie.Table<Comic, string>
  bookmarks!: Dexie.Table<Bookmark, string>
  blobs!: Dexie.Table<ComicBlob, string>
  covers!: Dexie.Table<CoverRecord, string>
  readingSessions!: Dexie.Table<ReadingSession, string>
  constructor() {
    super('lumina')
    this.version(1).stores({
      comics: 'id, title, format, addedAt, lastReadAt',
      bookmarks: 'id, comicId, createdAt',
    })
    // v2: 新增 blobs 表, 持久化 input 导入的源文件字节, 使刷新后仍可重开漫画
    this.version(2).stores({
      blobs: 'id',
    })
    this.version(3).stores({
      comics: 'id, title, format, addedAt, lastReadAt, sourceKey, series',
      bookmarks: 'id, comicId, createdAt',
      blobs: 'id',
    }).upgrade(async (tx) => {
      await tx.table('comics').toCollection().modify((comic: Comic) => {
        comic.tags ||= []
        comic.lastReadAt ||= 0
        comic.lastPosition ||= 0
        comic.fit ||= 'width'
        comic.pageMode ||= 'single'
        comic.pageDir ||= 'ltr'
        comic.readMode ||= 'page'
        if (!comic.sourceKey) {
          const sourcePath = comic.source?.rootPath || comic.source?.path || comic.source?.dirPath || comic.source?.filePaths?.join('|') || `${comic.title}|${comic.format}`
          comic.sourceKey = makeSourceKey(sourcePath)
        }
        if (comic.source?.type === 'fsa-dir' || comic.source?.type === 'fsa-file') {
          comic.source.status ||= 'migration-required'
        }
      })
    })
    this.version(4).stores({
      comics: 'id, title, format, addedAt, lastReadAt, sourceKey, sourceId, series',
      bookmarks: 'id, comicId, createdAt',
      blobs: 'id',
      covers: 'comicId, updatedAt',
      readingSessions: 'id, comicId, startedAt, endedAt',
    }).upgrade(async (tx) => {
      const comics = await tx.table<Comic>('comics').toArray()
      const covers: CoverRecord[] = []
      for (const comic of comics) {
        comic.sourceId ||= makeSourceId(comic.source?.rootPath || comic.source?.path || comic.sourceKey || comic.id)
        comic.contentSignature ||= comic.sourceKey
        comic.favorite ||= false
        if (comic.cover?.startsWith('data:')) {
          try {
            covers.push({ comicId: comic.id, blob: dataUrlToBlob(comic.cover), updatedAt: Date.now() })
            comic.cover = undefined
          } catch {
            // Keep the legacy data URL when conversion fails.
          }
        }
      }
      if (covers.length) await tx.table('covers').bulkPut(covers)
      await tx.table('comics').bulkPut(comics)
    })
  }
}
const db = new LuminaDB()

// IndexedDB 只能结构化克隆「可克隆」值。FileSystemDirectoryHandle /
// FileSystemFileHandle, 以及本环境下(开启 COOP/COEP 跨源隔离后)的 File/Blob,
// 都不可克隆, 直接 put 会抛 DataCloneError。
//
// 因此持久化时只保留「可序列化的元数据」:
//   - fsa 句柄 -> 退化为路径(dirPath / filePaths), 重开时重新请求权限
//   - input 的 File[] -> 字节缓存单独落盘, 元数据只保留路径和状态
// 内存中的 comics 始终保留完整副本(含句柄/File[]), 保证本次会话内读取正常。
function toPersistable(c: Comic): Comic {
  const s = c.source
  let source: ComicSource
  if (s.type === 'fsa-dir') {
    source = {
      type: 'fsa-dir',
      dirPath: s.dirPath || (s.dirHandle as any)?.name,
      filePaths: s.filePaths ? [...s.filePaths] : undefined,
      signature: s.signature,
      status: s.status,
    }
  } else if (s.type === 'fsa-file') {
    source = { type: 'fsa-file', filePaths: s.filePaths || (s.fileHandles || []).map((h: any) => h.name), signature: s.signature, status: s.status }
  } else if (s.type === 'native-dir') {
    source = { type: s.type, rootPath: s.rootPath, pagePaths: s.pagePaths ? [...s.pagePaths] : [], signature: s.signature, status: s.status }
  } else if (s.type === 'native-file') {
    source = { type: s.type, path: s.path, signature: s.signature, status: s.status }
  } else {
    // 文件字节存于独立缓存, 不把 File 对象写入元数据。
    source = {
      type: s.type === 'web-cache' ? 'web-cache' : 'input',
      filePaths: s.filePaths ? [...s.filePaths] : undefined,
      status: s.status,
    }
  }
  return {
    id: c.id,
    title: c.title,
    format: c.format,
    cover: c.cover,
    addedAt: c.addedAt,
    lastReadAt: c.lastReadAt,
    lastPosition: c.lastPosition,
    totalPages: c.totalPages,
    tags: c.tags ? [...c.tags] : [],
    source,
    sourceKey: c.sourceKey,
    sourceId: c.sourceId,
    contentSignature: c.contentSignature,
    favorite: c.favorite,
    series: c.series,
    pageMode: c.pageMode,
    pageDir: c.pageDir,
    readMode: c.readMode,
    fit: c.fit,
    spreadOffset: c.spreadOffset,
    rotation: c.rotation,
    autoCrop: c.autoCrop,
  }
}

// 极端兜底: 连 source.files 都不可克隆时, 只存类型, 完全不落盘访问数据。
// 这一步保证无论什么运行环境, 元数据一定写得进 IndexedDB, 不会再抛 DataCloneError。
function metaOnly(c: Comic): Comic {
  return { ...c, source: { type: c.source.type } }
}

async function safePut(comic: Comic): Promise<boolean> {
  const persisted = toPersistable(comic)
  if (comic.cover?.startsWith('data:')) {
    try {
      await db.covers.put({ comicId: comic.id, blob: dataUrlToBlob(comic.cover), updatedAt: Date.now() })
      persisted.cover = undefined
    } catch (coverError) {
      console.warn('[library] 封面拆分保存失败，暂时保留旧字段:', coverError)
    }
  }
  try {
    await db.comics.put(persisted)
    return true
  } catch (e: any) {
    // 退化: 只存类型, 完全不落盘访问数据; 仍失败则仅内存保留, 绝不抛未捕获异常
    try {
      await db.comics.put(metaOnly(comic))
      return true
    } catch (e2: any) {
      console.error('[library] 漫画元数据落盘失败(已忽略, 仅内存保留):', e2)
      return false
    }
  }
}

// 将 input 导入的源文件字节落盘到 blobs 表, 刷新后可通过 resolveFiles 还原为 File 重开。
// 失败(如超出 IndexedDB 配额)仅告警并降级: 当前会话仍能读, 但刷新后需重新导入。
async function persistBlobs(id: string, files: File[]): Promise<boolean> {
  try {
    if (files.length && files.every((file) => isImage(file.name))) {
      await saveBrowserPages(id, files)
      try {
        await db.blobs.put({ id, pages: files.map((file) => ({ name: file.name, type: file.type })) })
      } catch (error) {
        await deleteBrowserPages(id).catch(() => undefined)
        throw error
      }
      return true
    }
    const out = await Promise.all(
      files.map(async (f) => ({ name: f.name, type: f.type, data: await f.arrayBuffer() })),
    )
    await db.blobs.put({ id, files: out })
    return true
  } catch (e: any) {
    console.warn('[library] 源文件字节持久化失败(刷新后该漫画需重新导入):', e)
    return false
  }
}

// 压缩包导入专用: 只落盘「原始压缩包一个文件」, 刷新时 resolveFiles 再按需解压。
// 相比 persistBlobs(存解压后的全部图片), IndexedDB 占用通常小好几倍。
async function persistArchive(id: string, file: File): Promise<boolean> {
  try {
    const data = await file.arrayBuffer()
    await db.blobs.put({ id, archive: { name: file.name, type: file.type, data } })
    return true
  } catch (e: any) {
    console.warn('[library] 压缩包字节持久化失败(刷新后该漫画需重新导入):', e)
    return false
  }
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i
const isImage = (n: string) => IMAGE_RE.test(n)
const SINGLE_RE = /\.pdf$/i

function classify(name: string): ComicFormat | 'image' | null {
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (isImage(name)) return 'image'
  return null
}

function mimeForImage(name: string) {
  const extension = name.split('.').pop()?.toLowerCase()
  return extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/jpeg'
}

// Natural-order sort by filename (so 1.jpg < 2.jpg < 10.jpg). Used for every
// place that orders page/image files so reading order is always correct.
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

// Human label for tag chips (the DB stores the raw format key e.g. "images").
export const TAG_LABELS: Record<string, string> = {
  images: '图片',
  pdf: 'PDF',
}
export function tagLabel(t: string): string {
  return TAG_LABELS[t] ?? t
}

// Series grouping: strip a trailing chapter/volume marker so "蓝锁 第001话" and
// "蓝锁 第002话" collapse under the same series "蓝锁".
const SERIES_RE = /[\s\-_#·]*(?:第\s*|No\.?\s*|no\.?\s*)?\d+[\s]*[话卷期集回章节册]?$/i
export function seriesOf(title: string): string {
  const s = title.replace(SERIES_RE, '').trim()
  return s || title
}
// Extract the trailing chapter number for in-series ordering.
export function chapterNum(title: string): number {
  const nums = title.match(/\d+/g)
  return nums ? parseInt(nums[nums.length - 1], 10) : 0
}

async function makeCover(file: File): Promise<string | undefined> {
  let url = ''
  try {
    const img = new Image()
    url = URL.createObjectURL(file)
    await new Promise((res, rej) => {
      img.onload = res
      img.onerror = rej
      img.src = url
    })
    const w = Math.min(img.width, 480)
    const h = Math.round((img.height * w) / img.width)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')!.drawImage(img, 0, 0, w, h)
    return c.toDataURL('image/jpeg', 0.7)
  } catch {
    return undefined
  } finally {
    if (url) URL.revokeObjectURL(url)
  }
}

// 按格式生成封面缩略图: 图片走 makeCover; PDF 走 pdfCover(动态 import pdfjs, 不污染主包)。
// 其他格式(目前无)返回 undefined。
async function makeCoverFor(format: ComicFormat, files: File[]): Promise<string | undefined> {
  if (!files.length) return undefined
  if (format === 'images') return makeCover(files[0])
  if (format === 'pdf') {
    try {
      const { pdfCover } = await import('../utils/pdfCover')
      return await pdfCover(files[0])
    } catch {
      return undefined
    }
  }
  return undefined
}

// ---- 有界内存缓存 (LRU) ----
// session: input/FSA 导入解析出的 File[]; archiveCache: 压缩包解压结果(纯派生缓存)。
// 两者按 LRU 设上限, 避免"同一会话打开多本大压缩包/大目录"导致常驻内存无上界:
//   - archiveCache 缺失时可就地重解, 逐出零风险;
//   - session 只逐出「可恢复」条目(已成功落盘, 重开时能从 IndexedDB 还原), 绝不逐出「仅会话内存在」
//     的图片来源(如 input 图片目录), 宁多占内存也不丢用户数据。
const SESSION_MAX = 8
const ARCHIVE_CACHE_MAX = 4
const MEMORY_BYTES = 192 * 1024 * 1024
const cachedBytes = (cache: Map<string, File[]>) => [...cache.values()].reduce((sum, files) => sum + files.reduce((size, file) => size + file.size, 0), 0)
// 每本漫画保留的阅读会话条数上限(用于统计), 超出裁剪最旧的, 防止 IndexedDB 无界增长
const SESSION_HISTORY_MAX = 30
const session = new Map<string, File[]>()
const archiveCache = new Map<string, File[]>()
// 已成功持久化(file/archive 字节已落盘)的 comic id -> 逐出其 session 缓存是安全的
const restorableIds = new Set<string>()

// Map 保序: delete + set 即把 key 移到"最近使用"端, 实现 LRU
function lruTouch<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}
function sessionGet(id: string): File[] | undefined {
  return lruTouch(session, id)
}
function sessionSet(id: string, files: File[]) {
  session.delete(id)
  session.set(id, files)
  if (session.size <= SESSION_MAX && cachedBytes(session) <= MEMORY_BYTES) return
  // 从最久未使用端开始逐出, 但只动「可恢复」条目; 仅会话内的图片保留, 避免丢数据
  for (const key of [...session.keys()]) {
    if (session.size <= SESSION_MAX && cachedBytes(session) <= MEMORY_BYTES) break
    if (restorableIds.has(key)) session.delete(key)
  }
}
function archiveCacheGet(id: string): File[] | undefined {
  return lruTouch(archiveCache, id)
}
function archiveCacheSet(id: string, files: File[]) {
  archiveCache.delete(id)
  archiveCache.set(id, files)
  while (archiveCache.size > ARCHIVE_CACHE_MAX || cachedBytes(archiveCache) > MEMORY_BYTES) {
    const oldest = archiveCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    archiveCache.delete(oldest)
  }
}

const emptyResult = (): ImportResult => ({ added: [], skipped: [], failed: [], durability: 'permanent' })
function durabilityFor(results: boolean[], sessionOnly = false): ImportResult['durability'] {
  if (sessionOnly) return 'session'
  if (!results.length || results.every(Boolean)) return 'permanent'
  return results.some(Boolean) ? 'session' : 'failed'
}

function fileReaderSources(files: File[]): ReaderFile[] {
  return files.map((file) => ({ kind: 'file', name: file.name, type: file.type, file }))
}

function handleReaderSources(handles: FileSystemFileHandle[]): ReaderFile[] {
  return handles.map((handle) => ({
    kind: 'fsa-handle',
    name: handle.name,
    type: /\.pdf$/i.test(handle.name) ? 'application/pdf' : mimeForImage(handle.name),
    handle,
  }))
}

export const useLibrary = defineStore('library', () => {
  const comics = ref<Comic[]>([])
  const bookmarks = ref<Bookmark[]>([])
  const query = ref('')
  const activeTag = ref<string | null>(null)
  const shelfFilter = ref<'all' | 'unread' | 'reading' | 'completed' | 'favorite' | 'source-issues'>('all')
  const sortMode = ref<'recent' | 'imported' | 'title' | 'progress' | 'series'>('recent')
  // 排序/筛选持久化: 刷新后保留用户的视图选择(query/activeTag 属临时搜索, 不持久化)
  const VIEW_PREF_KEY = 'mangareader.viewPrefs'
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_PREF_KEY) || '{}') as { shelfFilter?: typeof shelfFilter.value; sortMode?: typeof sortMode.value }
    if (saved.shelfFilter && ['all', 'unread', 'reading', 'completed', 'favorite', 'source-issues'].includes(saved.shelfFilter)) shelfFilter.value = saved.shelfFilter
    if (saved.sortMode && ['recent', 'imported', 'title', 'progress', 'series'].includes(saved.sortMode)) sortMode.value = saved.sortMode
  } catch {
    /* 损坏的偏好忽略即可 */
  }
  watch([shelfFilter, sortMode], () => {
    try {
      localStorage.setItem(VIEW_PREF_KEY, JSON.stringify({ shelfFilter: shelfFilter.value, sortMode: sortMode.value }))
    } catch {
      /* 隐私模式等写失败不影响使用 */
    }
  })
  const scanning = ref(false)
  const coverUrls = new Map<string, { url: string; uses: number }>()
  const coverPending = new Map<string, Promise<string>>()

  async function acquireCoverUrl(comicId: string, fallback?: string) {
    const cached = coverUrls.get(comicId)
    if (cached) {
      cached.uses++
      return cached.url
    }
    const pending = coverPending.get(comicId)
    if (pending) {
      const url = await pending
      const loaded = coverUrls.get(comicId)
      if (loaded) loaded.uses++
      return url
    }
    const task = (async () => {
      const record = await db.covers.get(comicId)
      if (!record?.blob) return fallback || ''
      const url = URL.createObjectURL(record.blob)
      coverUrls.set(comicId, { url, uses: 1 })
      return url
    })().finally(() => coverPending.delete(comicId))
    coverPending.set(comicId, task)
    return task
  }

  function releaseCoverUrl(comicId: string) {
    const cached = coverUrls.get(comicId)
    if (!cached) return
    cached.uses--
    if (cached.uses <= 0) {
      URL.revokeObjectURL(cached.url)
      coverUrls.delete(comicId)
    }
  }

  async function coverDataUrl(comic: Comic) {
    if (comic.cover) return comic.cover
    const record = await db.covers.get(comic.id)
    if (!record?.blob) return undefined
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(record.blob)
    })
  }

  const filtered = computed(() => {
    const result = comics.value
      .filter((c) => (query.value ? c.title.toLowerCase().includes(query.value.toLowerCase()) : true))
      .filter((c) => (activeTag.value ? c.tags.includes(activeTag.value) : true))
      .filter((c) => {
        if (shelfFilter.value === 'unread') return c.lastReadAt <= 0
        if (shelfFilter.value === 'reading') return c.lastReadAt > 0 && (!c.totalPages || c.lastPosition < c.totalPages)
        if (shelfFilter.value === 'completed') return !!c.totalPages && c.lastPosition >= c.totalPages
        if (shelfFilter.value === 'favorite') return !!c.favorite
        if (shelfFilter.value === 'source-issues') return !!c.source.status && c.source.status !== 'available'
        return true
      })
    return result.sort((a, b) => {
      if (sortMode.value === 'imported') return b.addedAt - a.addedAt
      if (sortMode.value === 'title') return a.title.localeCompare(b.title, undefined, { numeric: true })
      if (sortMode.value === 'progress') return (b.totalPages ? b.lastPosition / b.totalPages : 0) - (a.totalPages ? a.lastPosition / a.totalPages : 0)
      if (sortMode.value === 'series') return (a.series || seriesOf(a.title)).localeCompare(b.series || seriesOf(b.title), undefined, { numeric: true }) || chapterNum(a.title) - chapterNum(b.title)
      return b.lastReadAt - a.lastReadAt || b.addedAt - a.addedAt
    })
  })

  const allTags = computed(() => {
    const s = new Set<string>()
    comics.value.forEach((c) => c.tags.forEach((t) => s.add(t)))
    return [...s]
  })

  const recent = computed(() => [...comics.value].filter((c) => c.lastReadAt > 0).sort((a, b) => b.lastReadAt - a.lastReadAt).slice(0, 6))

  async function load() {
    const [loaded, savedBookmarks, cachedIds] = await Promise.all([
      db.comics.toArray(), db.bookmarks.toArray(), db.blobs.toCollection().primaryKeys(),
    ])
    const cached = new Set(cachedIds)
    for (const comic of loaded) {
      const source = comic.source
      if (source.type === 'input' || source.type === 'web-cache') {
        const readable = cached.has(comic.id) || !!sessionGet(comic.id)?.length
        if (cached.has(comic.id)) restorableIds.add(comic.id)
        else restorableIds.delete(comic.id)
        const status = readable ? 'available' : 'missing'
        if (source.status !== status) {
          source.status = status
          await safePut(comic)
        }
      } else if (source.type === 'fsa-dir' || source.type === 'fsa-file') {
        // Handles are intentionally omitted from metadata. Keep live handles if load is called again.
        const live = comics.value.find((item) => item.id === comic.id)?.source
        if (live?.dirHandle || live?.fileHandles?.length) comic.source = live
        else source.status = 'permission-required'
      }
    }
    comics.value = loaded
    bookmarks.value = savedBookmarks
  }

  async function addComic(meta: Omit<Comic, 'id' | 'addedAt' | 'lastReadAt' | 'lastPosition' | 'tags'> & { tags?: string[] }) {
    const comic: Comic = {
      id: uid(),
      addedAt: Date.now(),
      lastReadAt: 0,
      lastPosition: 0,
      tags: meta.tags || [],
      ...meta,
    }
    comic.sourceKey ||= makeSourceKey(
      comic.source.rootPath || comic.source.path || comic.source.dirPath || comic.source.filePaths?.join('|') || `${comic.title}|${comic.format}|${comic.addedAt}`,
      0,
      0,
      comic.source.pagePaths,
    )
    const sourcePath = comic.source.rootPath || comic.source.path || comic.source.dirPath || comic.source.filePaths?.join('|') || `${comic.title}|${comic.format}`
    comic.sourceId ||= makeSourceId(sourcePath)
    comic.contentSignature ||= comic.sourceKey
    // 落盘: 剥离句柄/不可克隆内容; 内存: 保留完整副本(含句柄/File[])供本次会话读取
    await safePut(comic)
    comics.value = [comic, ...comics.value]
    return comic
  }

  async function removeComic(id: string) {
    await clearBookTranslations(id, true)
    const removed = comics.value.find((comic) => comic.id === id)
    const sourcePath = removed?.source.rootPath || removed?.source.path
    if (sourcePath) await clearNativeReaderCache(sourcePath).catch(() => undefined)
    await db.comics.delete(id)
    await db.bookmarks.where('comicId').equals(id).delete()
    try { await db.blobs.delete(id) } catch { /* ignore */ }
    await deleteBrowserPages(id).catch(() => undefined)
    try { await db.covers.delete(id) } catch { /* ignore */ }
    try { await db.readingSessions.where('comicId').equals(id).delete() } catch { /* ignore */ }
    const cover = coverUrls.get(id)
    if (cover) URL.revokeObjectURL(cover.url)
    coverUrls.delete(id)
    session.delete(id)
    archiveCache.delete(id)
    restorableIds.delete(id)
    // 就地过滤而非从 db 重载: 保留"仅存在于内存、尚未成功落盘"的条目(如导入时 IndexedDB 写失败),
    // 否则这些条目会从书架上凭空消失。书签同理。
    comics.value = comics.value.filter((comic) => comic.id !== id)
    bookmarks.value = bookmarks.value.filter((bookmark) => bookmark.comicId !== id)
  }

  async function touch(id: string, position?: number, totalPages?: number) {
    const c = comics.value.find((x) => x.id === id)
    if (!c) return
    c.lastReadAt = Date.now()
    if (position !== undefined) c.lastPosition = position
    if (totalPages !== undefined) c.totalPages = totalPages
    await safePut(c)
  }

  async function addTag(id: string, tag: string) {
    const c = comics.value.find((x) => x.id === id)
    if (!c || !tag || c.tags.includes(tag)) return
    c.tags.push(tag)
    await safePut(c)
  }

  async function updateComic(id: string, patch: Pick<Comic, 'title' | 'tags'> & { series?: string; cover?: string }) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic) return false
    comic.title = patch.title.trim() || comic.title
    comic.tags = [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))]
    comic.series = patch.series?.trim() || undefined
    if (patch.cover !== undefined) comic.cover = patch.cover
    return safePut(comic)
  }

  // 批量修改: 对多本漫画同时增/删标签, 可选统一设置系列(批量整理用)
  async function updateComics(ids: string[], patch: { addTags?: string[]; removeTags?: string[]; series?: string }) {
    const add = (patch.addTags || []).map((tag) => tag.trim()).filter(Boolean)
    const remove = new Set((patch.removeTags || []).map((tag) => tag.trim()).filter(Boolean))
    let count = 0
    for (const id of ids) {
      const comic = comics.value.find((item) => item.id === id)
      if (!comic) continue
      const next = new Set(comic.tags.filter((tag) => !remove.has(tag)))
      add.forEach((tag) => next.add(tag))
      comic.tags = [...next]
      if (patch.series !== undefined) comic.series = patch.series.trim() || undefined
      await safePut(comic)
      count++
    }
    return count
  }

  async function resetProgress(id: string) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic) return
    comic.lastPosition = 0
    comic.lastReadAt = 0
    await safePut(comic)
  }

  async function toggleFavorite(id: string) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic) return
    comic.favorite = !comic.favorite
    await safePut(comic)
  }

  async function markSourcesChanged(root: string, paths: string[]) {
    const normalizedRoot = root.replace(/\\/g, '/').toLowerCase()
    const changed = paths.map((path) => path.replace(/\\/g, '/').toLowerCase())
    const invalidated = new Set<string>()
    for (const comic of comics.value) {
      const location = (comic.source.rootPath || comic.source.path || '').replace(/\\/g, '/').toLowerCase()
      if (!location || (!location.startsWith(normalizedRoot) && !changed.some((path) => path.startsWith(location) || location.startsWith(path)))) continue
      const originalLocation = comic.source.rootPath || comic.source.path
      if (originalLocation && !invalidated.has(originalLocation)) {
        invalidated.add(originalLocation)
        await clearNativeReaderCache(originalLocation).catch(() => undefined)
      }
      comic.source.status = 'content-changed'
      await safePut(comic)
    }
  }

  // 阅读会话用于统计; 每本只保留最近 SESSION_HISTORY_MAX 条, 防止 IndexedDB 无界增长
  async function pruneReadingSessions(comicId: string) {
    try {
      const rows = await db.readingSessions.where('comicId').equals(comicId).toArray()
      if (rows.length <= SESSION_HISTORY_MAX) return
      rows.sort((a, b) => b.startedAt - a.startedAt)
      const stale = rows.slice(SESSION_HISTORY_MAX).map((row) => row.id)
      if (stale.length) await db.readingSessions.bulkDelete(stale)
    } catch {
      /* 裁剪失败不影响阅读主流程 */
    }
  }

  async function beginReadingSession(comicId: string, startPosition: number) {
    const entry: ReadingSession = { id: uid(), comicId, startedAt: Date.now(), endedAt: 0, startPosition, endPosition: startPosition }
    await db.readingSessions.put(entry)
    void pruneReadingSessions(comicId)
    return entry.id
  }

  async function finishReadingSession(id: string, endPosition: number) {
    const entry = await db.readingSessions.get(id)
    if (!entry) return
    entry.endedAt = Date.now()
    entry.endPosition = endPosition
    await db.readingSessions.put(entry)
  }

  // 聚合 readingSessions 得到阅读统计(总时长/连续天数/本周/翻页数/最近7天)
  interface ReadingStats {
    totalMs: number
    sessionCount: number
    streakDays: number
    weekMs: number
    weekSessions: number
    pagesTurned: number
    comicsTouched: number
    daily: { label: string; dayKey: string; ms: number }[]
  }
  async function readingStats(): Promise<ReadingStats> {
    const rows = await db.readingSessions.toArray()
    const DAY = 86400000
    const MIN_MS = 3000 // 过滤误开(<3s)
    const MAX_MS = 6 * 3600 * 1000 // 过滤挂机(>6h)
    const durationOf = (r: ReadingSession) => Math.max(0, (r.endedAt || r.startedAt) - r.startedAt)
    const valid = rows.filter((r) => durationOf(r) >= MIN_MS && durationOf(r) <= MAX_MS)
    const totalMs = valid.reduce((sum, r) => sum + durationOf(r), 0)
    const pagesTurned = valid.reduce((sum, r) => sum + Math.abs((r.endPosition || 0) - (r.startPosition || 0)), 0)
    const comicsTouched = new Set(valid.map((r) => r.comicId)).size

    const dayKeys = new Set(valid.map((r) => new Date(r.startedAt).toDateString()))
    const cursor = new Date()
    cursor.setHours(0, 0, 0, 0)
    if (!dayKeys.has(cursor.toDateString())) cursor.setTime(cursor.getTime() - DAY) // 今天未读则从昨天起算
    let streakDays = 0
    while (dayKeys.has(cursor.toDateString())) {
      streakDays++
      cursor.setTime(cursor.getTime() - DAY)
    }

    const now = new Date()
    const weekStart = new Date(now)
    weekStart.setHours(0, 0, 0, 0)
    weekStart.setTime(weekStart.getTime() - ((weekStart.getDay() + 6) % 7) * DAY) // 周一为一周起点
    const weekRows = valid.filter((r) => r.startedAt >= weekStart.getTime())

    // 最近 7 天(含今天)每日时长
    const daily: { label: string; dayKey: string; ms: number }[] = []
    const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
    for (let offset = 6; offset >= 0; offset--) {
      const day = new Date()
      day.setHours(0, 0, 0, 0)
      day.setTime(day.getTime() - offset * DAY)
      const key = day.toDateString()
      const ms = valid.filter((r) => new Date(r.startedAt).toDateString() === key).reduce((sum, r) => sum + durationOf(r), 0)
      daily.push({ label: offset === 0 ? '今天' : WEEKDAY[day.getDay()], dayKey: key, ms })
    }

    return {
      totalMs,
      sessionCount: valid.length,
      streakDays,
      weekMs: weekRows.reduce((sum, r) => sum + durationOf(r), 0),
      weekSessions: weekRows.length,
      pagesTurned,
      comicsTouched,
      daily,
    }
  }

  // 记住每本漫画的单页/双页模式 (纯字符串, 可结构化克隆, 不会触发 DataCloneError)
  async function setPageMode(id: string, mode: 'single' | 'double') {
    const c = comics.value.find((x) => x.id === id)
    if (!c || c.pageMode === mode) return
    c.pageMode = mode
    await safePut(c)
  }

  // 记住每本漫画双页铺开方向 (ltr 从左往右 / rtl 从右往左)
  async function setPageDir(id: string, dir: 'ltr' | 'rtl') {
    const c = comics.value.find((x) => x.id === id)
    if (!c || c.pageDir === dir) return
    c.pageDir = dir
    await safePut(c)
  }

  // 记住每本漫画的翻页适应模式 (width 适应宽 / height 适应高 / actual 原大)
  async function setFitMode(id: string, fit: 'width' | 'height' | 'actual') {
    const c = comics.value.find((x) => x.id === id)
    if (!c || c.fit === fit) return
    c.fit = fit
    await safePut(c)
  }

  // 记住每本漫画的阅读方式 (page 翻页 / webtoon 竖向滚动)
  async function setReadMode(id: string, mode: 'page' | 'webtoon') {
    const c = comics.value.find((x) => x.id === id)
    if (!c || c.readMode === mode) return
    c.readMode = mode
    await safePut(c)
  }

  async function setSpreadOffset(id: string, offset: 0 | 1) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic || comic.spreadOffset === offset) return
    comic.spreadOffset = offset
    await safePut(comic)
  }

  async function setRotation(id: string, rotation: 0 | 90 | 180 | 270) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic || comic.rotation === rotation) return
    comic.rotation = rotation
    await safePut(comic)
  }

  async function setAutoSpread(id: string, enabled: boolean) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic || !!comic.autoSpread === enabled) return
    comic.autoSpread = enabled
    await safePut(comic)
  }

  async function setAutoCrop(id: string, enabled: boolean) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic || comic.autoCrop === enabled) return
    comic.autoCrop = enabled
    await safePut(comic)
  }

  async function addBookmark(comicId: string, position: number, label?: string) {
    const b: Bookmark = { id: uid(), comicId, position, label, createdAt: Date.now() }
    try {
      await db.bookmarks.put(b)
      bookmarks.value = await db.bookmarks.toArray()
    } catch (e: any) {
      console.error('[library] 书签落盘失败(已忽略):', e)
    }
  }
  async function removeBookmark(id: string) {
    await db.bookmarks.delete(id)
    bookmarks.value = await db.bookmarks.toArray()
  }
  async function updateBookmark(id: string, label: string) {
    const bookmark = bookmarks.value.find((item) => item.id === id)
    if (!bookmark) return
    bookmark.label = label.trim() || undefined
    await db.bookmarks.put(bookmark)
    bookmarks.value = await db.bookmarks.toArray()
  }
  const bookmarksFor = (comicId: string) => bookmarks.value.filter((b) => b.comicId === comicId)

  // ---- Single import (images folder / pdf / archive) ----
  function existingBrowserComic(sourceKey: string, filePaths: string[] = [], files: File[] = []) {
    const keys = new Set([sourceKey])
    if (files.length) {
      const size = files.reduce((sum, file) => sum + file.size, 0)
      const modified = Math.max(...files.map((file) => file.lastModified))
      keys.add(makeSourceKey(filePaths[0], size, modified, filePaths))
      const groups = groupInputBooks(files)
      if (groups.length === 1) keys.add(makeSourceKey(groups[0].sourcePath, size, modified, filePaths))
      if (files.length === 1 && SINGLE_RE.test(files[0].name)) keys.add(makeSourceKey(filePaths[0], size, modified))
    }
    const exact = comics.value.find((comic) => comic.sourceKey && keys.has(comic.sourceKey))
    if (exact) return exact
    // Single-folder and batch imports historically used different keys for identical files.
    // Match the complete saved manifest when recovering an old browser book.
    const paths = [...filePaths].sort(naturalCompare)
    if (!paths.some((path) => path.includes('/'))) return undefined
    return comics.value.find((comic) => {
      if (!['input', 'web-cache'].includes(comic.source.type) || restorableIds.has(comic.id)) return false
      const saved = [...(comic.source.filePaths || [])].sort(naturalCompare)
      return saved.length === paths.length && saved.every((path, index) => path === paths[index])
    })
  }

  function alreadySaved(comic: Comic | undefined) {
    return comic && (!['input', 'web-cache'].includes(comic.source.type)
      || (restorableIds.has(comic.id) && comic.source.status === 'available'))
  }

  async function addOrRestoreBrowserComic(meta: Parameters<typeof addComic>[0], existing?: Comic) {
    if (!existing) return addComic(meta)
    existing.source = { ...meta.source, status: 'available' }
    existing.sourceKey = meta.sourceKey
    existing.contentSignature = meta.sourceKey
    existing.totalPages = meta.totalPages || existing.totalPages
    if (existing.totalPages) existing.lastPosition = Math.min(existing.lastPosition, existing.totalPages)
    await safePut(existing)
    return existing
  }

  async function saveBrowserImport(comic: Comic, files: File[], archive?: File) {
    sessionSet(comic.id, files)
    const persisted = archive ? await persistArchive(comic.id, archive) : await persistBlobs(comic.id, files)
    if (persisted) restorableIds.add(comic.id)
    else restorableIds.delete(comic.id)
    sessionSet(comic.id, files)
    // A live session is readable even if storage is full; load() rechecks actual cache availability.
    comic.source.status = 'available'
    comic.source.files = []
    await safePut(comic)
    return persisted
  }

  async function relinkBrowserFiles(id: string, fileList: FileList): Promise<ImportResult> {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic || !['input', 'web-cache'].includes(comic.source.type)) throw new Error('此书目不是浏览器文件来源。')
    const selected = Array.from(fileList)
    const archive = selected.find((file) => isArchive(file.name))
    let files: File[]
    if (archive && !comic.source.filePaths?.length) {
      if (makeSourceKey(archive.webkitRelativePath || archive.name, archive.size, archive.lastModified) !== comic.sourceKey) {
        throw new Error('所选压缩包与原书来源不匹配，请选择原来的文件。')
      }
      if (archive.size > 500 * 1024 * 1024) throw new Error('压缩包超过 500MB，请使用桌面版按页读取。')
      files = await extractArchiveImages(await archive.arrayBuffer(), archive.name)
    } else {
      files = selected.filter((file) => comic.format === 'images' ? isImage(file.name) : /\.pdf$/i.test(file.name))
        .sort((a, b) => naturalCompare(a.name, b.name))
      const expected = [...(comic.source.filePaths || [])].sort(naturalCompare)
      const actual = files.map((file) => file.webkitRelativePath || file.name).sort(naturalCompare)
      // A chapter imported through a parent folder can later be selected directly.
      // Preserve its folder name and full page structure while ignoring only common ancestors.
      const manifest = (paths: string[]) => {
        const parts = paths.map((path) => path.replace(/\\/g, '/').split('/'))
        let prefix = 0
        while (parts.length && parts.every((part) => part.length > prefix + 1 && part[prefix] === parts[0][prefix])) prefix++
        return { folder: parts[0]?.[prefix - 1] || '', pages: parts.map((part) => part.slice(prefix).join('/')) }
      }
      const saved = manifest(expected), chosen = manifest(actual)
      if (expected.length ? saved.folder !== chosen.folder || saved.pages.length !== chosen.pages.length || saved.pages.some((path, index) => path !== chosen.pages[index])
        : files.length !== 1 || makeSourceKey(actual[0], files[0].size, files[0].lastModified) !== comic.sourceKey) {
        throw new Error('所选文件与原书页清单不匹配，请选择原来的目录或文件。')
      }
    }
    if (!files.length || (comic.format === 'images' && comic.totalPages && files.length !== comic.totalPages)) {
      throw new Error('所选内容的页数与原书不匹配，未进行关联。')
    }
    comic.contentSignature = archive
      ? makeSourceKey(archive.webkitRelativePath || archive.name, archive.size, archive.lastModified)
      : makeContentSignature(files.reduce((sum, file) => sum + file.size, 0), Math.max(...files.map((file) => file.lastModified)), files.map((file) => file.webkitRelativePath || file.name))
    const persisted = await saveBrowserImport(comic, files, archive)
    const result = emptyResult()
    result.added.push(comic)
    result.durability = persisted ? 'permanent' : 'session'
    return result
  }

  async function importInputFiles(fileList: FileList): Promise<ImportResult> {
    const result = emptyResult()
    const files = Array.from(fileList)
    // 压缩包优先（CBZ / CBR）
    const archive = files.find((f) => isArchive(f.name))
    if (archive) return importArchive(archive)
    const single = files.find((f) => SINGLE_RE.test(f.name))
    if (single) {
      const format = classify(single.name) as ComicFormat
      const title = single.name.replace(SINGLE_RE, '')
      const cover = await makeCoverFor(format, [single])
      const sourceKey = makeSourceKey(single.webkitRelativePath || single.name, single.size, single.lastModified)
      const existing = existingBrowserComic(sourceKey, [single.webkitRelativePath || single.name], [single])
      if (alreadySaved(existing)) {
        result.skipped.push({ name: single.name, reason: '同一来源已在书库中' })
        return result
      }
      const comic = await addOrRestoreBrowserComic({ title, format, cover, sourceKey, source: { type: 'web-cache', files: [single], filePaths: [single.webkitRelativePath || single.name], status: 'available' }, tags: [format] }, existing)
      const persisted = await saveBrowserImport(comic, [single])
      result.added.push(comic)
      result.durability = persisted ? 'permanent' : 'session'
      return result
    }
    const images = files.filter((f) => isImage(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    if (images.length) {
      const titleBase = images[0].webkitRelativePath?.split('/')[0] || '未命名漫画'
      const cover = await makeCoverFor('images', images)
      const relativePages = images.map((file) => file.webkitRelativePath || file.name)
      const sourceKey = makeSourceKey(relativePages[0] || titleBase, images.reduce((sum, file) => sum + file.size, 0), Math.max(...images.map((file) => file.lastModified)), relativePages)
      const existing = existingBrowserComic(sourceKey, relativePages, images)
      if (alreadySaved(existing)) {
        result.skipped.push({ name: titleBase, reason: '同一来源已在书库中' })
        return result
      }
      const comic = await addOrRestoreBrowserComic({
        title: titleBase,
        format: 'images',
        cover,
        sourceKey,
        source: { type: 'web-cache', files: images, filePaths: relativePages, status: 'available' },
        totalPages: images.length,
        tags: ['images'],
      }, existing)
      const persisted = await saveBrowserImport(comic, images)
      result.added.push(comic)
      result.durability = persisted ? 'permanent' : 'session'
      return result
    }
    result.failed.push({ name: files[0]?.name || '所选内容', reason: '没有找到受支持的图片、PDF 或压缩包', retryable: true })
    result.durability = 'failed'
    return result
  }

  // ---- Import a comic archive (CBZ / CBR) ----
  async function importArchive(file: File): Promise<ImportResult> {
    const result = emptyResult()
    if (!archiveSupported(file.name)) {
      result.failed.push({ name: file.name, reason: '暂不支持该格式，仅支持 CBZ/ZIP 和 CBR/RAR', retryable: false })
      result.durability = 'failed'
      return result
    }
    if (file.size > 500 * 1024 * 1024) {
      result.failed.push({ name: file.name, reason: '压缩包超过 500MB。请在桌面版使用“导入 → 选择本机文件”，以按页读取，避免整包占用内存。', retryable: true })
      result.durability = 'failed'
      return result
    }
    const sourceKey = makeSourceKey(file.webkitRelativePath || file.name, file.size, file.lastModified)
    const existing = existingBrowserComic(sourceKey)
    if (alreadySaved(existing)) {
      result.skipped.push({ name: file.name, reason: '同一来源已在书库中' })
      return result
    }
    let images: File[]
    try {
      const buf = await file.arrayBuffer()
      images = await extractArchiveImages(buf, file.name)
    } catch (e: any) {
      console.error('[archive] 解压失败:', e)
      result.failed.push({ name: file.name, reason: e?.message || '压缩包损坏或无法读取', retryable: true })
      result.durability = 'failed'
      return result
    }
    if (!images.length) {
      result.failed.push({ name: file.name, reason: '压缩包内没有找到图片', retryable: false })
      result.durability = 'failed'
      return result
    }
    const title = file.name.replace(/\.(cbz|cbr|zip|rar)$/i, '')
    const cover = await makeCoverFor('images', images)
    const comic = await addOrRestoreBrowserComic({
      title,
      format: 'images',
      cover,
      sourceKey,
      source: { type: 'web-cache', files: images, status: 'available' },
      totalPages: images.length,
      tags: ['images'],
    }, existing)
    archiveCacheSet(comic.id, images)
    // 只持久化原始压缩包一个文件(非解压后的全部图片), 刷新时 resolveFiles 再解压, 省 IndexedDB 空间
    const persisted = await saveBrowserImport(comic, images, file)
    result.added.push(comic)
    result.durability = persisted ? 'permanent' : 'session'
    return result
  }

  // ---- Batch import a folder (recursive via webkitdirectory) ----
  async function batchImportFromInput(fileList: FileList): Promise<ImportResult> {
    const result = emptyResult()
    const persistence: boolean[] = []
    const files = Array.from(fileList)

    // 1) 归档文件 -> 每本一个漫画
    const archives = files.filter((f) => isArchive(f.name))
    for (const ar of archives) {
      if (!archiveSupported(ar.name)) {
        result.failed.push({ name: ar.name, reason: '不支持的压缩格式', retryable: false })
        continue
      }
      const dk = makeSourceKey(ar.webkitRelativePath || ar.name, ar.size, ar.lastModified)
      const existing = existingBrowserComic(dk)
      if (alreadySaved(existing)) {
        result.skipped.push({ name: ar.name, reason: '同一来源已在书库中' })
        continue
      }
      try {
        const imgs = await extractArchiveImages(await ar.arrayBuffer(), ar.name)
        if (!imgs.length) continue
        const title = ar.name.replace(/\.(cbz|cbr|zip|rar)$/i, '')
        const cover = await makeCover(imgs[0])
        const comic = await addOrRestoreBrowserComic({
          title,
          format: 'images',
          cover,
          sourceKey: dk,
          source: { type: 'web-cache', files: imgs, status: 'available' },
          totalPages: imgs.length,
          tags: ['images'],
        }, existing)
        archiveCacheSet(comic.id, imgs)
        // 只持久化原始压缩包一个文件, 刷新时再解压, 省 IndexedDB 空间
        const archived = await saveBrowserImport(comic, imgs, ar)
        persistence.push(archived)
        result.added.push(comic)
      } catch (e: any) {
        console.error('[archive] 批量解压失败:', ar.name, e)
        result.failed.push({ name: ar.name, reason: e?.message || '压缩包损坏或无法读取', retryable: true })
      }
    }

    // 2) 其余（图片 / 单文件）按原有逻辑建库
    const books = groupInputBooks(files.filter((file) => !isArchive(file.name)))
    for (const b of books) {
      const dk = makeSourceKey(b.sourcePath, b.files.reduce((sum, file) => sum + file.size, 0), Math.max(...b.files.map((file) => file.lastModified)), b.files.map((file) => file.webkitRelativePath || file.name))
      const filePaths = b.files.map((file) => file.webkitRelativePath || file.name)
      const existing = existingBrowserComic(dk, filePaths, b.files)
      if (alreadySaved(existing)) {
        result.skipped.push({ name: b.title, reason: '同一来源已在书库中' })
        continue
      }
      const cover = await makeCoverFor(b.format as ComicFormat, b.files)
      const comic = await addOrRestoreBrowserComic({
        title: b.title,
        format: b.format,
        cover,
        sourceKey: dk,
        source: {
          type: 'web-cache',
          files: b.files,
          filePaths,
          status: 'available',
        },
        totalPages: b.format === 'images' ? b.files.length : undefined,
        tags: [b.format],
      }, existing)
      persistence.push(await saveBrowserImport(comic, b.files))
      result.added.push(comic)
    }
    result.durability = result.failed.length && !result.added.length ? 'failed' : durabilityFor(persistence)
    return result
  }

  async function importNativeCandidate(candidate: NativeBookCandidate, result: ImportResult) {
    const sourceKey = makeSourceKey(candidate.sourcePath, candidate.size, candidate.modified, candidate.paths)
    if (comics.value.some((comic) => comic.sourceKey === sourceKey)) {
      result.skipped.push({ name: candidate.title, reason: '同一来源已在书库中' })
      return
    }
    try {
      if (candidate.kind === 'images') {
        const coverFile = await readNativeAsFile(candidate.paths[0], mimeForImage(candidate.paths[0]))
        const comic = await addComic({
          title: candidate.title,
          format: 'images',
          cover: await makeCover(coverFile),
          sourceKey,
          sourceId: makeSourceId(candidate.sourcePath),
          contentSignature: makeContentSignature(candidate.size, candidate.modified, candidate.paths),
          source: { type: 'native-dir', rootPath: candidate.sourcePath, pagePaths: candidate.paths, signature: sourceKey, status: 'available' },
          totalPages: candidate.paths.length,
          tags: ['images'],
        })
        result.added.push(comic)
        return
      }
      if (candidate.kind === 'pdf') {
        const resources = await openNativeReaderSource(candidate.sourcePath)
        let cover: string | undefined
        try {
          const { pdfCover } = await import('../utils/pdfCover')
          cover = resources[0]?.kind === 'native-resource' ? await pdfCover(resources[0].url) : undefined
        } finally {
          await closeNativeReaderFiles(resources)
        }
        const comic = await addComic({
          title: candidate.title,
          format: 'pdf',
          cover,
          sourceKey,
          sourceId: makeSourceId(candidate.sourcePath),
          contentSignature: makeContentSignature(candidate.size, candidate.modified, candidate.paths),
          source: { type: 'native-file', path: candidate.sourcePath, signature: sourceKey, status: 'available' },
          tags: ['pdf'],
        })
        result.added.push(comic)
      } else {
        const resources = await openNativeReaderSource(candidate.sourcePath)
        try {
          if (!resources.length) throw new Error('压缩包内没有图片')
          const first = resources[0]
          if (first.kind !== 'native-resource') throw new Error('无法建立原生压缩包会话')
          const coverFile = new File([await (await fetch(first.url)).blob()], first.name, { type: first.type })
          const comic = await addComic({
            title: candidate.title,
            format: 'images',
            cover: await makeCover(coverFile),
            sourceKey,
            sourceId: makeSourceId(candidate.sourcePath),
            contentSignature: makeContentSignature(candidate.size, candidate.modified, candidate.paths),
            source: { type: 'native-file', path: candidate.sourcePath, signature: sourceKey, status: 'available' },
            totalPages: resources.length,
            tags: ['images'],
          })
          result.added.push(comic)
        } finally {
          await closeNativeReaderFiles(resources)
        }
      }
    } catch (error: any) {
      result.failed.push({ name: candidate.title, reason: error?.message || '无法读取原文件', retryable: true })
    }
  }

  async function importNativeDirectory(): Promise<ImportResult> {
    if (!nativeAvailable()) return emptyResult()
    const root = await pickNativeDirectory()
    if (!root) return emptyResult()
    return importNativeRoot(root)
  }

  async function importNativeRoot(root: string): Promise<ImportResult> {
    const result = emptyResult()
    scanning.value = true
    try {
      for (const candidate of await scanNativeDirectory(root)) await importNativeCandidate(candidate, result)
      result.durability = result.failed.length && !result.added.length ? 'failed' : 'permanent'
      return result
    } finally {
      scanning.value = false
    }
  }

  async function importNativeFiles(): Promise<ImportResult> {
    return importNativePaths(await pickNativeFiles())
  }

  async function importNativePaths(paths: string[]): Promise<ImportResult> {
    const result = emptyResult()
    for (const path of paths) {
      // 拖入/启动参数可能是目录: 交给目录扫描(递归收集图片目录与压缩包/PDF), 而不是当作单文件读取
      if (await isNativeDirectory(path)) {
        const sub = await importNativeRoot(path)
        result.added.push(...sub.added)
        result.skipped.push(...sub.skipped)
        result.failed.push(...sub.failed)
        continue
      }
      const info = await nativeFileInfo(path)
      await importNativeCandidate({
        rootPath: path,
        sourcePath: path,
        title: info.name.replace(/\.(pdf|cbz|zip|cbr|rar)$/i, ''),
        kind: /\.pdf$/i.test(info.name) ? 'pdf' : 'archive',
        paths: [path],
        size: info.size,
        modified: info.modified,
      }, result)
    }
    result.durability = result.failed.length && !result.added.length ? 'failed' : 'permanent'
    return result
  }

  async function previewNativeRescan(id: string) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic || comic.source.type !== 'native-dir' || !comic.source.rootPath) throw new Error('只有本机图片目录可以重新扫描。')
    const candidates = await scanNativeDirectory(comic.source.rootPath)
    const candidate = candidates.find((item) => item.sourcePath.toLocaleLowerCase() === comic.source.rootPath!.toLocaleLowerCase())
    if (!candidate) throw new Error('原目录不存在或已不再包含图片。')
    const before = comic.source.pagePaths || []
    const beforeSet = new Set(before.map((path) => path.toLocaleLowerCase()))
    const afterSet = new Set(candidate.paths.map((path) => path.toLocaleLowerCase()))
    return {
      candidate,
      added: candidate.paths.filter((path) => !beforeSet.has(path.toLocaleLowerCase())),
      removed: before.filter((path) => !afterSet.has(path.toLocaleLowerCase())),
    }
  }

  async function applyNativeRescan(id: string, candidate: NativeBookCandidate) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic || comic.source.type !== 'native-dir') return
    comic.source.pagePaths = candidate.paths
    comic.source.status = 'available'
    comic.totalPages = candidate.paths.length
    comic.lastPosition = Math.min(comic.lastPosition, Math.max(0, candidate.paths.length - 1))
    comic.sourceKey = makeSourceKey(candidate.sourcePath, candidate.size, candidate.modified, candidate.paths)
    comic.sourceId = makeSourceId(candidate.sourcePath)
    comic.contentSignature = makeContentSignature(candidate.size, candidate.modified, candidate.paths)
    comic.source.signature = comic.sourceKey
    session.delete(id)
    await safePut(comic)
  }

  async function relinkSource(id: string) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic) return false
    if (comic.source.type === 'native-dir') {
      const root = await pickNativeDirectory()
      if (!root) return false
      const candidates = await scanNativeDirectory(root)
      const oldNames = (comic.source.pagePaths || []).map((path) => path.split(/[\\/]/).pop() || '').sort(naturalCompare)
      const candidate = candidates.find((item) => {
        if (item.kind !== 'images' || item.paths.length !== oldNames.length) return false
        const names = item.paths.map((path) => path.split(/[\\/]/).pop() || '').sort(naturalCompare)
        return names.every((name, index) => name === oldNames[index])
      })
      if (!candidate) throw new Error('所选目录与原书页清单不匹配，未进行关联。')
      comic.source.rootPath = candidate.sourcePath
      comic.source.pagePaths = candidate.paths
      comic.sourceKey = makeSourceKey(candidate.sourcePath, candidate.size, candidate.modified, candidate.paths)
      comic.sourceId = makeSourceId(candidate.sourcePath)
      comic.contentSignature = makeContentSignature(candidate.size, candidate.modified, candidate.paths)
      comic.source.signature = comic.sourceKey
      comic.source.status = 'available'
      await safePut(comic)
      return true
    }
    if (comic.source.type === 'native-file') {
      const paths = await pickNativeFiles()
      const expectedName = comic.source.path?.split(/[\\/]/).pop()?.toLocaleLowerCase()
      const path = paths.find((item) => item.split(/[\\/]/).pop()?.toLocaleLowerCase() === expectedName)
      if (!path) throw new Error('文件名与原书来源不匹配，未进行关联。')
      const info = await nativeFileInfo(path)
      if (comic.format === 'images') {
        const pages = await openNativeReaderSource(path)
        try {
          if (comic.totalPages && pages.length !== comic.totalPages) throw new Error('压缩包页数与原书不匹配，未进行关联。')
        } finally {
          await closeNativeReaderFiles(pages)
        }
      }
      comic.source.path = path
      comic.sourceKey = makeSourceKey(path, info.size, info.modified)
      comic.sourceId = makeSourceId(path)
      comic.contentSignature = makeContentSignature(info.size, info.modified, [path])
      comic.source.signature = comic.sourceKey
      comic.source.status = 'available'
      await safePut(comic)
      return true
    }
    throw new Error('旧版浏览器来源需要在打开书目时重新授权。')
  }

  // ---- FSA single directory (images) ----
  async function importFSADirectory(): Promise<ImportResult> {
    const result = emptyResult()
    // @ts-ignore
    const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker()
    const handles: FileSystemFileHandle[] = []
    for await (const [, h] of (handle as any).entries()) {
      if (h.kind === 'file' && isImage(h.name)) handles.push(h)
    }
    handles.sort(byName)
    if (!handles.length) {
      result.failed.push({ name: handle.name, reason: '目录中没有找到受支持的图片', retryable: true })
      result.durability = 'failed'
      return result
    }
    const pageNames = handles.map((page) => page.name)
    const sourceKey = makeSourceKey(handle.name, 0, 0, pageNames)
    if (comics.value.some((comic) => comic.sourceKey === sourceKey)) {
      result.skipped.push({ name: handle.name, reason: '同一来源已在书库中' })
      result.durability = 'session'
      return result
    }
    // Only the cover is materialized during import. Every other page stays as a handle
    // until the reader's bounded window requests it.
    const cover = await makeCover(await handles[0].getFile())
    const source: ComicSource = {
      type: 'fsa-dir',
      dirHandle: handle,
      dirPath: handle.name,
      filePaths: pageNames,
      signature: sourceKey,
      status: 'available',
    }
    const comic = await addComic({ title: handle.name, format: 'images', cover, sourceKey, source, totalPages: handles.length, tags: ['images'] })
    result.added.push(comic)
    result.durability = 'session'
    return result
  }

  // ---- Recursive scan (Tauri / File System Access) - builds local library ----
  async function importScanDirectory(): Promise<number> {
    // @ts-ignore
    const root: FileSystemDirectoryHandle = await window.showDirectoryPicker()
    scanning.value = true
    try {
      const books = new Map<string, { format: ComicFormat; title: string; handles: FileSystemFileHandle[] }>()
      const walk = async function* (dir: any, prefix: string): AsyncGenerator<{ name: string; path: string; handle: FileSystemFileHandle }> {
        for await (const [name, h] of dir.entries()) {
          const p = prefix ? prefix + '/' + name : name
          if (h.kind === 'directory') yield* walk(h, p)
          else if (h.kind === 'file') yield { name, path: p, handle: h }
        }
      }
      for await (const f of walk(root, root.name)) {
        const fmt = classify(f.name)
        if (!fmt || fmt === 'image') {
          if (fmt !== 'image') continue
          const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : root.name
          const key = 'img:' + parent
          if (!books.has(key)) books.set(key, { format: 'images', title: parent.split('/').pop() || root.name, handles: [] })
          books.get(key)!.handles.push(f.handle)
        } else {
          const key = 'file:' + f.path
          if (!books.has(key)) books.set(key, { format: fmt as ComicFormat, title: f.name.replace(SINGLE_RE, ''), handles: [f.handle] })
        }
      }
      const existing = new Set(comics.value.map((c) => c.title + '|' + c.format))
      let added = 0
      for (const b of books.values()) {
        if (b.format === 'images') b.handles.sort(byName)
        const dk = b.title + '|' + b.format
        if (existing.has(dk)) continue
        const cover = b.handles.length ? await makeCover(await b.handles[0].getFile()) : undefined
        await addComic({
          title: b.title,
          format: b.format,
          cover,
          source: { type: 'fsa-file', fileHandles: b.handles },
          totalPages: b.format === 'images' ? b.handles.length : undefined,
          tags: [b.format],
        })
        existing.add(dk)
        added++
      }
      return added
    } finally {
      scanning.value = false
    }
  }

  // Resolve concrete files for a comic (re-opening)
  async function markReadable(comic: Comic) {
    if (comic.source.status !== 'available' && comic.source.status !== 'content-changed') {
      comic.source.status = 'available'
      await safePut(comic)
    }
  }

  async function resolveFiles(comic: Comic): Promise<ReaderFile[]> {
    const s = comic.source
    if (s.type === 'native-dir') {
      if (!s.rootPath || !s.pagePaths?.length) throw new Error('目录来源信息不完整，请重新关联。')
      try { await nativeFileInfo(s.pagePaths[0]) } catch {
        s.status = 'missing'
        await safePut(comic)
        throw new Error('原图片目录已移动或文件缺失，请在书目管理中重新关联。')
      }
      const files = await openNativeReaderSource(s.rootPath, s.pagePaths)
      await markReadable(comic)
      return files
    }
    if (s.type === 'native-file') {
      if (!s.path) throw new Error('文件来源信息不完整，请重新关联。')
      try { await nativeFileInfo(s.path) } catch {
        s.status = 'missing'
        await safePut(comic)
        throw new Error('原文件已移动或缺失，请在书目管理中重新关联。')
      }
      const files = await openNativeReaderSource(s.path)
      await markReadable(comic)
      return files
    }
    if (s.type === 'input' || s.type === 'web-cache') {
      const mem = sessionGet(comic.id)
      if (mem && mem.length) {
        await markReadable(comic)
        return fileReaderSources(mem)
      }
      // 刷新后内存 session 已丢失 -> 从 IndexedDB 还原字节重建 File, 漫画仍可重开
      try {
        const rec = await db.blobs.get(comic.id)
        if (rec?.pages?.length) {
          await markReadable(comic)
          return rec.pages.map((page, pageIndex) => ({ kind: 'cached-page', ...page, comicId: comic.id, pageIndex }))
        }
        // 压缩包: 还原原始压缩包字节后按需解压(比存全部图片省空间)
        // #2: 解压结果入内存缓存, 同会话内重复打开不再重解(刷新后首开仍解一次, 为省 IndexedDB 空间设计如此)
        if (rec?.archive) {
          let imgs = archiveCacheGet(comic.id)
          if (!imgs) {
            imgs = await extractArchiveImages(rec.archive.data, rec.archive.name)
            if (imgs.length) archiveCacheSet(comic.id, imgs)
          }
          if (imgs.length) {
            sessionSet(comic.id, imgs)
            await markReadable(comic)
            return fileReaderSources(imgs)
          }
        }
        if (rec?.files?.length) {
          const restored = rec.files.map((f) => new File([f.data], f.name, { type: f.type }))
          sessionSet(comic.id, restored)
          await markReadable(comic)
          return fileReaderSources(restored)
        }
      } catch {
        /* 还原失败则回退到内存 files */
      }
      if (s.files?.length) {
        await markReadable(comic)
        return fileReaderSources(s.files)
      }
      s.status = 'missing'
      await safePut(comic)
      return []
    }
    // 句柄因缺少持久权限未被持久化 -> 重新向用户请求目录/文件权限
    if (s.type === 'fsa-dir') {
      // #1: 复用会话内已解析结果, 避免每次打开都 getFile() 物化整本(文件夹图片多时尤甚)
      const cached = sessionGet(comic.id)
      if (cached && cached.length) return fileReaderSources(cached)
      const describe = async (handle: any): Promise<FileSystemFileHandle[]> => {
        const out: FileSystemFileHandle[] = []
        for await (const [, h] of handle.entries()) {
          if (h.kind === 'file' && isImage(h.name)) out.push(h)
        }
        out.sort(byName)
        return out
      }
      if (!s.dirHandle) {
        try {
          // @ts-ignore
          const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker()
          const handles = await describe(handle)
          const expectedNames = [...(s.filePaths || [])].sort(naturalCompare)
          const actualNames = handles.map((page) => page.name).sort(naturalCompare)
          if (
            (s.dirPath && handle.name !== s.dirPath)
            || (comic.totalPages && handles.length !== comic.totalPages)
            || (expectedNames.length && expectedNames.some((name, index) => name !== actualNames[index]))
          ) {
            throw new Error(`所选目录与原书来源不匹配。应为“${s.dirPath || comic.title}”，共 ${comic.totalPages || '未知'} 页。`)
          }
          s.dirHandle = handle
          await markReadable(comic)
          return handleReaderSources(handles)
        } catch (error: any) {
          if (error?.message?.includes('不匹配')) throw error
          return []
        }
      }
      const files = handleReaderSources(await describe(s.dirHandle))
      if (files.length) await markReadable(comic)
      return files
    }
    if (s.type === 'fsa-file') {
      // #1: 同上, 缓存解析结果
      const cached = sessionGet(comic.id)
      if (cached && cached.length) return fileReaderSources(cached)
      if (!s.fileHandles || !s.fileHandles.length) {
        try {
          // @ts-ignore
          const handles: FileSystemFileHandle[] = await window.showOpenFilePicker({ multiple: true })
          handles.sort(byName)
          const expected = [...(s.filePaths || [])].sort(naturalCompare)
          const actual = handles.map((handle) => handle.name).sort(naturalCompare)
          if (expected.length && (expected.length !== actual.length || expected.some((name, index) => name !== actual[index]))) {
            throw new Error(`所选文件与原书来源不匹配，需要选择原来的 ${expected.length} 个文件。`)
          }
          s.fileHandles = handles
          await markReadable(comic)
          return handleReaderSources(handles)
        } catch (error: any) {
          if (error?.message?.includes('不匹配')) throw error
          return []
        }
      }
      await markReadable(comic)
      return handleReaderSources([...s.fileHandles].sort(byName))
    }
    return fileReaderSources(s.files || [])
  }

  // ---- Batch delete / clear shelf ----
  async function removeComics(ids: string[]) {
    for (const id of ids) await removeComic(id)
  }
  async function deleteSourceFiles(id: string) {
    const comic = comics.value.find((item) => item.id === id)
    if (!comic) return
    const source = comic.source
    if (source.type === 'native-file' && source.path) {
      await removeNativeFile(source.path)
    } else if (source.type === 'native-dir' && source.pagePaths?.length) {
      // Delete only the explicit page files belonging to this book; never recurse into the directory.
      for (const path of source.pagePaths) await removeNativeFile(path)
    } else {
      throw new Error('此来源不能由 MangaReader 删除。')
    }
    await removeComic(id)
  }
  async function clearAll() {
    await clearAllTranslations()
    await clearNativeReaderCache().catch(() => undefined)
    await db.comics.clear()
    await db.bookmarks.clear()
    try { await db.blobs.clear() } catch { /* ignore */ }
    await clearBrowserPages().catch(() => undefined)
    try { await db.covers.clear() } catch { /* ignore */ }
    try { await db.readingSessions.clear() } catch { /* ignore */ }
    for (const cover of coverUrls.values()) URL.revokeObjectURL(cover.url)
    coverUrls.clear()
    session.clear()
    archiveCache.clear()
    restorableIds.clear()
    comics.value = []
    bookmarks.value = []
  }

  async function exportMetadata() {
    const exportedComics = await Promise.all(comics.value.map(async (comic) => ({
      ...toPersistable(comic),
      cover: await coverDataUrl(comic),
    })))
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      app: 'MangaReader',
      comics: exportedComics,
      bookmarks: bookmarks.value.map((bookmark) => ({ ...bookmark })),
    }
  }

  async function restoreMetadata(input: unknown): Promise<{ comics: number; bookmarks: number }> {
    const data = input as { schemaVersion?: number; comics?: Comic[]; bookmarks?: Bookmark[] }
    if (![1, 2].includes(data?.schemaVersion || 0) || !Array.isArray(data.comics) || !Array.isArray(data.bookmarks)) {
      throw new Error('备份文件格式无效或版本不受支持。')
    }
    const restoredComics = data.comics.map((comic) => {
      // 备份文件可能来自旧版本或手工编辑, 缺 source 字段时不能直接读 comic.source.type(会抛错)
      const source = (comic.source && typeof comic.source === 'object' ? comic.source : { type: 'web-cache' as const, files: [] }) as Comic['source']
      return {
        ...comic,
        tags: Array.isArray(comic.tags) ? comic.tags : [],
        fit: comic.fit || 'width',
        sourceKey: comic.sourceKey || makeSourceKey(`${comic.title}|${comic.format}|${comic.id}`),
        source: {
          ...source,
          status: source.type === 'native-dir' || source.type === 'native-file' ? source.status : 'migration-required' as const,
        },
      }
    })
    await db.transaction('rw', db.comics, db.bookmarks, db.covers, async () => {
      for (const comic of restoredComics) await safePut(comic)
      await db.bookmarks.bulkPut(data.bookmarks!)
    })
    await load()
    return { comics: restoredComics.length, bookmarks: data.bookmarks.length }
  }

  return {
    comics, bookmarks, query, activeTag, shelfFilter, sortMode, filtered, allTags, recent, scanning,
    load, addComic, updateComic, updateComics, resetProgress, toggleFavorite, markSourcesChanged, beginReadingSession, finishReadingSession, removeComic, removeComics, deleteSourceFiles, clearAll, touch, addTag, setPageMode, setPageDir, setFitMode, setReadMode, setSpreadOffset, setAutoSpread, setRotation, setAutoCrop, addBookmark, updateBookmark, removeBookmark, bookmarksFor, readingStats,
    importInputFiles, batchImportFromInput, importArchive, relinkBrowserFiles, importNativeFiles, importNativePaths, importNativeDirectory, importNativeRoot, previewNativeRescan, applyNativeRescan, relinkSource, importFSADirectory, importScanDirectory, resolveFiles,
    exportMetadata, restoreMetadata, acquireCoverUrl, releaseCoverUrl, coverDataUrl,
  }
})
