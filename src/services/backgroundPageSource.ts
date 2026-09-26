import { readFile } from '@tauri-apps/plugin-fs'
import type { Comic, ReaderFile } from '../types'
import type { TranslationRect } from '../types/translation'
import { closeNativeReaderFiles } from './nativeReader'
import { readBrowserPage } from './browserPageCache'
import { autoCropFileToUrl } from '../utils/autoCrop'
import { encodeTranslationFrame, frameFromBlob, throwIfAborted } from '../utils/translationImage'

export async function readerFileBlob(file: ReaderFile, signal: AbortSignal): Promise<Blob> {
  throwIfAborted(signal)
  if (file.kind === 'file') return file.file
  if (file.kind === 'cached-page') return readBrowserPage(file.comicId, file.pageIndex)
  if (file.kind === 'fsa-handle') return file.handle.getFile()
  if (file.kind === 'native-path') return new Blob([await readFile(file.path)], { type: file.type })
  const response = await fetch(file.documentUrl || file.url, { signal })
  if (!response.ok) throw new Error('原文件读取失败，请重新关联漫画。')
  return response.blob()
}
/** Owns its source session independently from the visible reader. */
export function backgroundPageSource(comic: Comic, files: ReaderFile[]) {
  let pdf: any = null, pdfTask: any = null, renderTask: any = null, closed = false
  return {
    async capture(page: number, signal: AbortSignal, region?: TranslationRect) {
      throwIfAborted(signal)
      if (closed) throw new Error('页面来源已关闭。')
      if (comic.format !== 'pdf') {
        const source = files[page]
        if (!source) throw new Error('页码超出范围。')
        let blob = await readerFileBlob(source, signal)
        let cropped: string | undefined
        try {
          if (comic.autoCrop) { cropped = await autoCropFileToUrl(new File([blob], source.name, { type: blob.type })); blob = await (await fetch(cropped, { signal })).blob() }
          return await frameFromBlob(blob, signal, region)
        } finally { if (cropped) URL.revokeObjectURL(cropped) }
      }
      if (!pdf) {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
        const source = files[0]!
        const input = source.kind === 'native-resource' ? { url: source.documentUrl || source.url } : { data: await (await readerFileBlob(source, signal)).arrayBuffer() }
        throwIfAborted(signal)
        pdfTask = pdfjs.getDocument({ ...input, wasmUrl: import.meta.env.BASE_URL + 'pdfjs/wasm/', cMapUrl: import.meta.env.BASE_URL + 'pdfjs/cmaps/', cMapPacked: true })
        const abort = () => { void pdfTask.destroy() }
        signal.addEventListener('abort', abort, { once: true })
        try { pdf = await pdfTask.promise; throwIfAborted(signal) } finally { signal.removeEventListener('abort', abort) }
      }
      const pdfPage = await pdf.getPage(page + 1)
      throwIfAborted(signal)
      const base = pdfPage.getViewport({ scale: 1 })
      const viewport = pdfPage.getViewport({ scale: Math.min(3, 2200 / Math.max(base.width, base.height), Math.sqrt(4_000_000 / (base.width * base.height))) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height))
      renderTask = pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport })
      const abort = () => renderTask?.cancel()
      signal.addEventListener('abort', abort, { once: true })
      try { await renderTask.promise; throwIfAborted(signal); return encodeTranslationFrame(canvas, canvas.width, canvas.height, region) }
      finally { signal.removeEventListener('abort', abort); renderTask = null; canvas.width = 0; canvas.height = 0 }
    },
    async close() { closed = true; renderTask?.cancel(); await (pdf || pdfTask)?.destroy?.(); await closeNativeReaderFiles(files) },
  }
}
