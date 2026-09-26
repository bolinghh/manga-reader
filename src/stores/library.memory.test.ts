import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibrary } from './library'

class FailingImage {
  onload: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  width = 1
  height = 1
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.(new Event('error')))
  }
}

function asFileList(files: File[]): FileList {
  const list = { length: files.length, item: (index: number) => files[index] || null }
  files.forEach((file, index) => Object.assign(list, { [index]: file }))
  return list as unknown as FileList
}

describe('low-memory image directory imports', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('Image', FailingImage)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cover')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker
  })

  it('saves 500 input images one page at a time without retaining page bytes in metadata', async () => {
    await useLibrary().clearAll()
    const arrayBufferCalls: ReturnType<typeof vi.fn>[] = []
    let pendingReads = 0
    let maxPendingReads = 0
    const files = Array.from({ length: 500 }, (_, index) => {
      const file = new File(['x'], `${index + 1}.jpg`, { type: 'image/jpeg', lastModified: index + 1 })
      Object.defineProperty(file, 'webkitRelativePath', { value: `低内存目录/${index + 1}.jpg` })
      const arrayBuffer = vi.fn(async () => {
        pendingReads++
        maxPendingReads = Math.max(maxPendingReads, pendingReads)
        await Promise.resolve()
        pendingReads--
        return new ArrayBuffer(1)
      })
      Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })
      arrayBufferCalls.push(arrayBuffer)
      return file
    })

    const result = await useLibrary().importInputFiles(asFileList(files))

    expect(result.added).toHaveLength(1)
    expect(result.durability).toBe('permanent')
    expect(arrayBufferCalls.every((spy) => spy.mock.calls.length === 1)).toBe(true)
    expect(maxPendingReads).toBe(1)
    expect(result.added[0].source.files).toEqual([])
  })

  it('materializes only the cover when importing an FSA directory', async () => {
    const getFileCalls: ReturnType<typeof vi.fn>[] = []
    const handles = Array.from({ length: 500 }, (_, index) => {
      const getFile = vi.fn(async () => new File(['x'], `${index + 1}.jpg`, { type: 'image/jpeg' }))
      getFileCalls.push(getFile)
      return { kind: 'file', name: `${index + 1}.jpg`, getFile }
    })
    const directory = {
      kind: 'directory',
      name: 'FSA-低内存目录',
      async *entries() {
        for (const handle of handles) yield [handle.name, handle]
      },
    }
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => directory) })

    const library = useLibrary()
    const result = await library.importFSADirectory()
    const readerFiles = await library.resolveFiles(result.added[0])

    expect(result.durability).toBe('session')
    expect(readerFiles).toHaveLength(500)
    expect(readerFiles.every((file) => file.kind === 'fsa-handle')).toBe(true)
    expect(getFileCalls.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(1)
  })
})
