<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { translationProviders, useTranslationSettings } from '../stores/translation'
import { checkLocalOCR, prepareLocalOCR, translateBlocks } from '../services/translation'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { validateTranslationConfig } from '../services/translationProviders'
import type { TranslationConfig } from '../types/translation'
import { useOverlayFocus } from '../composables/useOverlayFocus'
import Icon from './Icon.vue'
const props = withDefaults(defineProps<{ modelValue: boolean; sourceLanguage?: string }>(), { sourceLanguage: 'ja' })
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()
const settings = useTranslationSettings()
const open = ref(props.modelValue), dialog = ref<HTMLElement>()
const endpoint = ref(''), model = ref(''), apiKey = ref(''), jsonMode = ref(true), error = ref('')
const provider = ref<TranslationConfig['provider']>('mymemory'), ocrEndpoint = ref(''), secretId = ref(''), region = ref('ap-guangzhou'), email = ref('')
const checking = ref(false), ocrStatus = ref('')
const native = isTauri(), preparing = ref(false), testing = ref(false), testStatus = ref('')
const modelNames: Record<string, string> = { auto: 'japan', ja: 'japan', en: 'en', ko: 'korean', 'zh-Hans': 'ch', 'zh-Hant': 'chinese_cht', fr: 'latin', es: 'latin', de: 'latin' }
let testController: AbortController | null = null
const selected = computed(() => translationProviders.find((item) => item.value === provider.value)!)
let checkController: AbortController | null = null
const overlay = useOverlayFocus(open, dialog)
watch(() => props.modelValue, (value) => {
  open.value = value
  if (value) { provider.value = settings.provider; ocrEndpoint.value = settings.ocrEndpoint; endpoint.value = settings.endpoint; model.value = settings.model; apiKey.value = settings.apiKey; jsonMode.value = settings.jsonMode; secretId.value = settings.secretId; region.value = settings.region; email.value = settings.email; error.value = ''; ocrStatus.value = ''; testStatus.value = '' }
}, { immediate: true })
function close() { checkController?.abort(); testController?.abort(); checkController = null; preparing.value = false; checking.value = false; testing.value = false; emit('update:modelValue', false) }
function changeProvider(event: Event) { provider.value = (event.target as HTMLSelectElement).value as TranslationConfig['provider']; apiKey.value = ''; error.value = '' }
async function checkOCR() {
  checkController?.abort()
  const control = new AbortController(); checkController = control
  checking.value = true; ocrStatus.value = ''
  const timeout = window.setTimeout(() => control.abort(), 10_000)
  try {
    const health = await checkLocalOCR(ocrEndpoint.value, control.signal)
    const state = health.models?.[modelNames[props.sourceLanguage]]
    if (open.value && checkController === control) ocrStatus.value = `本地 OCR 已连接。${state?.stage || '可点击准备所选语言模型。'}`
  } catch { if (open.value && checkController === control) ocrStatus.value = '未连接到本地 OCR。请先运行 ocr/start-ocr.cmd；首次使用先运行 setup-ocr.cmd。' }
  finally { window.clearTimeout(timeout); if (checkController === control) checking.value = false }
}
function draftConfig(): TranslationConfig { return { provider: provider.value, ocrEndpoint: ocrEndpoint.value, endpoint: endpoint.value, model: model.value, apiKey: apiKey.value, secretId: secretId.value, region: region.value, email: email.value, jsonMode: jsonMode.value, sourceLanguage: props.sourceLanguage === 'auto' ? 'ja' : props.sourceLanguage, targetLanguage: 'zh-Hans', readingDirection: 'rtl' } }
async function startOCR() {
  checking.value = true; ocrStatus.value = '正在启动本地 OCR…'
  const control = new AbortController(); checkController?.abort(); checkController = control
  try {
    try { await checkLocalOCR(ocrEndpoint.value, control.signal); ocrStatus.value = '本地 OCR 已在运行。'; return } catch { /* start only when not running */ }
    await invoke('start_local_ocr', { endpoint: ocrEndpoint.value })
    for (let attempt = 0; attempt < 15; attempt++) {
      if (control.signal.aborted) return
      await new Promise(resolve => setTimeout(resolve, 1000))
      try { await checkLocalOCR(ocrEndpoint.value, control.signal); if (!control.signal.aborted) ocrStatus.value = '本地 OCR 已启动。'; return } catch { /* startup still in progress */ }
    }
    throw new Error('启动尚未完成，请稍后点击“检测 OCR”。')
  } catch (cause) { if (!control.signal.aborted) ocrStatus.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (checkController === control) checking.value = false }
}
async function prepareModel() {
  const control = new AbortController(); checkController?.abort(); checkController = control
  preparing.value = true; ocrStatus.value = '正在准备所选语言模型…'
  try {
    const health = await checkLocalOCR(ocrEndpoint.value, control.signal)
    if (!health.modelPreparation) throw new Error('请重启更新后的 OCR 服务，再准备模型。')
    await prepareLocalOCR(ocrEndpoint.value, props.sourceLanguage, control.signal)
    for (let attempt = 0; attempt < 600; attempt++) {
      if (control.signal.aborted) return
      const status = (await checkLocalOCR(ocrEndpoint.value, control.signal)).models?.[modelNames[props.sourceLanguage]]
      if (control.signal.aborted) return
      ocrStatus.value = status?.stage || '等待模型准备…'
      if (status?.state === 'ready') { ocrStatus.value = '所选语言模型已就绪。'; return }
      if (status?.state === 'error') throw new Error(status.stage)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    ocrStatus.value = '模型仍在准备，可稍后再次检测。'
  } catch (cause) { if (!control.signal.aborted) ocrStatus.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (checkController === control) preparing.value = false }
}
async function testTranslation() {
  testController?.abort(); const control = new AbortController(); testController = control
  testing.value = true; testStatus.value = ''
  try {
    const config = { ...draftConfig(), sourceLanguage: 'ja' }
    validateTranslationConfig(config)
    const translated = await translateBlocks([{ id: 'test', source: 'こんにちは', translation: '', uncertain: false, rect: { x: 0, y: 0, width: 1, height: 1 } }], config, control.signal)
    if (!control.signal.aborted) testStatus.value = `文字翻译已连接：${translated[0]!.translation}`
  } catch (cause) { if (!control.signal.aborted) testStatus.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (testController === control) testing.value = false }
}
onBeforeUnmount(() => { checkController?.abort(); testController?.abort() })
function save() {
  try {
    validateTranslationConfig({ provider: provider.value, ocrEndpoint: ocrEndpoint.value, endpoint: endpoint.value, model: model.value, apiKey: apiKey.value, secretId: secretId.value, region: region.value, email: email.value, jsonMode: jsonMode.value, sourceLanguage: 'ja', targetLanguage: 'zh-Hans', readingDirection: 'rtl' })
    settings.provider = provider.value; settings.ocrEndpoint = ocrEndpoint.value.trim(); settings.secretId = secretId.value.trim(); settings.region = region.value.trim(); settings.email = email.value.trim()
    settings.endpoint = endpoint.value.trim(); settings.model = model.value.trim(); settings.apiKey = apiKey.value.trim(); settings.jsonMode = jsonMode.value
    close()
  } catch (cause) { error.value = (cause as Error).message }
}
</script>
<template>
  <Transition name="view">
    <div v-if="modelValue" class="translation-settings-scrim" @click.self="close" @keydown.esc.stop.prevent="close" @keydown="overlay.trap($event)" @wheel.stop @pointerdown.stop>
      <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="translation-settings-title" class="translation-settings-card card">
        <header class="translation-row justify-between">
          <div><p class="section-kicker">TRANSLATION / CONNECTION</p><h2 id="translation-settings-title" class="mt-1 text-xl">翻译服务设置</h2></div>
          <button type="button" class="icon-button" aria-label="关闭翻译服务设置" @click="close"><Icon name="x" /></button>
        </header>
        <p class="translation-muted mt-3">漫画图片由本机 OCR 识别，仅识别文字会发送到你选择的翻译服务。无需图片模型。</p>
        <form class="translation-settings-form" @submit.prevent="save">
          <label for="translation-ocr">本地 OCR 地址</label>
          <input id="translation-ocr" v-model="ocrEndpoint" type="url" class="translation-input" placeholder="http://127.0.0.1:8876" autocomplete="off" required />
          <div class="translation-row flex-wrap"><button type="button" class="comic-btn" :disabled="checking || preparing" @click="checkOCR">{{ checking ? '检测中…' : '检测 OCR' }}</button><button v-if="native" type="button" class="comic-btn" :disabled="checking || preparing" @click="startOCR">启动 OCR</button><button type="button" class="comic-btn" :disabled="checking || preparing" @click="prepareModel">{{ preparing ? '模型准备中…' : '准备所选语言模型' }}</button></div>
          <p class="translation-muted">使用 RapidOCR 在本机识别。首次使用需安装并启动本地 OCR；原文语言会决定识别模型，自动模式使用日语模型。</p>
          <p v-if="ocrStatus" class="translation-muted" role="status">{{ ocrStatus }}</p>
          <label for="translation-provider">文字翻译服务</label>
          <select id="translation-provider" :value="provider" class="translation-input" @change="changeProvider"><option v-for="item in translationProviders" :key="item.value" :value="item.value">{{ item.label }}</option></select>
          <p class="translation-muted">{{ selected.hint }} <a v-if="selected.url" :href="selected.url" class="translation-link" target="_blank" rel="noopener noreferrer">查看官方说明</a></p>
          <template v-if="provider === 'compatible' || provider === 'libretranslate'">
            <label for="translation-endpoint">服务地址</label>
            <input id="translation-endpoint" v-model="endpoint" type="url" class="translation-input" :placeholder="provider === 'compatible' ? 'https://服务域名/v1' : 'http://127.0.0.1:5000'" autocomplete="off" required />
          </template>
          <template v-if="provider === 'compatible'">
            <label for="translation-model">文字模型名称</label><input id="translation-model" v-model="model" class="translation-input" placeholder="填写服务商提供的文字模型名称" autocomplete="off" required />
          </template>
          <template v-if="provider === 'tencent'">
            <label for="translation-secret-id">SecretId</label><input id="translation-secret-id" v-model="secretId" class="translation-input" autocomplete="off" required />
            <label for="translation-region">地域</label><input id="translation-region" v-model="region" class="translation-input" placeholder="ap-guangzhou" autocomplete="off" required />
          </template>
          <template v-if="provider !== 'mymemory'">
            <label for="translation-key">{{ provider === 'tencent' ? 'SecretKey' : 'API 密钥' }} <span v-if="provider === 'compatible' || provider === 'libretranslate'" class="translation-muted">（服务无需认证时可留空）</span></label>
            <input id="translation-key" v-model="apiKey" type="password" class="translation-input" placeholder="仅保留在本次会话" autocomplete="off" spellcheck="false" :required="provider === 'deepl' || provider === 'tencent'" />
            <p class="translation-muted">密钥仅保留在本次会话，重新启动后需再次填写。</p>
          </template>
          <details v-if="provider === 'mymemory'" class="translation-original"><summary>可选：提高每日额度</summary><label for="translation-email" class="translation-muted">联系邮箱</label><input id="translation-email" v-model="email" type="email" class="translation-input mt-2" autocomplete="off" /><p class="translation-muted mt-2">填写后会将邮箱发送给 MyMemory，用于联系及提高额度；可留空，仅保留在本次会话。</p></details>
          <details v-if="provider === 'compatible'" class="translation-original">
            <summary>兼容性选项</summary>
            <label class="translation-row mt-2"><input v-model="jsonMode" type="checkbox" />请求 JSON 模式</label>
            <p class="translation-muted mt-2">如果服务提示不支持输出格式，可以关闭后重试。</p>
          </details>
          <p v-if="error" role="alert" class="translation-error">{{ error }}</p>
          <div class="translation-row"><button type="button" class="comic-btn" :disabled="testing" @click="testTranslation">{{ testing ? '测试中…' : '测试文字翻译' }}</button><span class="translation-muted">使用一句日语问候验证接口。</span></div>
          <p v-if="testStatus" class="translation-muted break-words" role="status">{{ testStatus }}</p>
          <div class="translation-row justify-end mt-3"><button type="button" class="comic-btn" @click="close">取消</button><button type="submit" class="comic-btn comic-btn--accent">保存设置</button></div>
        </form>
      </section>
    </div>
  </Transition>
</template>
