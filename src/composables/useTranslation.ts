import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { Comic, ReaderController } from '../types'
import type { TranslationActivation, TranslationConfig, TranslationLayerState, TranslationRecord, TranslationRect, TranslationSelection } from '../types/translation'
import { useTranslationSettings } from '../stores/translation'
import { useTranslationJobs } from '../stores/translationJobs'
import { clearBookTranslations, getBookLanguages, getTranslationCache, getRecognitionCache, saveBookLanguages, saveTranslationCache, saveRecognitionCache, recognitionCacheKey } from '../services/translationCache'
import { translateBlocks } from '../services/translation'
import { pageTranslationKey, translatePageTask } from '../services/translationTask'
import { validateTranslationConfig } from '../services/translationProviders'
import { throwIfAborted } from '../utils/translationImage'

export function useTranslation(comic: () => Comic, reader: Ref<ReaderController | null>, position: Ref<number>, ready: Ref<boolean>, direction: () => 'ltr' | 'rtl') {
  const settings = useTranslationSettings()
  const jobs = useTranslationJobs()
  const enabled = ref(false), sidebarOpen = ref(false), selecting = ref(false), configOpen = ref(false)
  const sourceLanguage = ref('ja'), targetLanguage = ref('zh-Hans')
  const records = ref<Record<number, TranslationRecord>>({})
  const active = ref<TranslationActivation | null>(null)
  const busy = ref(false), phase = ref(''), error = ref(''), notice = ref('')
  const busyPage = ref<number | null>(null)
  const currentPage = computed(() => Math.max(0, Math.floor(position.value) - 1))
  const config = computed<TranslationConfig>(() => ({ provider: settings.provider, ocrEndpoint: settings.ocrEndpoint, endpoint: settings.endpoint, model: settings.model, apiKey: settings.apiKey, jsonMode: settings.jsonMode, secretId: settings.secretId, region: settings.region, email: settings.email, sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value, readingDirection: direction() }))
  const layer = computed<TranslationLayerState>(() => ({ enabled: enabled.value, selecting: selecting.value, pages: Object.fromEntries(Object.entries(records.value).map(([key, record]) => [key, record.blocks])), activeId: active.value ? `${active.value.pageIndex}:${active.value.block.id}` : null }))
  const currentRecord = computed(() => records.value[currentPage.value])
  const visibleRecords = computed(() => (reader.value?.visiblePages() || [currentPage.value]).map((index) => records.value[index]).filter((record): record is TranslationRecord => !!record))
  let request: AbortController | null = null
  let cacheRead: AbortController | null = null
  let disposed = false
  let languagesLoaded = false
  let pendingRetry: (() => Promise<void>) | null = null

  void getBookLanguages(comic().id).then((saved) => {
    if (disposed) return
    if (saved) { sourceLanguage.value = saved.sourceLanguage; targetLanguage.value = saved.targetLanguage }
  }).catch(() => { notice.value = '无法读取语言设置，本次使用默认语言。' }).finally(() => { languagesLoaded = true })
  watch([sourceLanguage, targetLanguage], () => {
    if (languagesLoaded) void saveBookLanguages({ comicId: comic().id, sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value }).catch(() => { notice.value = '语言设置未能保存。' })
  })

  function cancel() {
    request?.abort(); request = null
    busy.value = false; phase.value = ''; busyPage.value = null
  }
  function toggle() {
    enabled.value = !enabled.value
    sidebarOpen.value = enabled.value
    if (!enabled.value) { selecting.value = false; active.value = null; cancel() }
  }
  function select(activation: TranslationActivation) { active.value = activation }
  function closeCard() { active.value = null }
  function startSelection() {
    if (!settings.ready) { configOpen.value = true; return }
    selecting.value = !selecting.value
    enabled.value = true
    active.value = null
    if (selecting.value) sidebarOpen.value = false
  }
  function checkConfig() {
    if (!settings.ready) { configOpen.value = true; error.value = '请先配置翻译服务。'; return false }
    if (settings.provider === 'mymemory' && sourceLanguage.value === 'auto') { error.value = 'MyMemory 需要指定原文语言，请选择日语、英语等语言后重试。'; return false }
    try { validateTranslationConfig(config.value); return true } catch (cause) { error.value = (cause as Error).message; configOpen.value = true; return false }
  }
  async function cacheFor(pageIndex: number, signal: AbortSignal, snapshot: TranslationConfig) {
    if (!reader.value) throw new Error('页面尚未就绪，请稍后重试。')
    const key = pageTranslationKey(comic(), pageIndex, snapshot)
    let cached: TranslationRecord | undefined
    try { cached = await getTranslationCache(key) } catch { notice.value = '本地缓存暂时不可用，翻译仍可使用。' }
    throwIfAborted(signal)
    return { key, cached }
  }
  async function persist(record: TranslationRecord, signal: AbortSignal) {
    throwIfAborted(signal)
    records.value = { ...records.value, [record.pageIndex]: record }
    try { await saveTranslationCache(record) } catch { notice.value = '译文已生成，但本地缓存写入失败；本次阅读仍可查看。' }
  }
  async function readVisibleCache() {
    cacheRead?.abort()
    if (!enabled.value || !ready.value || !settings.ready || busy.value) return
    const control = new AbortController(); cacheRead = control
    const snapshot = { ...config.value }
    try {
      for (const page of reader.value?.visiblePages() || [currentPage.value]) {
        const { cached } = await cacheFor(page, control.signal, snapshot)
        if (cached) records.value = { ...records.value, [page]: cached }
        else { const next = { ...records.value }; delete next[page]; records.value = next }
      }
    } catch (cause) {
      if (!control.signal.aborted) notice.value = '此页缓存尚未就绪，可点击“翻译当前页”重新读取。'
    }
  }
  async function runPage(pageIndex: number, force = false, region?: TranslationRect) {
    if (!checkConfig()) return
    enabled.value = true; selecting.value = false; active.value = null
    cancel(); cacheRead?.abort()
    const control = new AbortController(); request = control
    const signal = control.signal, snapshot = { ...config.value }
    busy.value = true; busyPage.value = pageIndex; error.value = ''; notice.value = ''; phase.value = '读取页面…'
    pendingRetry = () => runPage(pageIndex, force, region)
    try {
      if (!reader.value) throw new Error('页面尚未就绪，请稍后重试。')
      const record = await translatePageTask(comic(), pageIndex, snapshot, reader.value.capturePage.bind(reader.value), signal, { force, region, phase: value => { if (request === control) phase.value = value }, notice: value => { if (request === control) notice.value = value } })
      if (record) await persist(record, signal)
      throwIfAborted(signal)
      if (currentPage.value === pageIndex) sidebarOpen.value = true
    } catch (cause) {
      if (!signal.aborted) {
        error.value = cause instanceof Error ? cause.message : '翻译失败，请重试。'
        const partial = await getTranslationCache(pageTranslationKey(comic(), pageIndex, snapshot)).catch(() => undefined)
        if (!signal.aborted && partial) records.value = { ...records.value, [pageIndex]: partial }
      }
    } finally {
      if (request === control) { request = null; busy.value = false; busyPage.value = null; phase.value = '' }
    }
  }
  async function translatePage(force = false) { sidebarOpen.value = true; await runPage(currentPage.value, force) }
  async function translateRegion(selection: TranslationSelection) {
    selecting.value = false; sidebarOpen.value = true
    if (selection.pageIndex !== currentPage.value) {
      reader.value?.goTo(selection.pageIndex + 1)
      await nextTick()
    }
    await runPage(selection.pageIndex, false, selection.rect)
  }
  async function correctSource(pageIndex: number, id: string, source: string) {
    const record = records.value[pageIndex]
    if (!record || !source.trim() || source.length > 4000 || !checkConfig()) return
    const background = jobs.jobs.find(job => job.comicId === comic().id && ['queued', 'running'].includes(job.status))
    if (background) { await jobs.pause(background.id); notice.value = '已暂停此书后台任务，可在翻译任务中继续。' }
    if (disposed) return
    cancel(); cacheRead?.abort()
    const control = new AbortController(); request = control
    busy.value = true; busyPage.value = pageIndex; phase.value = '重新翻译…'; error.value = ''
    pendingRetry = () => correctSource(pageIndex, id, source)
    try {
      const blocks = record.blocks.map((block) => block.id === id ? { ...block, source: source.trim(), uncertain: false } : block)
      const recognitionKey = record.recognitionKey || recognitionCacheKey(comic(), pageIndex, config.value)
      const prior = await getRecognitionCache(recognitionKey).catch(() => undefined)
      throwIfAborted(control.signal)
      await saveRecognitionCache({ key: recognitionKey, comicId: comic().id, pageIndex, blocks: blocks.map(block => ({ ...block, translation: '' })), complete: prior?.complete ?? record.complete, updatedAt: Date.now() }).catch(() => { notice.value = '原文更正未能保存到本地。' })
      throwIfAborted(control.signal)
      const translated = await translateBlocks(blocks, { ...config.value }, control.signal, id)
      await persist({ ...record, blocks: translated, updatedAt: Date.now() }, control.signal)
      if (active.value?.block.id === id) active.value = { ...active.value, block: translated.find((block) => block.id === id)! }
    } catch (cause) { if (!control.signal.aborted) error.value = cause instanceof Error ? cause.message : '重新翻译失败。' }
    finally { if (request === control) { request = null; busy.value = false; busyPage.value = null; phase.value = '' } }
  }
  async function retry() { await pendingRetry?.() }
  async function clearCache() {
    cancel(); cacheRead?.abort(); active.value = null
    try { await clearBookTranslations(comic().id); records.value = {}; notice.value = '已清除此书的翻译缓存。'; error.value = '' }
    catch { error.value = '缓存清理失败，请重试。' }
  }
  function escape() {
    if (active.value) { closeCard(); return true }
    if (selecting.value) { selecting.value = false; sidebarOpen.value = true; return true }
    if (sidebarOpen.value) { sidebarOpen.value = false; return true }
    if (enabled.value) { toggle(); return true }
    return false
  }
  watch([currentPage, () => JSON.stringify([settings.provider, settings.ocrEndpoint, settings.endpoint, settings.model, settings.region, sourceLanguage.value, targetLanguage.value, direction(), comic().autoCrop])], (now, old) => {
    cancel(); cacheRead?.abort(); active.value = null; selecting.value = false; error.value = ''; notice.value = ''; pendingRetry = null
    if (old && now[1] !== old[1]) records.value = {}
    else records.value = Object.fromEntries(Object.entries(records.value).filter(([index]) => Math.abs(Number(index) - currentPage.value) <= 3))
    void readVisibleCache()
  })
  watch([enabled, ready, reader, () => JSON.stringify(reader.value?.visiblePages() || [])], () => { void readVisibleCache() }, { flush: 'post' })
  watch(() => jobs.revision, () => { void readVisibleCache() })
  onBeforeUnmount(() => { disposed = true; cancel(); cacheRead?.abort() })
  return { settings, enabled, sidebarOpen, selecting, configOpen, sourceLanguage, targetLanguage, records, layer, active, busy, phase, error, notice, busyPage, currentPage, currentRecord, visibleRecords, toggle, select, closeCard, startSelection, translatePage, translateRegion, correctSource, cancel, retry, clearCache, escape }
}
