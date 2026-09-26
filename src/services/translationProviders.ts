import type { TranslationBlock, TranslationConfig } from '../types/translation'
import { throwIfAborted } from '../utils/translationImage'

export type ServiceKind = 'ocr' | 'ocr-model' | 'mymemory' | 'tencent' | 'deepl' | 'libretranslate'
export type ServiceRequest = (kind: ServiceKind, endpoint: string, body: Record<string, unknown>, config: TranslationConfig, signal: AbortSignal, extra?: Record<string, string>) => Promise<unknown>
const encoder = new TextEncoder()
const loopback = ['localhost', '127.0.0.1', '[::1]']
function serviceURL(value: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请填写有效的服务地址。') }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含用户名、密码、查询参数或片段。')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.includes(url.hostname))) throw new Error('云端服务请使用 HTTPS；本机服务可以使用 HTTP。')
  return url
}
export function localOCREndpoint(value: string, path: 'ocr' | 'health' = 'ocr') {
  const url = serviceURL(value)
  if (!loopback.includes(url.hostname)) throw new Error('OCR 必须使用本机地址，漫画图片仅在本机识别。')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(ocr|health)$/, '') + '/' + path
  return url.toString()
}
export function libreEndpoint(value: string) {
  const url = serviceURL(value)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/translate') ? path : path + '/translate'
  return url.toString()
}
export function localTencentEndpoint(value: string) {
  return localOCREndpoint(value).replace(/\/ocr$/, '/translate/tencent')
}
export function tencentError(code: unknown, requestId?: unknown) {
  const name = typeof code === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(code) ? code : ''
  const messages: Record<string, string> = {
    'AuthFailure.SignatureFailure': '腾讯云签名校验失败，请确认 SecretId 与 SecretKey 属于同一组密钥。',
    'AuthFailure.SecretIdNotFound': '腾讯云 SecretId 不存在或已停用，请检查所填密钥。',
    'AuthFailure.InvalidSecretId': '腾讯云 SecretId 格式无效，请检查所填密钥。',
    'AuthFailure.SignatureExpire': '腾讯云签名已过期，请校准电脑时间后重试。',
    'FailedOperation.UserNotRegistered': '腾讯云机器翻译服务尚未开通，请先在机器翻译控制台开通文本翻译。',
    'FailedOperation.NoFreeAmount': '腾讯云本月文本翻译免费额度已用完，请等待额度恢复或更换服务。',
    'FailedOperation.ServiceIsolate': '腾讯云账号因欠费暂停服务，请检查账户状态。',
  }
  const hint = messages[name] || (name.startsWith('AuthFailure') ? '腾讯云鉴权失败，请检查 SecretId 和 SecretKey。' : name.startsWith('UnauthorizedOperation') ? '腾讯云密钥没有文本翻译权限，请为对应账号授权 tmt:TextTranslate。' : name.includes('RequestLimitExceeded') ? '腾讯云请求频率超限，请稍后重试。' : name.includes('LimitExceeded') || name.includes('ResourceUnavailable') ? '腾讯云额度不足或服务不可用，请检查服务控制台。' : name.startsWith('UnsupportedOperation') ? '腾讯云不支持当前语言或文字长度，请检查原文和目标语言。' : '腾讯云未能完成翻译，请检查服务配置或稍后重试。')
  const id = typeof requestId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(requestId) ? requestId : ''
  return `${hint}${name ? `（${name}）` : ''}${id ? ` 请求编号：${id}` : ''}`
}
export function validateTranslationConfig(config: TranslationConfig, credentials = true) {
  localOCREndpoint(config.ocrEndpoint)
  if (config.provider === 'libretranslate') libreEndpoint(config.endpoint)
  if (config.provider === 'compatible') {
    serviceURL(config.endpoint)
    if (!config.model.trim()) throw new Error('请填写文字模型名称。')
  }
  if (credentials && config.provider === 'deepl' && !config.apiKey.trim()) throw new Error('请填写 DeepL API Free 密钥。')
  if (config.provider === 'tencent') {
    if (!/^[a-z]+-[a-z]+(?:-[a-z]+)?$/.test(config.region || '')) throw new Error('请填写腾讯云地域，例如 ap-guangzhou。')
    if (credentials && (!config.secretId?.trim() || !config.apiKey.trim())) throw new Error('请填写腾讯云 SecretId 和 SecretKey。')
  }
  if (config.provider === 'mymemory' && config.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) throw new Error('请填写有效的联系邮箱，或留空。')
}
export function splitUTF8(text: string, limit: number) {
  const chunks: string[] = []
  let current = '', size = 0
  for (const char of text) {
    const bytes = encoder.encode(char).length
    if (size + bytes > limit && current) { chunks.push(current); current = ''; size = 0 }
    current += char; size += bytes
  }
  if (current) chunks.push(current)
  return chunks
}
function language(value: string, provider: ServiceKind) {
  if (provider === 'deepl') return ({ 'zh-Hans': 'ZH-HANS', 'zh-Hant': 'ZH-HANT' } as Record<string, string>)[value] || value.toUpperCase()
  if (provider === 'tencent') return ({ 'zh-Hans': 'zh', 'zh-Hant': 'zh-TW' } as Record<string, string>)[value] || value
  return ({ 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' } as Record<string, string>)[value] || value
}
function translatedText(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 6000) throw new Error('服务返回的译文无效，请重试。')
  return value.trim()
}
async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function hmac(key: Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)))
}
async function pauseTencent(signal: AbortSignal) {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 250)
    signal.addEventListener('abort', abort, { once: true })
  })
}
export async function tencentHeaders(config: TranslationConfig, payload: string, timestamp = Math.floor(Date.now() / 1000)) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const scope = `${date}/tmt/tc3_request`
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:tmt.tencentcloudapi.com\n\ncontent-type;host\n${await sha256(payload)}`
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha256(canonical)}`
  const dateKey = await hmac(encoder.encode('TC3' + config.apiKey.trim()), date)
  const serviceKey = await hmac(dateKey, 'tmt')
  const signingKey = await hmac(serviceKey, 'tc3_request')
  const signature = [...await hmac(signingKey, toSign)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${config.secretId?.trim()}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    timestamp: String(timestamp), region: config.region || 'ap-guangzhou',
  }
}
export async function translateProviderBlocks(blocks: TranslationBlock[], config: TranslationConfig, signal: AbortSignal, request: ServiceRequest, onlyIds: string[], onProgress?: (blocks: TranslationBlock[]) => Promise<void>) {
  validateTranslationConfig(config)
  const pending = blocks.filter((block) => onlyIds.includes(block.id))
  const results = new Map<string, string>()
  let tencentRequested = false
  if (config.provider === 'deepl') {
    const context = [...blocks.map((block) => block.source).join('\n')].slice(0, 6000).join('')
    const options = { target_lang: language(config.targetLanguage, 'deepl'), ...(config.sourceLanguage === 'auto' ? {} : { source_lang: config.sourceLanguage.startsWith('zh-') ? 'ZH' : config.sourceLanguage.toUpperCase() }), context }
    let offset = 0
    while (offset < pending.length) {
      const batch: TranslationBlock[] = []
      while (offset < pending.length && batch.length < 50) {
        const candidate = [...batch, pending[offset]]
        if (batch.length && encoder.encode(JSON.stringify({ ...options, text: candidate.map((item) => item.source) })).length > 120_000) break
        batch.push(pending[offset++])
      }
      throwIfAborted(signal)
      const value = await request('deepl', 'https://api-free.deepl.com/v2/translate', { ...options, text: batch.map((item) => item.source) }, config, signal) as { translations?: { text?: unknown }[] }
      if (!Array.isArray(value.translations) || value.translations.length !== batch.length) throw new Error('DeepL 返回的译文不完整，请重试。')
      batch.forEach((item, index) => results.set(item.id, translatedText(value.translations![index].text)))
      if (onProgress) await onProgress(blocks.map(block => results.has(block.id) ? { ...block, translation: results.get(block.id)! } : block))
    }
  } else {
    if (config.provider === 'mymemory' && config.sourceLanguage === 'auto') throw new Error('MyMemory 需要指定原文语言，请在侧栏选择日语、英语等语言后重试。')
    for (const block of pending) {
      const parts = splitUTF8(block.source, config.provider === 'mymemory' ? 500 : config.provider === 'tencent' ? 1800 : 16_000)
      const translations: string[] = []
      for (const part of parts) {
        throwIfAborted(signal)
        let text: unknown
        if (config.provider === 'mymemory') {
          const value = await request('mymemory', 'https://api.mymemory.translated.net/get', { q: part, langpair: `${language(config.sourceLanguage, 'mymemory')}|${language(config.targetLanguage, 'mymemory')}`, ...(config.email ? { de: config.email } : {}) }, config, signal) as { responseStatus?: number | string; quotaFinished?: boolean; responseData?: { translatedText?: unknown } }
          if (value.quotaFinished || Number(value.responseStatus) === 429) throw new Error('MyMemory 当日免费额度已用完，请明天再试或更换服务。')
          if (Number(value.responseStatus) !== 200) throw new Error('MyMemory 无法翻译这些文字，请检查语言选择或稍后重试。')
          text = value.responseData?.translatedText
        } else if (config.provider === 'tencent') {
          if (tencentRequested) await pauseTencent(signal)
          tencentRequested = true
          const body = { SourceText: part, Source: config.sourceLanguage === 'auto' ? 'auto' : language(config.sourceLanguage, 'tencent'), Target: language(config.targetLanguage, 'tencent'), ProjectId: 0 }
          const headers = await tencentHeaders(config, JSON.stringify(body))
          const value = await request('tencent', 'https://tmt.tencentcloudapi.com/', body, config, signal, headers) as { Response?: { TargetText?: unknown; RequestId?: unknown; Error?: { Code?: string } } }
          if (value.Response?.Error) throw new Error(tencentError(value.Response.Error.Code, value.Response.RequestId))
          text = value.Response?.TargetText
        } else {
          const source = config.sourceLanguage.startsWith('zh-') ? 'zh' : config.sourceLanguage
          const target = config.targetLanguage.startsWith('zh-') ? 'zh' : config.targetLanguage
          if (config.targetLanguage === 'zh-Hant') throw new Error('LibreTranslate 的 zh 输出为简体中文；繁体中文请使用腾讯云或 DeepL。')
          const value = await request('libretranslate', libreEndpoint(config.endpoint), { q: part, source, target, format: 'text', ...(config.apiKey ? { api_key: config.apiKey } : {}) }, config, signal) as { translatedText?: unknown; error?: unknown }
          if (value.error) throw new Error('LibreTranslate 无法翻译，请检查语言模型、密钥和服务额度。')
          text = value.translatedText
        }
        translations.push(translatedText(text))
      }
      results.set(block.id, translatedText(translations.join('\n')))
      if (onProgress) await onProgress(blocks.map(block => results.has(block.id) ? { ...block, translation: results.get(block.id)! } : block))
    }
  }
  return blocks.map((block) => results.has(block.id) ? { ...block, translation: results.get(block.id)! } : block)
}
