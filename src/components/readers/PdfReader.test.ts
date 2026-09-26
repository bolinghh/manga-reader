import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PdfReader from './PdfReader.vue'
import type { Comic, ReaderController, ReaderFile } from '../../types'
const dimensions = vi.hoisted(() => ({ width: 600, height: 800 }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({
    numPages: 3,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: dimensions.width * scale, height: dimensions.height * scale }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    }),
    destroy: vi.fn(),
  }) }),
}))
const comic: Comic = { id: 'pdf-translation-test', title: 'PDF', format: 'pdf', tags: [], addedAt: 1, lastReadAt: 0, lastPosition: 1, pageMode: 'single', source: { type: 'input' } }
const files = [{ kind: 'file', file: { arrayBuffer: async () => new ArrayBuffer(1) } }] as ReaderFile[]
const translation = { enabled: true, selecting: false, activeId: null, pages: Object.fromEntries([0, 1, 2].map((page) => [page, [{ id: 'b1', source: 'Hello', translation: '你好', uncertain: false, rect: { x: .1, y: .1, width: .5, height: .2 } }]])) }
const wrappers: ReturnType<typeof mount>[] = []

beforeEach(() => {
  dimensions.width = 600; dimensions.height = 800
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
})
afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function setup() {
  const wrapper = mount(PdfReader, { props: { comic, files, translation }, global: { plugins: [createPinia()] } })
  wrappers.push(wrapper)
  return { wrapper, controller: wrapper.vm as unknown as ReaderController }
}
describe('PDF page canvas lifecycle', () => {
  it('caps extremely tall pages even when a scale below 1 is needed', async () => {
    dimensions.width = 1000; dimensions.height = 100000
    const { wrapper } = setup(); await flushPromises()
    const canvas = wrapper.get('canvas').element as HTMLCanvasElement
    expect(canvas.width).toBeGreaterThan(0)
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(12_000_000)
  })
  it('renders both newly mounted spread canvases and attaches their translation regions', async () => {
    const { wrapper, controller } = setup(); await flushPromises()
    controller.setMode('double'); await flushPromises()
    const canvases = wrapper.findAll('canvas')
    expect(canvases).toHaveLength(2)
    expect(canvases.every((canvas) => canvas.element.width > 300 && canvas.element.height > 150)).toBe(true)
    expect(wrapper.findAll('[data-translation-page]').map((layer) => layer.attributes('data-translation-page'))).toEqual(['0', '1'])
    expect(controller.visiblePages()).toEqual([0, 1])
  })
  it('recreates the second canvas after returning from an unpaired final page', async () => {
    const { wrapper, controller } = setup(); await flushPromises()
    controller.setMode('double'); await flushPromises()
    controller.goTo(3); await flushPromises()
    expect(wrapper.findAll('canvas')).toHaveLength(1)
    expect(controller.visiblePages()).toEqual([2])
    controller.goTo(1); await flushPromises()
    expect(wrapper.findAll('canvas')).toHaveLength(2)
    expect(wrapper.findAll('[data-translation-page]')).toHaveLength(2)
    expect(wrapper.findAll('canvas')[1].element.width).toBeGreaterThan(300)
  })
})
