import { webcrypto, createHmac, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localOCREndpoint, splitUTF8, tencentError, tencentHeaders, translateProviderBlocks, validateTranslationConfig } from './translationProviders'
import type { TranslationBlock, TranslationConfig } from '../types/translation'
const config: TranslationConfig = { provider: 'mymemory', ocrEndpoint: 'http://127.0.0.1:8876', endpoint: '', model: '', apiKey: '', sourceLanguage: 'ja', targetLanguage: 'zh-Hans', readingDirection: 'rtl', jsonMode: true }
const block: TranslationBlock = { id: 'b1', source: 'こんにちは', translation: '旧译文', uncertain: false, rect: { x: .1, y: .1, width: .2, height: .2 } }
afterEach(() => vi.unstubAllGlobals())
describe('local OCR and text translation providers', () => {
  it.each(['https://example.com', 'http://127.0.0.1.attacker.com', 'file:///ocr', 'http://user:secret@localhost', 'http://localhost?token=a'])('keeps OCR on loopback and rejects ambiguous address %s', (url) => { expect(() => localOCREndpoint(url)).toThrow() })
  it('normalizes the local OCR and health paths', () => {
    expect(localOCREndpoint('http://localhost:8876/ocr/')).toBe('http://localhost:8876/ocr')
    expect(localOCREndpoint('http://[::1]:8876/ocr', 'health')).toBe('http://[::1]:8876/health')
  })
  it('splits Japanese and emoji by UTF-8 bytes without losing characters', () => {
    const text = '日本語🌏'.repeat(80), parts = splitUTF8(text, 500)
    expect(parts.join('')).toBe(text)
    expect(parts.every((part) => new TextEncoder().encode(part).length <= 500)).toBe(true)
  })
  it('requires provider credentials only where the API needs them', () => {
    expect(() => validateTranslationConfig(config)).not.toThrow()
    expect(() => validateTranslationConfig({ ...config, provider: 'deepl' })).toThrow('密钥')
    expect(() => validateTranslationConfig({ ...config, provider: 'tencent', region: 'ap-guangzhou' })).toThrow('SecretId')
  })
  it('sends MyMemory text only, preserves untouched corrections, and respects its byte limit', async () => {
    const request = vi.fn(async () => ({ responseStatus: 200, responseData: { translatedText: '你好' } }))
    const blocks = [{ ...block, source: '日本語'.repeat(90) }, { ...block, id: 'b2', translation: '保留' }]
    const result = await translateProviderBlocks(blocks, config, new AbortController().signal, request, ['b1'])
    expect(result[1].translation).toBe('保留')
    expect(request).toHaveBeenCalledTimes(2)
    for (const call of request.mock.calls as unknown[][]) {
      expect(call[0]).toBe('mymemory'); expect(call[1]).toBe('https://api.mymemory.translated.net/get')
      expect(JSON.stringify(call[2])).not.toContain('image')
      expect(new TextEncoder().encode((call[2] as { q: string }).q).length).toBeLessThanOrEqual(500)
    }
  })
  it('reports MyMemory quota exhaustion rather than accepting its error as a translation', async () => {
    const request = vi.fn(async () => ({ responseStatus: 200, quotaFinished: true, responseData: { translatedText: 'QUOTA LIMIT' } }))
    await expect(translateProviderBlocks([block], config, new AbortController().signal, request, ['b1'])).rejects.toThrow('额度')
  })
  it('requires an explicit source language for MyMemory', async () => {
    const request = vi.fn()
    await expect(translateProviderBlocks([block], { ...config, sourceLanguage: 'auto' }, new AbortController().signal, request, ['b1'])).rejects.toThrow('原文语言')
    expect(request).not.toHaveBeenCalled()
  })
  it('batches DeepL text within its size and count limits, with whole-page context', async () => {
    const blocks = Array.from({ length: 55 }, (_, index) => ({ ...block, id: `b${index}`, source: '日'.repeat(2000) }))
    const request = vi.fn(async (_kind, _endpoint, body) => ({ translations: (body.text as string[]).map(() => ({ text: '你好' })) }))
    const result = await translateProviderBlocks(blocks, { ...config, provider: 'deepl', apiKey: 'test-only', targetLanguage: 'zh-Hant' }, new AbortController().signal, request, blocks.map((item) => item.id))
    expect(result).toHaveLength(55)
    for (const call of request.mock.calls) {
      const body = call[2]
      expect((body.text as string[]).length).toBeLessThanOrEqual(50)
      expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(120_000)
      expect(body.context).toBeTruthy(); expect(body.target_lang).toBe('ZH-HANT'); expect(body.source_lang).toBe('JA')
    }
  })
  it('rejects incomplete DeepL batches', async () => {
    await expect(translateProviderBlocks([block], { ...config, provider: 'deepl', apiKey: 'test-only' }, new AbortController().signal, vi.fn(async () => ({ translations: [] })), ['b1'])).rejects.toThrow('不完整')
  })
  it('posts LibreTranslate text to a local endpoint with its optional key', async () => {
    const request = vi.fn(async () => ({ translatedText: '你好' }))
    await translateProviderBlocks([block], { ...config, provider: 'libretranslate', endpoint: 'http://localhost:5000', apiKey: 'test-only' }, new AbortController().signal, request, ['b1'])
    expect(request).toHaveBeenCalledWith('libretranslate', 'http://localhost:5000/translate', { q: block.source, source: 'ja', target: 'zh', format: 'text', api_key: 'test-only' }, expect.anything(), expect.anything())
  })
  it('produces a Tencent TC3 signature matching an independent HMAC implementation', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const sample = { ...config, provider: 'tencent' as const, secretId: 'test-only-id', apiKey: 'test-only-secret', region: 'ap-guangzhou' }
    const timestamp = 1551113065, payload = JSON.stringify({ SourceText: 'Hello world', Source: 'en', Target: 'zh', ProjectId: 0 })
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10), scope = `${date}/tmt/tc3_request`
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:tmt.tencentcloudapi.com\n\ncontent-type;host\n${hash(payload)}`
    const keyDate = createHmac('sha256', 'TC3test-only-secret').update(date).digest()
    const keyService = createHmac('sha256', keyDate).update('tmt').digest()
    const keySigning = createHmac('sha256', keyService).update('tc3_request').digest()
    const signature = createHmac('sha256', keySigning).update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest('hex')
    expect((await tencentHeaders(sample, payload, timestamp)).authorization).toBe(`TC3-HMAC-SHA256 Credential=test-only-id/${scope}, SignedHeaders=content-type;host, Signature=${signature}`)
  })
  it('does not issue a request after cancellation', async () => {
    const control = new AbortController(); control.abort(); const request = vi.fn()
    await expect(translateProviderBlocks([block], config, control.signal, request, ['b1'])).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('distinguishes Tencent service activation, quota, permissions and expired signatures', () => {
    expect(tencentError('FailedOperation.UserNotRegistered', 'test-request-id')).toContain('尚未开通')
    expect(tencentError('FailedOperation.NoFreeAmount')).toContain('免费额度')
    expect(tencentError('UnauthorizedOperation.NoPermission')).toContain('tmt:TextTranslate')
    expect(tencentError('AuthFailure.SignatureExpire')).toContain('电脑时间')
    expect(tencentError('FailedOperation.UserNotRegistered', 'test-request-id')).toContain('test-request-id')
    expect(tencentError('private\nerror', 'private\nrequest')).not.toContain('private')
  })
})
