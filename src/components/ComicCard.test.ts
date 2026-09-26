import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ComicCard from './ComicCard.vue'
import type { Comic } from '../types'
import { createPinia } from 'pinia'

const comic: Comic = {
  id: 'book-1', title: '测试漫画', format: 'images', addedAt: 1, lastReadAt: 0,
  lastPosition: 0, totalPages: 10, tags: ['images'], sourceKey: 'source-1',
  source: { type: 'native-dir', rootPath: 'E:/Book', pagePaths: ['E:/Book/1.jpg'], status: 'missing' },
}

describe('ComicCard', () => {
  it('shows a specific recovery action only for an unavailable browser source', async () => {
    const wrapper = mount(ComicCard, { props: { comic: { ...comic, source: { type: 'web-cache', status: 'missing' } } }, attachTo: document.body, global: { plugins: [createPinia()] } })
    expect(wrapper.text()).toContain('需要重新导入')
    expect(wrapper.text()).not.toContain('需要重新关联')
    await wrapper.get('[aria-haspopup="menu"]').trigger('click')
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('重新导入')
    await wrapper.setProps({ comic: { ...comic, source: { type: 'web-cache', status: 'available' } } })
    expect(wrapper.text()).not.toContain('需要重新')
    wrapper.unmount()
  })
  it('separates opening the comic from management actions', async () => {
    const wrapper = mount(ComicCard, { props: { comic }, attachTo: document.body, global: { plugins: [createPinia()] } })
    await wrapper.get('article > button').trigger('click')
    expect(wrapper.emitted('open')?.[0]?.[0]).toEqual(comic)
    await wrapper.get('[aria-haspopup="menu"]').trigger('click')
    expect(document.body.textContent).toContain('重新关联')
    expect(wrapper.text()).toContain('需要重新关联')
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')
    expect(menu?.classList.contains('fixed')).toBe(true)
    wrapper.unmount()
  })
})
