import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import LibraryView from './LibraryView.vue'
import { useLibrary } from '../stores/library'
import type { Comic } from '../types'

function mountLibrary() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const lib = useLibrary()
  lib.comics = [
    { id: 'one', title: '第一本漫画', format: 'images', addedAt: 1, lastReadAt: 0, lastPosition: 0, tags: ['images'], source: { type: 'input', status: 'available' } },
    { id: 'two', title: '另一本漫画', format: 'pdf', addedAt: 2, lastReadAt: 0, lastPosition: 0, tags: ['pdf'], source: { type: 'input', status: 'available' } },
  ] as Comic[]
  const wrapper = mount(LibraryView, { global: { plugins: [pinia], stubs: { ComicCard: { props: ['comic'], template: '<button class="test-comic">{{ comic.title }}</button>' }, ComicCover: true } } })
  return { lib, wrapper }
}

describe('library filter recovery', () => {
  beforeEach(() => localStorage.clear())

  it('keeps shelf controls available when the source issues category has no books', async () => {
    const { lib, wrapper } = mountLibrary()
    const shelves = () => wrapper.get('[aria-label="智能书架与排序"]')
    await shelves().findAll('button').find(button => button.text() === '来源异常')!.trigger('click')
    expect(lib.filtered).toHaveLength(0)
    expect(wrapper.text()).toContain('没有找到匹配的漫画')
    expect(wrapper.findAll('.test-comic')).toHaveLength(0)
    await shelves().findAll('button').find(button => button.text() === '全部')!.trigger('click')
    expect(lib.shelfFilter).toBe('all')
    expect(wrapper.findAll('.test-comic')).toHaveLength(2)
    wrapper.unmount()
  })

  it('clears search, tags and shelf category together while keeping the chosen sort order', async () => {
    const { lib, wrapper } = mountLibrary()
    lib.query = '不存在的漫画'
    lib.activeTag = 'pdf'
    lib.shelfFilter = 'source-issues'
    lib.sortMode = 'title'
    await flushPromises()
    await wrapper.get('.editorial-empty button').trigger('click')
    expect(lib.query).toBe('')
    expect(lib.activeTag).toBeNull()
    expect(lib.shelfFilter).toBe('all')
    expect(lib.sortMode).toBe('title')
    expect(wrapper.findAll('.test-comic')).toHaveLength(2)
    expect(JSON.parse(localStorage.getItem('mangareader.viewPrefs')!).shelfFilter).toBe('all')
    wrapper.unmount()
  })

  it('recovers from a previously saved empty shelf filter after reopening the library', async () => {
    localStorage.setItem('mangareader.viewPrefs', JSON.stringify({ shelfFilter: 'source-issues', sortMode: 'imported' }))
    const { lib, wrapper } = mountLibrary()
    expect(lib.filtered).toHaveLength(0)
    await wrapper.findAll('button').find(button => button.text() === '清除筛选')!.trigger('click')
    expect(wrapper.findAll('.test-comic')).toHaveLength(2)
    wrapper.unmount()
    const reloaded = mountLibrary()
    expect(reloaded.lib.shelfFilter).toBe('all')
    expect(reloaded.lib.sortMode).toBe('imported')
    expect(reloaded.wrapper.findAll('.test-comic')).toHaveLength(2)
    reloaded.wrapper.unmount()
  })
})

describe('batch pagination', () => {
  it('counts individual books when 121 books belong to one series, and resets after switching modes', async () => {
    localStorage.clear(); const pinia = createPinia(); setActivePinia(pinia)
    const lib = useLibrary()
    lib.comics = Array.from({ length: 121 }, (_, index) => ({ id: `${index}`, title: `第 ${index + 1} 话`, series: '同一个系列', format: 'images', addedAt: index, lastReadAt: 0, lastPosition: 0, tags: [], source: { type: 'input', status: 'available' } } as Comic))
    const wrapper = mount(LibraryView, { global: { plugins: [pinia], stubs: { ComicCard: { props: ['comic'], template: '<button class="test-comic">{{ comic.title }}</button>' }, ComicCover: true } } })
    await wrapper.get('[aria-label="书库管理"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text().includes('批量管理'))!.trigger('click')
    expect(wrapper.findAll('.test-comic')).toHaveLength(120)
    const nav = wrapper.get('[aria-label="书库分页"]')
    expect(nav.text()).toContain('1 / 2')
    await nav.findAll('button')[1]!.trigger('click')
    expect(wrapper.findAll('.test-comic')).toHaveLength(1)
    expect(wrapper.text()).toContain('2 / 2')
    await wrapper.findAll('button').find(button => button.text() === '完成')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[aria-label="书库分页"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
