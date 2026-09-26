import { isTauri } from '@tauri-apps/api/core'
import { basename, dirname, join } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { readDir, readFile, stat } from '@tauri-apps/plugin-fs'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { ARCHIVE_RE, IMAGE_RE, naturalCompare } from '../utils/library'

export const nativeAvailable = () => isTauri()

export async function pickNativeFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: '漫画', extensions: ['pdf', 'cbz', 'zip', 'cbr', 'rar'] }],
  })
  if (!selected) return []
  return Array.isArray(selected) ? selected : [selected]
}

export async function pickNativeDirectory(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: true })
  return typeof selected === 'string' ? selected : null
}

export interface NativeBookCandidate {
  rootPath: string
  sourcePath: string
  title: string
  kind: 'images' | 'pdf' | 'archive'
  paths: string[]
  size: number
  modified: number
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index])
    }
  }
  const count = Math.min(Math.max(1, limit), items.length)
  await Promise.all(Array.from({ length: count }, worker))
  return results
}

async function walk(rootPath: string, currentPath: string, out: string[]) {
  const entries = await readDir(currentPath)
  for (const entry of entries) {
    const path = await join(currentPath, entry.name)
    if (entry.isDirectory) await walk(rootPath, path, out)
    else if (entry.isFile) out.push(path)
  }
}

export async function scanNativeDirectory(rootPath: string): Promise<NativeBookCandidate[]> {
  const paths: string[] = []
  await walk(rootPath, rootPath, paths)
  const imageGroups = new Map<string, string[]>()
  const candidates: NativeBookCandidate[] = []
  for (const path of paths) {
    const name = await basename(path)
    if (IMAGE_RE.test(name)) {
      const parent = await dirname(path)
      const list = imageGroups.get(parent) || []
      list.push(path)
      imageGroups.set(parent, list)
    } else if (/\.pdf$/i.test(name) || ARCHIVE_RE.test(name)) {
      const info = await stat(path)
      candidates.push({
        rootPath,
        sourcePath: path,
        title: name.replace(/\.(pdf|cbz|zip|cbr|rar)$/i, ''),
        kind: /\.pdf$/i.test(name) ? 'pdf' : 'archive',
        paths: [path],
        size: info.size,
        modified: info.mtime?.getTime() || 0,
      })
    }
  }
  for (const [parent, pagePaths] of imageGroups) {
    pagePaths.sort(naturalCompare)
    const infos = await mapWithConcurrency(pagePaths, 16, (path) => stat(path))
    candidates.push({
      rootPath,
      sourcePath: parent,
      title: await basename(parent),
      kind: 'images',
      paths: pagePaths,
      size: infos.reduce((sum, info) => sum + info.size, 0),
      modified: Math.max(...infos.map((info) => info.mtime?.getTime() || 0)),
    })
  }
  return candidates.sort((a, b) => naturalCompare(a.sourcePath, b.sourcePath))
}

export async function readNativeAsFile(path: string, type = 'application/octet-stream'): Promise<File> {
  const bytes = await readFile(path)
  const name = await basename(path)
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new File([data], name, { type })
}

export async function nativeFileInfo(path: string) {
  const info = await stat(path)
  return { name: await basename(path), size: info.size, modified: info.mtime?.getTime() || 0 }
}

// 拖入/启动参数里既可能是文件也可能是目录; 用于 importNativePaths 路由到目录扫描。
export async function isNativeDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return !!info.isDirectory
  } catch {
    return false
  }
}

export async function listenNativeDrops(callback: (paths: string[]) => void) {
  if (!nativeAvailable()) return () => {}
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') callback(event.payload.paths)
  })
}
