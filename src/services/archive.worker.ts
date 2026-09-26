import { extractArchiveImages } from './archiveCore'
self.onmessage = async (event: MessageEvent<{ data: ArrayBuffer; name: string }>) => {
  try {
    await extractArchiveImages(event.data.data, event.data.name, async (file, index) => {
      const data = await file.arrayBuffer()
      self.postMessage({ page: { name: file.name, type: file.type, data, index } }, { transfer: [data] })
    })
    self.postMessage({ done: true })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '压缩包损坏或无法读取' }) }
}
