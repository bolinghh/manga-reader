import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTranslation } from './useTranslation'
import { useTranslationSettings } from '../stores/translation'
import { clearAllTranslations, getBookLanguages, getTranslationCache } from '../services/translationCache'
import { recognizeTranslation, translateBlocks } from '../services/translation'
import type { Comic, ReaderController } from '../types'
import type { TranslationBlock } from '../types/translation'

vi.mock('../utils/translationImage', async (original) => ({ ...await original<typeof import('../utils/translationImage')>(), hashTranslationImage: vi.fn(async (data: string) => `hash-${data}`) }))
vi.mock('../services/translation', async (original) => ({ ...await original<typeof import('../services/translation')>(), recognizeTranslation: vi.fn(), translateBlocks: vi.fn() }))
const block: TranslationBlock = { id: 'b1', source: 'こんにちは', translation: '', uncertain: false, rect: { x: .1, y: .2, width: .3, height: .2 } }
const book: Comic = { id: 'translation-test', title: '翻译测试', format: 'images', tags: [], addedAt: 1, lastReadAt: 0, lastPosition: 1, source: { type: 'input' } }
let wrappers: ReturnType<typeof mount>[] = []
function setup() {
  const position = ref(1)
  const double = ref(false)
  const capture = vi.fn(async (page: number) => ({ dataUrl: `image-${page}`, width: 1000, height: 1500 }))
  const reader = ref({ capturePage: capture, visiblePages: () => double.value ? [Math.floor(position.value) - 1, Math.floor(position.value)] : [Math.floor(position.value) - 1], goTo: (page: number) => { position.value = page } } as unknown as ReaderController)
  let translation!: ReturnType<typeof useTranslation>
  const wrapper = mount(defineComponent({ setup() { translation = useTranslation(() => book, reader, position, ref(true), () => 'rtl'); return () => h('div') } }))
  wrappers.push(wrapper)
  return { translation, position, double, capture, wrapper }
}
beforeEach(async () => {
  localStorage.clear(); setActivePinia(createPinia())
  await clearAllTranslations()
  const settings = useTranslationSettings(); settings.provider = 'compatible'; settings.endpoint = 'https://example.com/v1'; settings.model = 'test-text'
  vi.mocked(recognizeTranslation).mockReset().mockResolvedValue([{ ...block }])
  vi.mocked(translateBlocks).mockReset().mockImplementation(async (blocks) => blocks.map((item) => ({ ...item, translation: '你好' })))
})
afterEach(() => { wrappers.forEach((wrapper) => wrapper.unmount()); wrappers = [] })

