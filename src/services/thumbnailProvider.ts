import type { Comic, ReaderFile } from '../types'
import { readFile } from '@tauri-apps/plugin-fs'
import { readBrowserPage } from './browserPageCache'
import { abortError, createTaskQueue, waitWithSignal } from '../utils/taskQueue'

export interface ThumbnailProvider {
  get(page: number, signal: AbortSignal): Promise<string>
  retain?(pages: readonly number[]): void
  close(): void
}

const MAX_MEMORY_THUMBNAILS = 32

export function createThumbnailProvider(comic: Comic, files: ReaderFile[]): ThumbnailProvider {
  const urls = new Map<number, string>()
  const jobs = new Map<number, { promise: Promise<string>; control: AbortController }>()
  const queue = createTaskQueue(3)
  let retained = new Set<number>()
  let pdfPromise: Promise<any> | null = null
  let pdfTask: any = null
  let pdfDocument: any = null
  let closed = false

  function evict() {
    for (const [page, url] of urls) {
      if (urls.size <= Math.max(MAX_MEMORY_THUMBNAILS, retained.size)) break
      if (retained.has(page)) continue
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
      urls.delete(page)
    }
  }
  function check(signal: AbortSignal) {
    if (closed || signal.aborted) throw abortError()
  }
  function remember(page: number, url: string) {
    if (closed) { URL.revokeObjectURL(url); throw abortError() }
    const previous = urls.get(page)
    if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous)
    urls.delete(page)
    urls.set(page, url)
    evict()
    return url
  }

  async function sourceBlob(source: ReaderFile): Promise<Blob> {
    if (source.kind === 'file') return source.file
    if (source.kind === 'fsa-handle' || source.kind === 'cached-page') {
      const file = source.kind === 'cached-page' ? await readBrowserPage(source.comicId, source.pageIndex) : await source.handle.getFile()
      return file
    }
    if (source.kind === 'native-resource') {
      const response = await fetch(source.documentUrl || source.url)
      if (!response.ok) throw new Error('读取页面失败')
      return response.blob()
    }
    const bytes = await readFile(source.path)
    return new Blob([bytes], { type: source.type })
  }

  async function canvasUrl(page: number, canvas: HTMLCanvasElement, signal: AbortSignal) {
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('缩略图生成失败')), 'image/webp', 0.72))
    check(signal)
    return remember(page, URL.createObjectURL(blob))
  }
  async function imageThumbnail(page: number, signal: AbortSignal) {
    const source = files[page]
    if (!source) throw new Error('页面不存在')
    check(signal)
    if (source.kind === 'native-resource') return source.thumbnailUrl || source.url
    const blob = await sourceBlob(source)
    check(signal)
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    try {
      check(signal)
      const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return await canvasUrl(page, canvas, signal)
    } finally { bitmap.close(); canvas.width = 0; canvas.height = 0 }
  }

  async function getPdfDocument() {
    if (pdfDocument) return pdfDocument
    if (pdfPromise) return pdfPromise
    pdfPromise = (async () => {
    const pdfjs = await import('pdfjs-dist')
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    const source = files[0]
    if (!source) throw new Error('PDF 来源不存在')
    const input = source.kind === 'native-resource' ? { url: source.documentUrl || source.url } : { data: await (await sourceBlob(source)).arrayBuffer() }
    if (closed) throw abortError()
    const base = import.meta.env.BASE_URL
    pdfTask = pdfjs.getDocument({
      ...input,
      wasmUrl: base + 'pdfjs/wasm/',
      cMapUrl: base + 'pdfjs/cmaps/',
      cMapPacked: true,
    })
    pdfDocument = await pdfTask.promise
    if (closed) { await pdfDocument.destroy(); pdfDocument = null; throw abortError() }
    return pdfDocument
    })().catch(error => { pdfPromise = null; throw error })
    return pdfPromise
  }

  async function pdfThumbnail(page: number, signal: AbortSignal) {
    const document = await getPdfDocument()
    if (signal.aborted || closed) throw new DOMException('Aborted', 'AbortError')
    const pdfPage = await document.getPage(page + 1)
    const initial = pdfPage.getViewport({ scale: 1 })
    const viewport = pdfPage.getViewport({ scale: Math.min(1, 240 / Math.max(initial.width, initial.height)) })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const task = pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport })
    const abort = () => task.cancel()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await task.promise
      if (signal.aborted || closed) throw new DOMException('Aborted', 'AbortError')
      return await canvasUrl(page, canvas, signal)
    } finally {
      signal.removeEventListener('abort', abort)
      canvas.width = 0
      canvas.height = 0
    }
  }

  return {
    async get(page, signal) {
      check(signal)
      const cached = urls.get(page)
      if (cached) {
        urls.delete(page)
        urls.set(page, cached)
        return cached
      }
      let job = jobs.get(page)
      if (!job || job.control.signal.aborted) {
        const control = new AbortController()
        const promise = queue.run(() => comic.format === 'pdf' ? pdfThumbnail(page, control.signal) : imageThumbnail(page, control.signal), control.signal)
        job = { control, promise }
        jobs.set(page, job)
        const created = job
        void promise.finally(() => { if (jobs.get(page) === created) jobs.delete(page) }).catch(() => {})
      }
      return waitWithSignal(job.promise, signal)
    },
    retain(pages) {
      retained = new Set(pages)
      for (const [page, job] of jobs) if (!retained.has(page)) job.control.abort()
      evict()
    },
    close() {
      closed = true
      for (const job of jobs.values()) job.control.abort()
      jobs.clear()
      for (const url of urls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url)
      urls.clear()
      void (pdfDocument || pdfTask)?.destroy?.()
      pdfDocument = null
    },
  }
}
