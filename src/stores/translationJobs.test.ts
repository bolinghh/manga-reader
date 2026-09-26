import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibrary } from './library'
import { useTranslationSettings } from './translation'
import { jobsDB, useTranslationJobs } from './translationJobs'
import { translatePageTask } from '../services/translationTask'
import type { Comic } from '../types'
import { clearBookTranslations } from '../services/translationCache'
vi.mock('../services/translationTask', () => ({ translatePageTask: vi.fn() }))
const source = vi.hoisted(() => ({ capture: vi.fn(), close: vi.fn(async () => {}) }))
vi.mock('../services/backgroundPageSource', () => ({ backgroundPageSource: () => source }))
let pinia: ReturnType<typeof createPinia>
beforeEach(async () => {
  localStorage.clear(); await jobsDB.jobs.clear(); pinia = createPinia(); setActivePinia(pinia)
  useLibrary().comics = [{ id: 'job-book', title: '后台任务测试', format: 'images', tags: [], addedAt: 1, lastReadAt: 0, lastPosition: 1, sourceKey: 'original', source: { type: 'input' } } as Comic]
  vi.spyOn(useLibrary(), 'resolveFiles').mockResolvedValue([])
  const settings = useTranslationSettings(); settings.provider = 'compatible'; settings.endpoint = 'http://localhost:9999'; settings.model = 'demo'; settings.apiKey = 'private-key'
  vi.mocked(translatePageTask).mockReset().mockResolvedValue(undefined); source.close.mockClear()
})
afterEach(() => { disposePinia(pinia); vi.restoreAllMocks() })
function draft() { const queue = useTranslationJobs(); queue.configure('job-book', 3, 1, 'ja', 'zh-Hans', 'rtl'); return queue }
describe('persistent background translation', () => {
  it('finishes while the task dialog is closed and persists no credentials', async () => {
    const queue = draft(); await queue.start(); queue.open = false
    await vi.waitFor(() => expect(queue.jobs[0].status).toBe('complete'))
    expect(queue.jobs[0].done).toEqual([0, 1, 2]); expect(source.close).toHaveBeenCalled()
    const saved = JSON.stringify(await jobsDB.jobs.toArray())
    expect(saved).not.toContain('private-key'); expect(saved).not.toContain('apiKey')
  })
  it('pauses an active request and resumes without repeating completed pages', async () => {
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    vi.mocked(translatePageTask).mockResolvedValueOnce(undefined).mockImplementationOnce(async (_book, _page, _config, _capture, signal) => {
      began(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')), { once: true })); return undefined
    })
    const queue = draft(); await queue.start(); await started
    await queue.pause(queue.jobs[0].id)
    await vi.waitFor(() => expect(source.close).toHaveBeenCalledTimes(1))
    expect(queue.jobs[0].done).toEqual([0]); expect(queue.jobs[0].status).toBe('paused')
    await queue.resume(queue.jobs[0].id)
    await vi.waitFor(() => expect(queue.jobs[0].status).toBe('complete'))
    expect(vi.mocked(translatePageTask).mock.calls.map(call => call[1])).toEqual([0, 1, 1, 2])
  })
  it('retries failed pages alone', async () => {
    vi.mocked(translatePageTask).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('此页图像损坏')).mockResolvedValueOnce(undefined)
    const queue = draft(); await queue.start()
    await vi.waitFor(() => expect(queue.jobs[0].status).toBe('failed'))
    await queue.resume(queue.jobs[0].id, true)
    await vi.waitFor(() => expect(queue.jobs[0].status).toBe('complete'))
    expect(vi.mocked(translatePageTask).mock.calls.map(call => call[1])).toEqual([0, 1, 2, 1])
  })
  it('restores interrupted tasks paused and cancels them when the book cache is cleared', async () => {
    vi.mocked(translatePageTask).mockImplementation(async (_book, _page, _config, _capture, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')), { once: true })))
    const queue = draft(); await queue.start()
    await vi.waitFor(() => expect(translatePageTask).toHaveBeenCalledTimes(1))
    const saved = (await jobsDB.jobs.toArray())[0]
    await clearBookTranslations('job-book')
    await vi.waitFor(() => expect(queue.jobs[0].status).toBe('cancelled'))
    await vi.waitFor(() => expect(source.close).toHaveBeenCalled())
    disposePinia(pinia); pinia = createPinia(); setActivePinia(pinia)
    await jobsDB.jobs.put({ ...saved, status: 'running' })
    const restored = useTranslationJobs(); await restored.load()
    expect(restored.jobs[0].status).toBe('paused')
  })
  it('pauses on quota failure and does not resume after required credentials have been cleared', async () => {
    const settings = useTranslationSettings(); settings.provider = 'tencent'; settings.apiKey = 'test-only'; settings.secretId = 'test-id'
    vi.mocked(translatePageTask).mockRejectedValueOnce(new Error('额度已用完'))
    const queue = draft(); await queue.start()
    await vi.waitFor(() => expect(queue.jobs[0].status).toBe('paused'))
    expect(queue.jobs[0].pending).toEqual([0, 1, 2])
    settings.apiKey = ''
    await queue.resume(queue.jobs[0].id)
    expect(queue.jobs[0].status).toBe('paused')
    expect(queue.jobs[0].error).toContain('SecretKey')
    expect(translatePageTask).toHaveBeenCalledTimes(1)
  })
})
