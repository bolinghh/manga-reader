import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LibraryView from './LibraryView.vue'
import { useLibrary } from '../stores/library'
import type { Comic } from '../types'
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
