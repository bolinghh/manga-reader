import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ReaderFile } from '../types'

interface NativePageMeta {
  index: number
  name: string
  mime: string
  size: number
}

interface NativeReaderSession {
  token: string
  kind: 'images' | 'archive' | 'pdf'
  pages: NativePageMeta[]
  documentUrl?: string
}

export interface NativeCacheStats {
  bytes: number
  files: number
  limitBytes: number
}

export interface NativeSourceChange {
  root: string
  paths: string[]
}

function resourceOrigin() {
  return /Windows|Android/i.test(navigator.userAgent)
    ? 'http://manga-resource.localhost'
    : 'manga-resource://localhost'
}

function resourceUrl(token: string, variant: 'page' | 'thumb' | 'document', index?: number) {
  const suffix = index === undefined ? '' : `/${index}`
  return `${resourceOrigin()}/${token}/${variant}${suffix}`
}

export async function openNativeReaderSource(path: string, pagePaths?: string[]): Promise<ReaderFile[]> {
  if (!isTauri()) return []
  const session = await invoke<NativeReaderSession>('open_reader_source', { path, pagePaths })
  if (session.kind === 'pdf') {
    const documentUrl = session.documentUrl || resourceUrl(session.token, 'document')
    return [{
      kind: 'native-resource',
      name: path.split(/[\\/]/).pop() || path,
      type: 'application/pdf',
      sourceToken: session.token,
      pageIndex: 0,
      url: documentUrl,
      thumbnailUrl: '',
      documentUrl,
    }]
  }
  return session.pages.map((page) => ({
    kind: 'native-resource',
    name: page.name,
    type: page.mime,
    size: page.size,
    sourceToken: session.token,
    pageIndex: page.index,
    url: resourceUrl(session.token, 'page', page.index),
    thumbnailUrl: resourceUrl(session.token, 'thumb', page.index),
  }))
}

export async function closeNativeReaderFiles(files: ReaderFile[]) {
  if (!isTauri()) return
  const tokens = new Set(files.filter((file) => file.kind === 'native-resource').map((file) => file.sourceToken))
  await Promise.all([...tokens].map((token) => invoke('close_reader_source', { token }).catch(() => undefined)))
}

export async function getNativeCacheStats(): Promise<NativeCacheStats> {
  if (!isTauri()) return { bytes: 0, files: 0, limitBytes: 0 }
  return invoke<NativeCacheStats>('get_cache_stats')
}

export async function clearNativeReaderCache(scope?: string) {
  if (isTauri()) await invoke('clear_reader_cache', { scope })
}

export async function watchNativeLibraryRoot(path: string) {
  if (isTauri()) await invoke('watch_library_root', { path })
}

export async function unwatchNativeLibraryRoot(path: string) {
  if (isTauri()) await invoke('unwatch_library_root', { path })
}

export async function listenNativeSourceChanges(callback: (change: NativeSourceChange) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  return listen<NativeSourceChange>('library-source-change', (event) => callback(event.payload))
}
