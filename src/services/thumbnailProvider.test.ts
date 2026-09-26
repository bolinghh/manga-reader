import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createThumbnailProvider } from './thumbnailProvider'
import type { Comic, ReaderFile } from '../types'
const book = { format: 'images' } as Comic
const files: ReaderFile[] = Array.from({ length: 60 }, (_, page) => ({ kind: 'file', name: `${page}.png`, type: 'image/png', file: new File(['image'], `${page}.png`) }))
const draw = vi.fn(), close = vi.fn()
beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2400, height: 3600, close })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) { callback(new Blob(['small thumbnail'])) })
  let id = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:thumb-${++id}`), revokeObjectURL: vi.fn() }))
  draw.mockClear(); close.mockClear()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('thumbnail lifetime', () => {
  it('keeps more than 32 visible thumbnails valid and scales browser images down', async () => {
    const provider = createThumbnailProvider(book, files)
    provider.retain!(Array.from({ length: 60 }, (_, page) => page))
    for (let page = 0; page < 60; page++) await provider.get(page, new AbortController().signal)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(draw.mock.calls[0].slice(-2)).toEqual([160, 240])
    provider.retain!([])
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(28)
    provider.close()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(60)
  })
  it('shares in-flight work with a new scroll generation after the old caller aborts', async () => {
    let finish!: (bitmap: ImageBitmap) => void
    vi.mocked(createImageBitmap).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const provider = createThumbnailProvider(book, files); provider.retain!([0])
    const old = new AbortController()
    const first = provider.get(0, old.signal).catch(error => error.name)
    await vi.waitFor(() => expect(finish).toBeDefined())
    old.abort()
    const second = provider.get(0, new AbortController().signal)
    finish({ width: 1000, height: 1000, close } as unknown as ImageBitmap)
    expect(await first).toBe('AbortError'); expect(await second).toMatch(/^blob:/)
    expect(createImageBitmap).toHaveBeenCalledTimes(1)
    provider.close()
  })
})
