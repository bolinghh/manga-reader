import { afterEach, describe, expect, it, vi } from 'vitest'
import { recognizeTranslation, requestService, translateBlocks } from './translation'
import type { TranslationConfig } from '../types/translation'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))
const config: TranslationConfig = { provider: 'mymemory', ocrEndpoint: 'http://127.0.0.1:8876', endpoint: '', model: '', apiKey: 'must-not-send', email: '', jsonMode: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans', readingDirection: 'rtl' }
function jsonResponse(body: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }) }
}
afterEach(() => vi.unstubAllGlobals())
describe('image and text transport separation', () => {
  it('relays browser Tencent requests locally without sending the SecretKey', async () => {
    const body = { SourceText: 'こんにちは！', Source: 'ja', Target: 'zh', ProjectId: 0 }
    const signed = { authorization: 'signed-test-only', timestamp: '1234', region: 'ap-guangzhou' }
    const fetchMock = vi.fn(async (url, options) => {
      expect(String(url)).toBe('http://127.0.0.1:8876/translate/tencent')
      expect(options.headers.Authorization).toBeUndefined()
      const envelope = JSON.parse(options.body)
      expect(envelope.payload).toBe(JSON.stringify(body))
      expect(envelope.headers).toEqual(signed)
      expect(options.body).not.toContain('must-not-send')
      return jsonResponse({ Response: { TargetText: '你好！' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await requestService('tencent', 'https://tmt.tencentcloudapi.com/', body, { ...config, provider: 'tencent' }, new AbortController().signal, signed)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('explains when the old local service lacks the Tencent bridge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    await expect(requestService('tencent', 'https://tmt.tencentcloudapi.com/', {}, config, new AbortController().signal)).rejects.toThrow('重启')
  })
  it('sends image bytes only to loopback OCR, then sends recognized text to MyMemory', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      if (String(url) === 'http://127.0.0.1:8876/ocr') {
        expect(JSON.parse(options.body).image).toBe('data:image/jpeg;base64,TEST_ONLY_IMAGE')
        expect(options.headers.Authorization).toBeUndefined()
        return jsonResponse({ blocks: [{ source: 'Hello world!', box: [100, 100, 300, 200] }] })
      }
      const service = new URL(url)
      expect(service.origin).toBe('https://api.mymemory.translated.net')
      expect(service.searchParams.get('q')).toBe('Hello world!')
      expect(service.searchParams.get('langpair')).toBe('en|zh-CN')
      expect(options.body).toBeUndefined()
      expect(String(url)).not.toContain('TEST_ONLY_IMAGE')
      expect(String(url)).not.toContain('must-not-send')
      return jsonResponse({ responseStatus: 200, responseData: { translatedText: '你好，世界！' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const control = new AbortController()
    const recognized = await recognizeTranslation({ dataUrl: 'data:image/jpeg;base64,TEST_ONLY_IMAGE', width: 900, height: 1300 }, config, control.signal)
    const result = await translateBlocks(recognized, config, control.signal)
    expect(result[0].translation).toBe('你好，世界！')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('cancels OCR without making a cloud request', async () => {
    const control = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      control.abort()
      expect(options.signal.aborted).toBe(true)
      throw new DOMException('Aborted', 'AbortError')
    }))
    await expect(recognizeTranslation({ dataUrl: 'data:image/jpeg;base64,TEST_ONLY_IMAGE', width: 1, height: 1 }, config, control.signal)).rejects.toThrow('已取消')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
