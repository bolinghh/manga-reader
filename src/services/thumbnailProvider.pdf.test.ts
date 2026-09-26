import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThumbnailProvider } from './thumbnailProvider'
import type { Comic, ReaderFile } from '../types'
const pdf = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
  getDocument: vi.fn(),
  getPage: vi.fn(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 900 * scale }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) })),
}))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }))
afterEach(() => { vi.restoreAllMocks() })
describe('PDF thumbnail document sharing', () => {
  it('opens one PDF document for simultaneous thumbnail requests', async () => {
    pdf.getDocument.mockImplementation(() => ({ promise: Promise.resolve({ getPage: pdf.getPage, destroy: pdf.destroy }), destroy: pdf.destroy }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['thumbnail'])))
    let id = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:pdf-${++id}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const file = { arrayBuffer: vi.fn(async () => new ArrayBuffer(4)) } as unknown as File
    const provider = createThumbnailProvider({ format: 'pdf' } as Comic, [{ kind: 'file', name: 'book.pdf', type: 'application/pdf', file } as ReaderFile])
    provider.retain!([0, 1, 2])
    const urls = await Promise.all([0, 1, 2].map(page => provider.get(page, new AbortController().signal)))
    expect(pdf.getDocument).toHaveBeenCalledTimes(1)
    expect(file.arrayBuffer).toHaveBeenCalledTimes(1)
    expect(new Set(urls).size).toBe(3)
    provider.close(); expect(pdf.destroy).toHaveBeenCalledTimes(1)
  })
})
