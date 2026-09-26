import { describe, expect, it } from 'vitest'
import { applyTranslations, parseRecognition, translationEndpoint } from './translation'
import { translationCacheKey } from './translationCache'
import { normalizeRect, pagePoint } from '../utils/translationImage'
import type { TranslationConfig } from '../types/translation'

const config: TranslationConfig = { provider: 'compatible', ocrEndpoint: 'http://127.0.0.1:8876', endpoint: 'https://example.com/v1', model: 'text-model', apiKey: 'private-token', jsonMode: true, sourceLanguage: 'ja', targetLanguage: 'zh-Hans', readingDirection: 'rtl' }
const recognition = { blocks: [{ source: 'こんにちは', box: [100, 200, 300, 600], uncertain: true }] }

describe('translation data boundaries', () => {
  it('normalizes compatible service addresses without duplicating the path', () => {
    expect(translationEndpoint(' https://example.com/v1/ ')).toBe('https://example.com/v1/chat/completions')
    expect(translationEndpoint('https://example.com')).toBe('https://example.com/chat/completions')
    expect(translationEndpoint('http://127.0.0.1:1234/v1/chat/completions')).toBe('http://127.0.0.1:1234/v1/chat/completions')
    expect(translationEndpoint('http://[::1]:1234/v1')).toBe('http://[::1]:1234/v1/chat/completions')
  })
  it.each(['http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret', 'file:///v1', 'not-a-url'])('rejects unsafe or ambiguous address %s', (endpoint) => { expect(() => translationEndpoint(endpoint)).toThrow() })
  it('maps selection-relative OCR coordinates back to the full page', () => {
    const block = parseRecognition(recognition, { x: .4, y: .2, width: .5, height: .5 })[0]
    expect(block.rect.x).toBeCloseTo(.45)
    expect(block.rect.y).toBeCloseTo(.3)
    expect(block.rect.width).toBeCloseTo(.1)
    expect(block.rect.height).toBeCloseTo(.2)
    expect(block.source).toBe('こんにちは')
    expect(block.uncertain).toBe(true)
  })
  it.each([[300, 200, 100, 500], [-5, 20, 100, 200], [0, 0, 1200, 200], [0, 0, NaN, 500]])('rejects malformed page coordinates', (a, b, c, d) => {
    expect(() => parseRecognition({ blocks: [{ source: 'a', box: [a, b, c, d] }] })).toThrow()
  })
  it('accepts an empty page without inventing text', () => { expect(parseRecognition({ blocks: [] })).toEqual([]) })
  it('uses IDs to match out-of-order translations', () => {
    const blocks = [...parseRecognition(recognition), { ...parseRecognition(recognition)[0], id: 'b2', source: 'ありがとう' }]
    const translated = applyTranslations(blocks, { translations: [{ id: 'b2', text: '谢谢' }, { id: 'b1', text: '你好' }] })
    expect(translated.map((block) => block.translation)).toEqual(['你好', '谢谢'])
    expect(blocks[0].translation).toBe('')
  })
  it('rejects missing, duplicated, or unexpected translation IDs', () => {
    const blocks = parseRecognition(recognition)
    expect(() => applyTranslations(blocks, { translations: [] })).toThrow()
    expect(() => applyTranslations(blocks, { translations: [{ id: 'other', text: '你好' }] })).toThrow()
    expect(() => applyTranslations(blocks, { translations: [{ id: 'b1', text: '' }] })).toThrow()
  })
  it('retranslates only the corrected dialogue and preserves other translations', () => {
    const blocks = [{ ...parseRecognition(recognition)[0], translation: '你好' }, { ...parseRecognition(recognition)[0], id: 'b2', translation: '谢谢' }]
    const translated = applyTranslations(blocks, { translations: [{ id: 'b1', text: '您好' }] }, ['b1'])
    expect(translated.map((block) => block.translation)).toEqual(['您好', '谢谢'])
  })
  it('invalidates cache for content, language, model and service changes, excluding credentials', () => {
    const key = translationCacheKey('book', 0, 'image-a', config)
    expect(key).not.toContain('private-token')
    expect(translationCacheKey('book', 0, 'image-a', { ...config, apiKey: 'other-key' })).toBe(key)
    for (const changed of [{ ...config, targetLanguage: 'en' }, { ...config, sourceLanguage: 'en' }, { ...config, model: 'other-model' }, { ...config, endpoint: 'https://other.com/v1' }, { ...config, readingDirection: 'ltr' as const }]) expect(translationCacheKey('book', 0, 'image-a', changed)).not.toBe(key)
    expect(translationCacheKey('book', 0, 'image-b', config)).not.toBe(key)
  })
})

describe('page coordinate mapping', () => {
  const bounds = { left: 10, top: 20, width: 200, height: 400 }
  it.each([[0, .2, .3], [90, .3, .8], [180, .8, .7], [270, .7, .2]])('maps screen points through rotation %i', (rotation, x, y) => {
    const point = pagePoint(50, 140, bounds, rotation)
    expect(point.x).toBeCloseTo(x); expect(point.y).toBeCloseTo(y)
  })
  it('clamps pointer positions and selected regions to the page', () => {
    expect(pagePoint(-100, 999, bounds, 0)).toEqual({ x: 0, y: 1 })
    expect(normalizeRect({ x: .8, y: .9, width: .5, height: .5 })).toEqual({ x: .8, y: .9, width: 1 - .8, height: 1 - .9 })
  })
})
