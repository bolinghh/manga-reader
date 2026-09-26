import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { TranslationConfig } from '../types/translation'

export const translationProviders = [
  { value: 'mymemory', label: 'MyMemory · 无需密钥', hint: '匿名每天 5,000 字符；可选提供邮箱提高额度。需要指定原文语言。', url: 'https://mymemory.translated.net/doc/usagelimits.php' },
  { value: 'tencent', label: '腾讯云 · 每月免费额度', hint: '文本翻译每月 500 万字符；需开通服务并填写 SecretId、SecretKey。', url: 'https://cloud.tencent.com/document/product/551/35017' },
  { value: 'deepl', label: 'DeepL API Free', hint: '每月 50 万字符；需注册 API Free 并获取密钥。', url: 'https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans' },
  { value: 'libretranslate', label: 'LibreTranslate · 自托管', hint: '开源服务可在本机免费部署；公共服务的额度与密钥要求由运营者决定。', url: 'https://github.com/LibreTranslate/LibreTranslate' },
  { value: 'compatible', label: '兼容 API · 文字模型', hint: '保留自定义服务，只需支持文字输入；收费与额度由服务商决定。', url: '' },
] as const

export const translationLanguages = [
  { value: 'auto', label: '自动识别' }, { value: 'ja', label: '日语' },
  { value: 'en', label: '英语' }, { value: 'ko', label: '韩语' },
  { value: 'zh-Hans', label: '简体中文' }, { value: 'zh-Hant', label: '繁体中文' },
  { value: 'fr', label: '法语' }, { value: 'es', label: '西班牙语' }, { value: 'de', label: '德语' },
]
export const useTranslationSettings = defineStore('translationSettings', () => {
  let saved: { provider?: TranslationConfig['provider']; ocrEndpoint?: string; endpoint?: string; model?: string; jsonMode?: boolean; secretId?: string; region?: string } = {}
  try { saved = JSON.parse(localStorage.getItem('mangareader.translationSettings') || '{}') || {} } catch { /* defaults */ }
  const endpoint = ref(typeof saved.endpoint === 'string' ? saved.endpoint : '')
  const model = ref(typeof saved.model === 'string' ? saved.model : '')
  const jsonMode = ref(saved.jsonMode !== false)
  const provider = ref<TranslationConfig['provider']>(translationProviders.some((item) => item.value === saved.provider) ? saved.provider! : saved.endpoint && saved.model ? 'compatible' : 'mymemory')
  const ocrEndpoint = ref(typeof saved.ocrEndpoint === 'string' ? saved.ocrEndpoint : 'http://127.0.0.1:8876')
  const secretId = ref(typeof saved.secretId === 'string' ? saved.secretId : '')
  const region = ref(typeof saved.region === 'string' ? saved.region : 'ap-guangzhou')
  const email = ref('')
  const apiKey = ref('') // Deliberately kept in memory only.
  const ready = computed(() => !!ocrEndpoint.value.trim() && (provider.value === 'compatible' ? !!endpoint.value.trim() && !!model.value.trim() : provider.value === 'libretranslate' ? !!endpoint.value.trim() : true))
  watch([provider, ocrEndpoint, endpoint, model, jsonMode, secretId, region], () => {
    try { localStorage.setItem('mangareader.translationSettings', JSON.stringify({ provider: provider.value, ocrEndpoint: ocrEndpoint.value, endpoint: endpoint.value, model: model.value, jsonMode: jsonMode.value, secretId: secretId.value, region: region.value })) } catch { /* still usable for this session */ }
  })
  return { provider, ocrEndpoint, endpoint, model, jsonMode, apiKey, secretId, region, email, ready }
})
