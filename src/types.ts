export type ComicFormat = 'images' | 'pdf'

export type SourceType = 'native-dir' | 'native-file' | 'web-cache' | 'fsa-dir' | 'fsa-file' | 'input'

export type SourceStatus = 'available' | 'missing' | 'moved' | 'permission-required' | 'migration-required' | 'content-changed'

export interface ComicSource {
  type: SourceType
  /** Native desktop source. Paths are kept outside IndexedDB blobs and read on demand. */
  rootPath?: string
  path?: string
  pagePaths?: string[]
  signature?: string
  status?: SourceStatus
  // For File System Access API (Chromium / Tauri webview): persisted handles
  dirHandle?: FileSystemDirectoryHandle
  fileHandles?: FileSystemFileHandle[]
  // 句柄不可结构化克隆(缺少持久权限)时, 退化为只存路径, 重开时重新请求权限
  dirPath?: string
  filePaths?: string[]
  // For input fallback: re-imported files held in memory for the session
  files?: File[]
}

export interface Comic {
  id: string
  title: string
  format: ComicFormat
  cover?: string // dataURL
  addedAt: number
  lastReadAt: number
  lastPosition: number // page index for images/pdf
  totalPages?: number
  tags: string[]
  source: ComicSource
  /** Stable identity derived from the normalized source path and source metadata. */
  sourceKey?: string
  /** Stable normalized location identity, independent from mutable content. */
  sourceId?: string
  /** Signature of the current file/page manifest. */
  contentSignature?: string
  favorite?: boolean
  /** User-controlled series. When absent, the title-based grouping fallback is used. */
  series?: string
  pageMode?: 'single' | 'double' // 单页/双页阅读模式, 按漫画记忆
  pageDir?: 'ltr' | 'rtl' // 双页铺开方向: ltr 从左往右, rtl 从右往左(漫画), 按漫画记忆
  readMode?: 'page' | 'webtoon' // 阅读方式: page 翻页(单/双页), webtoon 竖向连续滚动(条漫)
  fit?: 'width' | 'height' | 'actual' // 翻页适应模式(宽/高/原大), 按漫画记忆
  spreadOffset?: 0 | 1
  /** 双页模式下自动识别跨页大图(横向宽页)并让其独占一摊 */
  autoSpread?: boolean
  rotation?: 0 | 90 | 180 | 270
  autoCrop?: boolean
}

export interface Bookmark {
  id: string
  comicId: string
  position: number
  label?: string
  createdAt: number
}

export type ImportDurability = 'permanent' | 'session' | 'failed'

export interface ImportFailure {
  name: string
  reason: string
  retryable: boolean
}

export interface ImportResult {
  added: Comic[]
  skipped: { name: string; reason: string }[]
  failed: ImportFailure[]
  durability: ImportDurability
}

export interface BrowserReaderFile {
  kind: 'file'
  name: string
  type: string
  file: File
}

export interface NativeReaderFile {
  kind: 'native-path'
  name: string
  type: string
  path: string
}

export interface FsaReaderFile {
  kind: 'fsa-handle'
  name: string
  type: string
  handle: FileSystemFileHandle
}

export interface CachedReaderFile {
  kind: 'cached-page'
  name: string
  type: string
  comicId: string
  pageIndex: number
}

export interface NativeResourceReaderFile {
  kind: 'native-resource'
  name: string
  type: string
  sourceToken: string
  pageIndex: number
  url: string
  thumbnailUrl: string
  size?: number
  documentUrl?: string
}

export type ReaderFile = BrowserReaderFile | NativeReaderFile | FsaReaderFile | NativeResourceReaderFile | CachedReaderFile

export type ResolvedReaderSource =
  | { kind: 'images'; files: ReaderFile[]; pagePaths?: string[] }
  | { kind: 'pdf'; files: ReaderFile[]; path?: string }

export type ThemeMode = 'light' | 'dark' | 'system'

export interface ReaderUiState {
  readMode: 'page' | 'webtoon'
  pageMode: 'single' | 'double'
  pageDir: 'ltr' | 'rtl'
  fit: 'width' | 'height' | 'actual'
  zoom: number
}

export interface ReaderController {
  next: () => void
  prev: () => void
  goTo: (page: number) => void
  zoom: (delta: number) => void
  toggleReadMode: () => void
  setMode: (mode: 'single' | 'double') => void
  setDir: (dir: 'ltr' | 'rtl') => void
  cycleFit: () => void
  capturePage: (pageIndex: number, signal: AbortSignal, region?: import('./types/translation').TranslationRect) => Promise<import('./types/translation').TranslationFrame>
  visiblePages: () => number[]
}

export interface ReadingSession {
  id: string
  comicId: string
  startedAt: number
  endedAt: number
  startPosition: number
  endPosition: number
}
