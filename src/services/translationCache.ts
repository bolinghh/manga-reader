import Dexie, { type Table } from 'dexie'
import type { TranslationConfig, TranslationRecord, RecognitionRecord } from '../types/translation'
import type { Comic } from '../types'

interface BookLanguages { comicId: string; sourceLanguage: string; targetLanguage: string }
class TranslationDB extends Dexie {
  pages!: Table<TranslationRecord, string>
  languages!: Table<BookLanguages, string>
  recognitions!: Table<RecognitionRecord, string>
  constructor() {
    super('mangareader-translations')
    this.version(1).stores({ pages: 'key, comicId, updatedAt', languages: 'comicId' })
    this.version(2).stores({ recognitions: 'key, comicId, updatedAt' })
  }
}
export const translationDB = new TranslationDB()
export const translationCacheEvents = new EventTarget()
export function pageFingerprint(comic: Comic, pageIndex: number) {
  return JSON.stringify(['page-v1', comic.contentSignature || comic.source.signature || comic.sourceKey || comic.id, comic.format, pageIndex, !!comic.autoCrop])
}
export function recognitionCacheKey(comic: Comic, pageIndex: number, config: TranslationConfig) {
  return JSON.stringify(['ocr-v4', comic.id, pageIndex, pageFingerprint(comic, pageIndex), config.ocrEndpoint.trim().replace(/\/+$/, ''), config.sourceLanguage === 'auto' ? 'ja' : config.sourceLanguage, config.readingDirection])
}
export function getRecognitionCache(key: string) { return translationDB.recognitions.get(key) }
export async function saveRecognitionCache(record: RecognitionRecord) {
  await translationDB.transaction('rw', translationDB.recognitions, async () => {
    await translationDB.recognitions.put(JSON.parse(JSON.stringify(record)))
    const extra = await translationDB.recognitions.count() - 1000
    if (extra > 0) await translationDB.recognitions.bulkDelete(await translationDB.recognitions.orderBy('updatedAt').limit(extra).primaryKeys())
  })
}

export function translationCacheKey(comicId: string, pageIndex: number, imageHash: string, config: TranslationConfig) {
  // Credentials never enter cache keys, persisted records, or metadata backups.
  return JSON.stringify(['v3-local-rapidocr-paragraphs', comicId, pageIndex, imageHash, config.provider, config.ocrEndpoint.trim().replace(/\/+$/, ''), config.endpoint.trim().replace(/\/+$/, ''), config.model.trim(), config.region || '', config.sourceLanguage, config.targetLanguage, config.readingDirection])
}
export function getTranslationCache(key: string) { return translationDB.pages.get(key) }
export async function saveTranslationCache(record: TranslationRecord) {
  const plain = JSON.parse(JSON.stringify(record)) as TranslationRecord
  await translationDB.transaction('rw', translationDB.pages, async () => {
    await translationDB.pages.put(plain)
    const extra = await translationDB.pages.count() - 500
    if (extra > 0) {
      const keys = await translationDB.pages.orderBy('updatedAt').limit(extra).primaryKeys()
      await translationDB.pages.bulkDelete(keys)
    }
  })
}
export function getBookLanguages(comicId: string) { return translationDB.languages.get(comicId) }
export function saveBookLanguages(value: BookLanguages) { return translationDB.languages.put(value) }
export async function clearBookTranslations(comicId: string, includeLanguages = false) {
  translationCacheEvents.dispatchEvent(new CustomEvent('clear', { detail: comicId }))
  await translationDB.pages.where('comicId').equals(comicId).delete()
  await translationDB.recognitions.where('comicId').equals(comicId).delete()
  if (includeLanguages) await translationDB.languages.delete(comicId)
}
export async function clearAllTranslations() {
  translationCacheEvents.dispatchEvent(new CustomEvent('clear', { detail: null }))
  await translationDB.transaction('rw', translationDB.pages, translationDB.languages, translationDB.recognitions, async () => {
    await translationDB.pages.clear()
    await translationDB.languages.clear()
    await translationDB.recognitions.clear()
  })
}
