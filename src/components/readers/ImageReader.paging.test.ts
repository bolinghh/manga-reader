import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageReader from './ImageReader.vue'
import type { Comic, ReaderController, ReaderFile } from '../../types'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const wrappers: ReturnType<typeof mount>[] = []
const gates = new Map<string, ReturnType<typeof deferred>>()
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')
let revoked = vi.fn<(url: string) => void>()
function setup(pageMode: 'single' | 'double' = 'single', failingPage = -1) {
  const comic: Comic = { id: 'paged-test', title: 'Sample', format: 'images', tags: [], addedAt: 1, lastReadAt: 0, lastPosition: 1, readMode: 'page', pageMode, source: { type: 'input' } }
  const reads = Array.from({ length: 20 }, (_, index) => vi.fn(async () => {
    if (index === failingPage) throw new Error('无法读取此页图像')
    return new File(['sample'], `page-${index}.png`, { type: 'image/png' })
  }))
  const files: ReaderFile[] = reads.map((getFile, index) => ({ kind: 'fsa-handle', name: `${index}.png`, type: 'image/png', handle: { getFile } as unknown as FileSystemFileHandle }))
  const wrapper = mount(ImageReader, { props: { comic, files }, global: { plugins: [createPinia()] }, attachTo: document.body })
  wrappers.push(wrapper)
  const visible = () => wrapper.findAll('[data-active="true"] [data-page-index]').map((page) => Number(page.attributes('data-page-index')))
  return { wrapper, controller: wrapper.vm as unknown as ReaderController, visible, reads }
}
beforeEach(() => {
  localStorage.clear()
  gates.clear()
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${(blob as File).name}`)
  revoked = vi.fn<(url: string) => void>()
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoked)
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: vi.fn(function (this: HTMLImageElement) {
    return this.isConnected ? gates.get(this.src)?.promise || Promise.resolve() : Promise.resolve()
  }) })
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  if (originalDecode) Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode)
  else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
})

describe('ImageReader page continuity', () => {
  it('keeps the current image visible until the incoming DOM image is decoded', async () => {
    const { wrapper, controller, visible } = setup()
    await flushPromises()
    expect(visible()).toEqual([0])
    const incoming = deferred(); gates.set('blob:page-1.png', incoming)
    controller.next(); await flushPromises()
    expect(visible()).toEqual([0])
    expect(wrapper.get('[data-active="true"] img').attributes('style') || '').not.toContain('opacity')
    incoming.resolve(); await flushPromises()
    expect(visible()).toEqual([1])
  })
  it('preloads both neighbors and switches a double spread only after both images decode', async () => {
    const { controller, visible, reads } = setup('double')
    await flushPromises()
    expect(visible()).toEqual([1, 0])
    expect(reads[2]).toHaveBeenCalledTimes(1)
    expect(reads[3]).toHaveBeenCalledTimes(1)
    const left = deferred(), right = deferred()
    gates.set('blob:page-2.png', left); gates.set('blob:page-3.png', right)
    controller.next(); await flushPromises()
    left.resolve(); await flushPromises()
    expect(visible()).toEqual([1, 0])
    right.resolve(); await flushPromises()
    expect(visible()).toEqual([3, 2])
  })
  it('ignores late results from an earlier jump and holds the old URL until replacement', async () => {
    const { controller, visible } = setup()
    await flushPromises()
    const earlier = deferred(), latest = deferred()
    gates.set('blob:page-1.png', earlier); gates.set('blob:page-9.png', latest)
    controller.next(); await flushPromises()
    controller.goTo(10); await flushPromises()
    expect(visible()).toEqual([0])
    expect(revoked).not.toHaveBeenCalledWith('blob:page-0.png')
    earlier.resolve(); await flushPromises()
    expect(visible()).toEqual([0])
    latest.resolve(); await flushPromises()
    expect(visible()).toEqual([9])
    expect(revoked).toHaveBeenCalledWith('blob:page-0.png')
  })
  it('shows an error while preserving the previous image when reading the new page fails', async () => {
    const { wrapper, controller, visible } = setup('single', 9)
    await flushPromises()
    controller.goTo(10); await flushPromises()
    expect(visible()).toEqual([0])
    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取')
    expect(revoked).not.toHaveBeenCalledWith('blob:page-0.png')
  })
  it('preserves the old spread on decode failure and can continue to another page', async () => {
    const { wrapper, controller, visible } = setup()
    await flushPromises()
    const broken = deferred(); gates.set('blob:page-1.png', broken)
    controller.next(); await flushPromises()
    broken.reject(new Error('图片解码失败')); await flushPromises()
    expect(visible()).toEqual([0])
    expect(wrapper.get('[role="alert"]').text()).toContain('解码失败')
    controller.goTo(3); await flushPromises()
    expect(visible()).toEqual([2])
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('releases images outside the neighboring window and all remaining URLs on close', async () => {
    const { wrapper, controller, visible } = setup()
    await flushPromises()
    for (let page = 2; page <= 15; page++) { controller.goTo(page); await flushPromises() }
    expect(visible()).toEqual([14])
    expect(revoked).toHaveBeenCalledWith('blob:page-0.png')
    expect(revoked).not.toHaveBeenCalledWith('blob:page-14.png')
    wrapper.unmount(); await flushPromises()
    expect(revoked).toHaveBeenCalledWith('blob:page-14.png')
    expect(revoked).toHaveBeenCalledWith('blob:page-15.png')
  })
})
