import { createTaskQueue } from '../utils/taskQueue'
export const isArchive = (name: string) => /\.(cbz|cbr|zip|rar)$/i.test(name)
export const archiveSupported = isArchive
const queue = createTaskQueue(1)
/** Decompression consumes the supplied buffer off the UI thread, one archive at a time. */
export async function extractArchiveImages(data: ArrayBuffer, name: string): Promise<File[]> {
  if (data.byteLength > 500 * 1024 * 1024) throw new Error('压缩包超过 500MB，请使用桌面版按页读取。')
  if (typeof Worker === 'undefined') return (await import('./archiveCore')).extractArchiveImages(data, name)
  return queue.run(() => new Promise<File[]>((resolve, reject) => {
    const worker = new Worker(new URL('./archive.worker.ts', import.meta.url), { type: 'module' })
    const pages: File[] = []
    worker.onmessage = event => {
      if (event.data.page) { const page = event.data.page; pages[page.index] = new File([page.data], page.name, { type: page.type }); return }
      worker.terminate()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve(pages.filter(Boolean))
    }
    worker.onerror = () => { worker.terminate(); reject(new Error('解压失败，请检查压缩包或使用桌面版按页读取。')) }
    worker.postMessage({ data, name }, [data])
  }), new AbortController().signal)
}