describe('reader translation lifecycle', () => {
  it('uses persisted page translations without repeating service calls', async () => {
    const first = setup(); await flushPromises(); await first.translation.translatePage()
    expect(first.translation.records.value[0].blocks[0].translation).toBe('你好')
    first.wrapper.unmount()
    const second = setup(); await flushPromises(); second.translation.toggle()
    await vi.waitFor(() => expect(second.translation.records.value[0]).toBeDefined())
    expect(second.translation.records.value[0].blocks[0].translation).toBe('你好')
    await second.translation.translatePage()
    expect(recognizeTranslation).toHaveBeenCalledTimes(1); expect(translateBlocks).toHaveBeenCalledTimes(1)
    expect(second.capture).not.toHaveBeenCalled()
  })
  it('discards late OCR when the reader has moved to another page', async () => {
    let finish!: (blocks: TranslationBlock[]) => void
    vi.mocked(recognizeTranslation).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { translation, position } = setup(); await flushPromises()
    const task = translation.translatePage()
    await vi.waitFor(() => expect(translation.phase.value).toBe('识别文字…'))
    position.value = 2; await flushPromises(); finish([{ ...block }]); await task
    expect(translateBlocks).not.toHaveBeenCalled(); expect(translation.records.value[1]).toBeUndefined(); expect(translation.busy.value).toBe(false)
  })
  it('loads both cached pages when switching to a spread without changing the current page', async () => {
    const first = setup(); await flushPromises(); await first.translation.translatePage()
    first.position.value = 2; await flushPromises(); await first.translation.translatePage()
    first.wrapper.unmount()
    const second = setup(); await flushPromises(); second.translation.toggle()
    await vi.waitFor(() => expect(second.translation.records.value[0]).toBeDefined())
    expect(second.translation.records.value[1]).toBeUndefined()
    second.double.value = true
    await vi.waitFor(() => expect(second.translation.records.value[1]).toBeDefined())
    expect(second.translation.visibleRecords.value).toHaveLength(2)
    expect(recognizeTranslation).toHaveBeenCalledTimes(2)
  })
  it('discards late translation after cancellation', async () => {
    let finish!: (blocks: TranslationBlock[]) => void
    vi.mocked(translateBlocks).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { translation } = setup(); await flushPromises()
    const task = translation.translatePage()
    await vi.waitFor(() => expect(typeof finish).toBe('function'))
    translation.cancel(); finish([{ ...block, translation: '过期译文' }]); await task
    expect(translation.records.value[0]).toBeUndefined()
  })
  it('keeps successful cached results when a forced retranslation fails and supports retry', async () => {
    const { translation } = setup(); await flushPromises(); await translation.translatePage()
    vi.mocked(recognizeTranslation).mockRejectedValueOnce(new Error('无法连接服务'))
    await translation.translatePage(true)
    expect(translation.error.value).toBe('无法连接服务')
    expect(translation.records.value[0].blocks[0].translation).toBe('你好')
    await translation.retry(); expect(translation.error.value).toBe('')
  })
  it('persists corrected source and translates it with page context', async () => {
    const { translation } = setup(); await flushPromises(); await translation.translatePage()
    await translation.correctSource(0, 'b1', 'こんばんは')
    expect(translateBlocks).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ source: 'こんばんは' })]), expect.anything(), expect.anything(), 'b1')
    const record = await getTranslationCache(translation.records.value[0].key)
    expect(record?.blocks[0].source).toBe('こんばんは')
  })
  it('does not treat a region-only cache as a fully translated page', async () => {
    const { translation } = setup(); await flushPromises()
    await translation.translateRegion({ pageIndex: 0, rect: { x: .1, y: .1, width: .5, height: .5 } })
    expect(translation.records.value[0].complete).toBe(false)
    await translation.translatePage()
    expect(recognizeTranslation).toHaveBeenCalledTimes(2)
    expect(translation.records.value[0].complete).toBe(true)
  })
  it('removes this book cache and remembers its language choice', async () => {
    const { translation } = setup(); await flushPromises()
    translation.sourceLanguage.value = 'ja'; translation.targetLanguage.value = 'zh-Hant'; await flushPromises()
    expect((await getBookLanguages(book.id))?.targetLanguage).toBe('zh-Hant')
    await translation.translatePage(); const key = translation.records.value[0].key
    await translation.clearCache()
    expect(await getTranslationCache(key)).toBeUndefined()
    expect((await getBookLanguages(book.id))?.targetLanguage).toBe('zh-Hant')
  })
  it('invalidates displayed translations when the model or language changes', async () => {
    const { translation } = setup(); await flushPromises(); await translation.translatePage()
    useTranslationSettings().model = 'different-model'; await flushPromises()
    expect(translation.records.value[0]).toBeUndefined()
  })
  it('keeps credentials out of persisted settings', async () => {
    const settings = useTranslationSettings(); settings.apiKey = 'super-secret'; settings.model = 'new-model'; await flushPromises()
    expect(localStorage.getItem('mangareader.translationSettings')).not.toContain('super-secret')
  })
  it('reuses corrected OCR when changing the target language', async () => {
    const { translation, capture } = setup(); await flushPromises(); await translation.translatePage()
    await translation.correctSource(0, 'b1', 'こんばんは')
    translation.targetLanguage.value = 'en'; await flushPromises(); await translation.translatePage()
    expect(recognizeTranslation).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(vi.mocked(translateBlocks).mock.calls.at(-1)![0][0].source).toBe('こんばんは')
  })
  it('serializes simultaneous foreground and background requests for the same page', async () => {
    let finish!: (blocks: TranslationBlock[]) => void
    vi.mocked(recognizeTranslation).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = setup(), second = setup(); await flushPromises()
    const a = first.translation.translatePage()
    await vi.waitFor(() => expect(finish).toBeDefined())
    const b = second.translation.translatePage()
    await vi.waitFor(() => expect(second.translation.phase.value).toBe('等待此页任务…'))
    finish([{ ...block }]); await Promise.all([a, b])
    expect(recognizeTranslation).toHaveBeenCalledTimes(1)
    expect(translateBlocks).toHaveBeenCalledTimes(1)
    expect(second.capture).not.toHaveBeenCalled()
    expect(second.translation.records.value[0].complete).toBe(true)
  })
  it('keeps successful dialogue after a partial failure and retries only missing dialogue', async () => {
    vi.mocked(recognizeTranslation).mockResolvedValueOnce([{ ...block }, { ...block, id: 'b2', source: 'おやすみ' }])
    vi.mocked(translateBlocks).mockImplementationOnce(async (blocks, _config, _signal, _ids, progress) => {
      await progress!([{ ...blocks[0], translation: '你好' }, blocks[1]])
      throw new Error('网络中断')
    })
    const { translation } = setup(); await flushPromises(); await translation.translatePage()
    expect(translation.records.value[0].blocks[0].translation).toBe('你好')
    expect(translation.records.value[0].complete).toBe(false)
    await translation.retry()
    expect(recognizeTranslation).toHaveBeenCalledTimes(1)
    expect(vi.mocked(translateBlocks).mock.calls.at(-1)![3]).toEqual(['b2'])
    expect(translation.records.value[0].complete).toBe(true)
  })
})
