import { createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageReader from './ImageReader.vue'
import type { Comic, ReaderFile } from '../../types'

function comicAt(page: number): Comic {
  return {
    id: 'webtoon-book',
    title: '长篇漫画',
    format: 'images',
    addedAt: 1,
    lastReadAt: 1,
    lastPosition: page,
    totalPages: 100,
    tags: ['images'],
    readMode: 'webtoon',
    source: { type: 'fsa-dir', dirPath: '长篇漫画', status: 'available' },
  }
}

function fsaPages(spies: ReturnType<typeof vi.fn>[]): ReaderFile[] {
  return Array.from({ length: 100 }, (_, index) => {
    const getFile = vi.fn(async () => new File([`page-${index}`], `${index + 1}.jpg`, { type: 'image/jpeg' }))
    spies.push(getFile)
    return {
      kind: 'fsa-handle' as const,
      name: `${index + 1}.jpg`,
      type: 'image/jpeg',
      handle: { kind: 'file', name: `${index + 1}.jpg`, getFile } as unknown as FileSystemFileHandle,
    }
  })
}

describe('ImageReader webtoon jumps', () => {
  beforeEach(() => {
    let urlId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('ResizeObserver', undefined)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++urlId}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => vi.unstubAllGlobals())

  it('starts at page 50 and materializes only the target window', async () => {
    const calls: ReturnType<typeof vi.fn>[] = []
    const wrapper = mount(ImageReader, {
      props: { comic: comicAt(50), files: fsaPages(calls), initialPage: 50 },
      global: { plugins: [createPinia()] },
    })

    await flushPromises()

    const rendered = wrapper.findAll('[data-page-index]').map((node) => Number(node.attributes('data-page-index')))
    expect(rendered).toContain(49)
    expect(rendered.length).toBeGreaterThanOrEqual(5)
    expect(rendered.length).toBeLessThanOrEqual(21)
    expect(wrapper.find('[data-page-index="0"]').exists()).toBe(false)
    expect(wrapper.find('.webtoon-scroll').classes()).not.toContain('opacity-0')
    expect(calls[0]).not.toHaveBeenCalled()
    expect(calls.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(rendered.length)

    wrapper.unmount()
  })

  it('moves the virtual window immediately on a distant repeated jump', async () => {
    const calls: ReturnType<typeof vi.fn>[] = []
    const wrapper = mount(ImageReader, {
      props: { comic: comicAt(50), files: fsaPages(calls), initialPage: 50 },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()

    ;(wrapper.vm as unknown as { goTo: (page: number) => void }).goTo(80)
    ;(wrapper.vm as unknown as { goTo: (page: number) => void }).goTo(80)
    await flushPromises()

    expect(wrapper.find('[data-page-index="79"]').exists()).toBe(true)
    expect(wrapper.find('[data-page-index="49"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-page-index]').length).toBeLessThanOrEqual(21)
    expect(wrapper.find('.webtoon-scroll').classes()).not.toContain('opacity-0')

    wrapper.unmount()
  })
})
