import Dexie, { type Table } from 'dexie'
import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { useLibrary } from './library'
import { useTranslationSettings } from './translation'
import { pageFingerprint, translationCacheEvents } from '../services/translationCache'
import { translatePageTask } from '../services/translationTask'
import { backgroundPageSource } from '../services/backgroundPageSource'
import { closeNativeReaderFiles } from '../services/nativeReader'
import { validateTranslationConfig } from '../services/translationProviders'
import type { TranslationConfig } from '../types/translation'

type Status = 'queued' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled'
type PublicConfig = Omit<TranslationConfig, 'apiKey' | 'secretId' | 'email'>
export interface TranslationJob {
  id: string; comicId: string; title: string; start: number; end: number; total: number
  fingerprint: string; config: PublicConfig; status: Status; done: number[]; failed: Record<number, string>
  pending: number[]; current: number | null; phase: string; error: string; updatedAt: number
}
class JobsDB extends Dexie {
  jobs!: Table<TranslationJob, string>
  constructor() { super('mangareader-translation-jobs'); this.version(1).stores({ jobs: 'id, updatedAt' }) }
}
export const jobsDB = new JobsDB()
export const useTranslationJobs = defineStore('translationJobs', () => {
  const lib = useLibrary(), settings = useTranslationSettings()
  const jobs = ref<TranslationJob[]>([]), open = ref(false), error = ref(''), revision = ref(0)
  const draft = ref<{ comicId: string; total: number; start: number; end: number; sourceLanguage: string; targetLanguage: string; readingDirection: 'ltr' | 'rtl' } | null>(null)
  const activeCount = computed(() => jobs.value.filter(job => ['running', 'queued'].includes(job.status)).length)
  const snapshots = new Map<string, TranslationConfig>()
  let active: { id: string; control: AbortController; finished: Promise<void> } | null = null
  let loaded = false
  let disposed = false
  async function persist(job: TranslationJob) {
    job.updatedAt = Date.now()
    try { await jobsDB.jobs.put(JSON.parse(JSON.stringify(job))) } catch { error.value = '任务进度未能保存，关闭应用后可能无法恢复。' }
  }
  async function load() {
    if (loaded) return
    loaded = true
    try {
      jobs.value = await jobsDB.jobs.orderBy('updatedAt').reverse().toArray()
      for (const job of jobs.value) if (job.status === 'queued' || job.status === 'running') { job.status = 'paused'; job.current = null; job.phase = ''; job.error = '应用已重新打开，点击继续恢复任务。'; await persist(job) }
    } catch { error.value = '无法读取历史翻译任务。' }
  }
  function configure(comicId: string, total: number, page: number, sourceLanguage: string, targetLanguage: string, readingDirection: 'ltr' | 'rtl') {
    draft.value = { comicId, total, start: page, end: Math.min(total, page + 9), sourceLanguage, targetLanguage, readingDirection }
    error.value = ''; open.value = true
  }
  function credentials(config: PublicConfig): TranslationConfig {
    if (config.provider !== settings.provider || config.endpoint !== settings.endpoint || config.model !== settings.model || config.ocrEndpoint !== settings.ocrEndpoint || config.region !== settings.region) throw new Error('服务配置已改变，请恢复任务原来的服务设置，或创建新任务。')
    return { ...config, apiKey: settings.apiKey, secretId: settings.secretId, email: settings.email }
  }
  async function start() {
    const value = draft.value
    if (!value) return
    const book = lib.comics.find(book => book.id === value.comicId)
    if (!book) { error.value = '漫画已从书库移除。'; return }
    if (!Number.isInteger(value.start) || !Number.isInteger(value.end) || value.start < 1 || value.end < value.start || value.end > value.total || value.end - value.start >= 10000) { error.value = '请输入有效的页码范围，一次最多 10,000 页。'; return }
    const config: TranslationConfig = { provider: settings.provider, ocrEndpoint: settings.ocrEndpoint, endpoint: settings.endpoint, model: settings.model, apiKey: settings.apiKey, secretId: settings.secretId, region: settings.region, email: settings.email, jsonMode: settings.jsonMode, sourceLanguage: value.sourceLanguage, targetLanguage: value.targetLanguage, readingDirection: value.readingDirection }
    try { validateTranslationConfig(config); if (config.provider === 'mymemory' && config.sourceLanguage === 'auto') throw new Error('MyMemory 需要指定原文语言。') } catch (cause) { error.value = (cause as Error).message; return }
    if (jobs.value.some(job => job.comicId === book.id && ['queued', 'running', 'paused'].includes(job.status))) { error.value = '此书已有未结束的任务，请继续或取消原任务。'; return }
    const { apiKey: _key, secretId: _id, email: _email, ...publicConfig } = config
    const job: TranslationJob = { id: crypto.randomUUID(), comicId: book.id, title: book.title, start: value.start, end: value.end, total: value.total, fingerprint: pageFingerprint(book, 0), config: publicConfig, status: 'queued', done: [], failed: {}, pending: Array.from({ length: value.end - value.start + 1 }, (_, index) => value.start + index - 1), current: null, phase: '', error: '', updatedAt: Date.now() }
    jobs.value.unshift(job); snapshots.set(job.id, config); draft.value = null; error.value = ''
    await persist(job); void pump()
  }
  async function pump() {
    if (active || disposed) return
    const job = jobs.value.find(job => job.status === 'queued')
    if (!job) return
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    const control = new AbortController(); active = { id: job.id, control, finished }
    job.status = 'running'; job.error = ''; await persist(job)
    let source: ReturnType<typeof backgroundPageSource> | undefined
    try {
      if (control.signal.aborted) return
      const config = snapshots.get(job.id) || credentials(job.config)
      validateTranslationConfig(config)
      const book = lib.comics.find(book => book.id === job.comicId)
      if (!book || pageFingerprint(book, 0) !== job.fingerprint) throw new Error('漫画来源或裁边设置已改变，请创建新任务。')
      const files = await lib.resolveFiles(book)
      if (control.signal.aborted) { await closeNativeReaderFiles(files); return }
      source = backgroundPageSource(book, files)
      while (job.pending.length && !control.signal.aborted) {
        if (!lib.comics.some(book => book.id === job.comicId)) { job.status = 'cancelled'; control.abort(); break }
        if (pageFingerprint(book, 0) !== job.fingerprint) throw new Error('漫画来源或裁边设置已改变，请创建新任务。')
        const page = job.pending[0]!
        job.current = page; job.phase = '读取页面…'
        try {
          await translatePageTask(book, page, config, source.capture, control.signal, { requireCache: true, phase: value => { if (!control.signal.aborted) job.phase = value } })
          if (control.signal.aborted) break
          job.done.push(page); delete job.failed[page]; revision.value++
        } catch (cause) {
          if (control.signal.aborted) break
          const message = cause instanceof Error ? cause.message : '翻译失败。'
          if (/密钥|权限|额度|限制|余额|签名|无法连接|超时|未就绪|未连接|OCR 暂时|缓存写入|存储/.test(message)) { job.status = 'paused'; job.error = message; break }
          job.failed[page] = message
        }
        job.pending.shift(); await persist(job)
      }
      if (job.status === 'running') job.status = control.signal.aborted || job.pending.length ? 'paused' : Object.keys(job.failed).length ? 'failed' : 'complete'
    } catch (cause) { if (!control.signal.aborted) { job.status = 'paused'; job.error = cause instanceof Error ? cause.message : '无法开始翻译。' } }
    finally {
      job.current = null; job.phase = ''; await source?.close().catch(() => undefined); await persist(job)
      if (active?.id === job.id) active = null
      finish()
      if (['complete', 'cancelled', 'failed'].includes(job.status)) snapshots.delete(job.id)
      void pump()
    }
  }
  async function pause(id: string) {
    const job = jobs.value.find(job => job.id === id)
    if (!job || !['running', 'queued'].includes(job.status)) return
    job.status = 'paused'
    const current = active?.id === id ? active : null
    current?.control.abort(); await persist(job); await current?.finished
  }
  async function resume(id: string, retryFailed = false) {
    const job = jobs.value.find(job => job.id === id)
    if (!job || !['paused', 'failed'].includes(job.status)) return
    try { const config = credentials(job.config); validateTranslationConfig(config); snapshots.set(id, config) } catch (cause) { job.error = (cause as Error).message; await persist(job); return }
    if (retryFailed) job.pending = [...new Set([...job.pending, ...Object.keys(job.failed).map(Number)])].sort((a, b) => a - b)
    job.status = 'queued'; job.error = ''; await persist(job); void pump()
  }
  async function cancel(id: string) {
    const job = jobs.value.find(job => job.id === id)
    if (!job) return
    job.status = 'cancelled'; job.pending = []; if (active?.id === id) active.control.abort(); snapshots.delete(id); await persist(job)
  }
  async function remove(id: string) { if (active?.id === id) return; const job = jobs.value.find(job => job.id === id); if (job && ['running', 'queued', 'paused'].includes(job.status)) return; await jobsDB.jobs.delete(id); jobs.value = jobs.value.filter(job => job.id !== id) }
  const clearListener = (event: Event) => {
    const id = (event as CustomEvent<string | null>).detail
    for (const job of jobs.value) if ((!id || job.comicId === id) && ['running', 'queued', 'paused'].includes(job.status)) void cancel(job.id)
  }
  translationCacheEvents.addEventListener('clear', clearListener)
  onScopeDispose(() => { disposed = true; translationCacheEvents.removeEventListener('clear', clearListener); active?.control.abort() })
  return { jobs, open, draft, error, activeCount, revision, load, configure, start, pause, resume, cancel, remove }
})
