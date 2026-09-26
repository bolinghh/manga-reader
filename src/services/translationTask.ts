import type { Comic } from '../types'
import type { TranslationConfig, TranslationFrame, TranslationRecord, TranslationRect } from '../types/translation'
import { getRecognitionCache, getTranslationCache, pageFingerprint, recognitionCacheKey, saveRecognitionCache, saveTranslationCache, translationCacheKey } from './translationCache'
import { recognizeTranslation, translateBlocks } from './translation'
import { hashTranslationImage, throwIfAborted } from '../utils/translationImage'
import { waitWithSignal } from '../utils/taskQueue'
const running = new Map<string, Promise<void>>()

export function pageTranslationKey(comic: Comic, page: number, config: TranslationConfig) {
  return translationCacheKey(comic.id, page, 'source:' + pageFingerprint(comic, page), config)
}
interface TaskOptions { force?: boolean; region?: TranslationRect; requireCache?: boolean; phase?: (value: string) => void; notice?: (value: string) => void }
export async function translatePageTask(comic: Comic, page: number, config: TranslationConfig, capture: (page: number, signal: AbortSignal, region?: TranslationRect) => Promise<TranslationFrame>, signal: AbortSignal, options: TaskOptions = {}) {
  const lock = recognitionCacheKey(comic, page, config)
  while (running.has(lock)) { options.phase?.('等待此页任务…'); await waitWithSignal(running.get(lock)!, signal); throwIfAborted(signal) }
  let release!: () => void
  const completed = new Promise<void>(resolve => { release = resolve })
  running.set(lock, completed)
  try { return await runPage(comic, page, config, capture, signal, options) }
  finally { if (running.get(lock) === completed) running.delete(lock); release() }
}
async function runPage(comic: Comic, page: number, config: TranslationConfig, capture: (page: number, signal: AbortSignal, region?: TranslationRect) => Promise<TranslationFrame>, signal: AbortSignal, options: TaskOptions) {
  const key = pageTranslationKey(comic, page, config), recognitionKey = recognitionCacheKey(comic, page, config)
  const safe = async <T>(operation: () => Promise<T>, writing = false): Promise<T | undefined> => { try { return await operation() } catch { if (writing && options.requireCache) throw new Error('翻译缓存写入失败，请释放存储空间后继续。'); options.notice?.('本地缓存暂时不可用，本次结果仍可查看。'); return undefined } }
  let cached = await safe(() => getTranslationCache(key))
  throwIfAborted(signal)
  if (cached?.complete && !options.force && !options.region) { options.notice?.('已载入本地缓存。'); return cached }
  const recognized = !options.force ? await safe(() => getRecognitionCache(recognitionKey)) : undefined
  let blocks = recognized?.complete && !options.region ? recognized.blocks : undefined
  if (!blocks) {
    options.phase?.('读取页面…')
    const frame = await capture(page, signal, options.region)
    throwIfAborted(signal)
    if (!options.force && !options.region && !cached) {
      const legacyKey = translationCacheKey(comic.id, page, await hashTranslationImage(frame.dataUrl), config)
      const legacy = await safe(() => getTranslationCache(legacyKey))
      throwIfAborted(signal)
      if (legacy?.complete) {
        const migrated = { ...legacy, key, recognitionKey }
        await safe(() => saveRecognitionCache({ ...migrated, key: recognitionKey, blocks: migrated.blocks.map(block => ({ ...block, translation: '' })) }), true)
        throwIfAborted(signal)
        await safe(() => saveTranslationCache(migrated), true)
        return migrated
      }
      cached ||= legacy
    }
    options.phase?.('识别文字…')
    blocks = await recognizeTranslation(frame, config, signal, options.region)
    throwIfAborted(signal)
    if (options.region) {
      const suffix = `r${crypto.randomUUID().slice(0, 8)}`
      blocks = blocks.map(block => ({ ...block, id: `${suffix}-${block.id}` }))
    }
    if (!blocks.length && options.region) { options.notice?.('没有识别到文字，可以缩小框选区域后重试。'); return cached }
    const region = options.region
    const prior = region ? (recognized?.blocks || cached?.blocks || []).filter(block => !(block.rect.x >= region.x && block.rect.y >= region.y && block.rect.x + block.rect.width <= region.x + region.width && block.rect.y + block.rect.height <= region.y + region.height)) : []
    blocks = [...prior, ...blocks]
    await safe(() => saveRecognitionCache({ key: recognitionKey, comicId: comic.id, pageIndex: page, blocks: blocks!.map(block => ({ ...block, translation: '' })), complete: region ? recognized?.complete === true || cached?.complete === true : true, updatedAt: Date.now() }), true)
  }
  // A corrected original invalidates only its own translation.
  blocks = blocks.map(block => { const previous = options.force ? undefined : cached?.blocks.find(item => item.id === block.id && item.source === block.source); return { ...block, translation: previous?.translation || '' } })
  const fullRecognition = options.region ? recognized?.complete === true || cached?.complete === true : true
  const persist = async (translated: typeof blocks, finished = false) => {
    throwIfAborted(signal)
    const record: TranslationRecord = { key, recognitionKey, comicId: comic.id, pageIndex: page, blocks: translated!, complete: finished && fullRecognition, updatedAt: Date.now() }
    await safe(() => saveTranslationCache(record), true)
    return record
  }
  if (blocks.length) {
    options.phase?.('翻译对白…')
    const pending = blocks.filter(block => !block.translation).map(block => block.id)
    blocks = await translateBlocks(blocks, config, signal, pending, async progress => { await persist(progress) })
  } else options.notice?.('没有识别到文字，可以缩小框选区域后重试。')
  throwIfAborted(signal)
  return persist(blocks, true)
}
