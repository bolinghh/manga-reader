import Dexie from 'dexie'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBrowserPage } from '../services/browserPageCache'

class FailingImage {
  onerror: ((event: Event) => void) | null = null
  set src(_value: string) { queueMicrotask(() => this.onerror?.(new Event('error'))) }
}

function file(path: string, bytes = [1, 2, 3]) {
  const file = new File([new Uint8Array(bytes)], path.split('/').pop()!, { type: 'image/png', lastModified: 10 })
  Object.defineProperties(file, {
    webkitRelativePath: { value: path },
    arrayBuffer: { configurable: true, value: vi.fn(async () => new Uint8Array(bytes).buffer) },
  })
  return file
}

function fileList(files: File[]) { return files as unknown as FileList }

async function freshLibrary() {
  vi.resetModules()
  setActivePinia(createPinia())
  const library = (await import('./library')).useLibrary()
  await library.load()
  return library
}

async function storedDb() {
  const db = new Dexie('lumina')
  await db.open()
  return db
}

async function readBytes(file: File) {
  return new Promise<number[]>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

describe('browser library source persistence', () => {
  beforeEach(async () => {
    vi.stubGlobal('Image', FailingImage)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-cover')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    await (await freshLibrary()).clearAll()
  })
  afterEach(async () => {
    await (await freshLibrary()).clearAll()
    vi.unstubAllGlobals()
  })

  it('reopens directory pages after losing the whole browser session, without a relink warning', async () => {
    const library = await freshLibrary()
    const result = await library.importInputFiles(fileList([file('漫画/2.png', [2]), file('漫画/1.png', [1])]))
    expect(result.durability).toBe('permanent')
    expect(result.added[0].source.status).toBe('available')

    const reloaded = await freshLibrary()
    expect(reloaded.comics[0].source.status).toBe('available')
    const pages = await reloaded.resolveFiles(reloaded.comics[0])
    expect(pages.map((page) => page.kind)).toEqual(['cached-page', 'cached-page'])
    expect(pages.map((page) => page.name)).toEqual(['1.png', '2.png'])
    expect(await readBytes(await readBrowserPage(result.added[0].id, 0))).toEqual([1])
    expect(await readBytes(await readBrowserPage(result.added[0].id, 1))).toEqual([2])
  })

  it('repairs stale permission flags on old books with a valid legacy cache', async () => {
    const library = await freshLibrary()
    const comic = await library.addComic({ title: '旧书', format: 'images', source: { type: 'web-cache', status: 'permission-required' } })
    const db = await storedDb()
    await db.table('blobs').put({ id: comic.id, files: [{ name: '1.png', type: 'image/png', data: new Uint8Array([9]).buffer }] })
    db.close()
    const reloaded = await freshLibrary()
    expect(reloaded.comics[0].source.status).toBe('available')
    expect((await reloaded.resolveFiles(reloaded.comics[0]))[0].kind).toBe('file')
  })

  it('recognizes the same saved folder across single and batch import methods', async () => {
    const library = await freshLibrary()
    const files = [file('同一目录/1.png'), file('同一目录/2.png')]
    const first = await library.importInputFiles(fileList(files))
    const reloaded = await freshLibrary()
    const second = await reloaded.batchImportFromInput(fileList(files))
    expect(second.added).toEqual([])
    expect(second.skipped).toHaveLength(1)
    expect(reloaded.comics.map((comic) => comic.id)).toEqual([first.added[0].id])
  })

  it('recovers an old uncached book through ordinary reimport, preserving its metadata and bookmarks', async () => {
    const library = await freshLibrary()
    const files = [file('漫画/1.png'), file('漫画/2.png')]
    const comic = await library.addComic({
      title: '自定义标题', format: 'images', totalPages: 2, tags: ['喜欢'], favorite: true,
      // Legacy single-folder key differs from the batch importer key.
      sourceKey: 'legacy-source-key', source: { type: 'web-cache', filePaths: ['漫画/1.png', '漫画/2.png'], status: 'permission-required' },
    })
    await library.touch(comic.id, 2)
    await library.addBookmark(comic.id, 2, '继续这里')
    const reloaded = await freshLibrary()
    expect(reloaded.comics[0].source.status).toBe('missing')
    const result = await reloaded.batchImportFromInput(fileList(files))
    expect(result.added[0].id).toBe(comic.id)
    expect(result.durability).toBe('permanent')
    expect(reloaded.comics).toHaveLength(1)
    const final = await freshLibrary()
    expect(final.comics[0]).toMatchObject({ id: comic.id, title: '自定义标题', tags: ['喜欢'], favorite: true, lastPosition: 2, source: { status: 'available' } })
    expect(final.bookmarksFor(comic.id)[0].label).toBe('继续这里')
    expect((await final.resolveFiles(final.comics[0]))).toHaveLength(2)
    expect((await final.batchImportFromInput(fileList(files))).skipped).toHaveLength(1)
  })

  it('allows targeted recovery only for the original page manifest', async () => {
    const library = await freshLibrary()
    const comic = await library.addComic({ title: '旧书', format: 'images', totalPages: 2, source: { type: 'web-cache', filePaths: ['原目录/1.png', '原目录/2.png'], status: 'missing' } })
    await expect(library.relinkBrowserFiles(comic.id, fileList([file('别的目录/1.png'), file('别的目录/2.png')]))).rejects.toThrow('不匹配')
    expect(comic.source.status).toBe('missing')
    expect((await library.relinkBrowserFiles(comic.id, fileList([file('原目录/1.png'), file('原目录/2.png')]))).durability).toBe('permanent')
    expect((await freshLibrary()).comics[0].source.status).toBe('available')
  })

  it('clears stale status when files can be opened in the current session', async () => {
    const library = await freshLibrary()
    const comic = await library.addComic({ title: '会话书目', format: 'images', source: { type: 'web-cache', files: [file('1.png')], status: 'permission-required' } })
    expect((await library.resolveFiles(comic))).toHaveLength(1)
    expect(comic.source.status).toBe('available')
  })

  it('recovers a nested batch-imported chapter when its original chapter folder is selected directly', async () => {
    const library = await freshLibrary()
    const comic = await library.addComic({ title: '第1话', format: 'images', totalPages: 2, source: { type: 'web-cache', filePaths: ['大目录/系列/第1话/1.png', '大目录/系列/第1话/2.png'], status: 'missing' } })
    await expect(library.relinkBrowserFiles(comic.id, fileList([file('第2话/1.png'), file('第2话/2.png')]))).rejects.toThrow('不匹配')
    expect((await library.relinkBrowserFiles(comic.id, fileList([file('第1话/1.png'), file('第1话/2.png')]))).durability).toBe('permanent')
    expect((await freshLibrary()).comics[0].source.status).toBe('available')
  })

  it('keeps reading available on a storage failure, but reports the session-only fallback honestly', async () => {
    const library = await freshLibrary()
    const unreadable = file('配额/2.png')
    Object.defineProperty(unreadable, 'arrayBuffer', { configurable: true, value: vi.fn(async () => { throw new DOMException('full', 'QuotaExceededError') }) })
    const result = await library.importInputFiles(fileList([file('配额/1.png'), unreadable]))
    expect(result.durability).toBe('session')
    expect(result.added[0].source.status).toBe('available')
    expect(await library.resolveFiles(result.added[0])).toHaveLength(2)
    await expect(readBrowserPage(result.added[0].id, 0)).rejects.toThrow('缓存已失效')
    const reloaded = await freshLibrary()
    expect(reloaded.comics[0].source.status).toBe('missing')
    expect(await reloaded.resolveFiles(reloaded.comics[0])).toEqual([])
  })

  it('removes the individual page cache when a book is removed from the shelf', async () => {
    const library = await freshLibrary()
    const result = await library.importInputFiles(fileList([file('删除/1.png')]))
    await library.removeComic(result.added[0].id)
    await expect(readBrowserPage(result.added[0].id, 0)).rejects.toThrow('缓存已失效')
  })
})
