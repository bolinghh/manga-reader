<script setup lang="ts">
import type { TranslationBlock, TranslationRecord } from '../types/translation'
import { translationLanguages } from '../stores/translation'
import Icon from './Icon.vue'
import TranslationText from './TranslationText.vue'
defineProps<{ pageIndex: number; records: TranslationRecord[]; busy: boolean; busyPage: number | null; phase: string; error: string; notice: string; ready: boolean; sourceLanguage: string; targetLanguage: string; activeId: string | null }>()
const emit = defineEmits<{
  (e: 'close'): void; (e: 'settings'): void; (e: 'translate', force: boolean): void; (e: 'region'): void; (e: 'cancel'): void; (e: 'retry'): void; (e: 'clear'): void
  (e: 'batch'): void
  (e: 'update:sourceLanguage', value: string): void; (e: 'update:targetLanguage', value: string): void
  (e: 'locate', pageIndex: number, block: TranslationBlock): void; (e: 'correct', pageIndex: number, id: string, source: string): void
}>()
</script>
<template>
  <aside class="translation-panel" aria-labelledby="translation-panel-title" @wheel.stop @pointerdown.stop @touchstart.stop>
    <header class="translation-panel-header">
      <div><p class="section-kicker">READ / TRANSLATE</p><h2 id="translation-panel-title" class="text-lg">译文对照 <span class="translation-muted text-xs">第 {{ pageIndex + 1 }} 页</span></h2></div>
      <div class="translation-row">
        <button type="button" class="icon-button" title="翻译服务设置" aria-label="翻译服务设置" @click="emit('settings')"><Icon name="settings" :size="17" /></button>
        <button type="button" class="icon-button" title="收起对照侧栏" aria-label="收起对照侧栏" @click="emit('close')"><Icon name="x" :size="17" /></button>
      </div>
    </header>
    <div class="translation-panel-controls">
      <div class="translation-language-row">
        <label>原文<select :value="sourceLanguage" :disabled="busy" class="translation-input" @change="emit('update:sourceLanguage', ($event.target as HTMLSelectElement).value)"><option v-for="language in translationLanguages" :key="language.value" :value="language.value">{{ language.label }}</option></select></label>
        <Icon name="arrow-right" :size="16" />
        <label>译文<select :value="targetLanguage" :disabled="busy" class="translation-input" @change="emit('update:targetLanguage', ($event.target as HTMLSelectElement).value)"><option v-for="language in translationLanguages.filter((l) => l.value !== 'auto')" :key="language.value" :value="language.value">{{ language.label }}</option></select></label>
      </div>
      <div class="translation-row mt-3">
        <button type="button" class="comic-btn comic-btn--accent flex-1" :disabled="busy" @click="ready ? emit('translate', false) : emit('settings')"><Icon name="languages" :size="16" />{{ ready ? '翻译当前页' : '配置翻译服务' }}</button>
        <button type="button" class="comic-btn" :disabled="busy" @click="emit('region')"><Icon name="scan-line" :size="16" />框选</button>
      </div>
      <div v-if="busy" class="translation-row mt-3" role="status" aria-live="polite"><span class="translation-spinner" /><span class="translation-muted flex-1">第 {{ (busyPage ?? pageIndex) + 1 }} 页 · {{ phase }}</span><button type="button" class="translation-link" @click="emit('cancel')">取消</button></div>
      <p v-if="notice" role="status" class="translation-muted mt-3">{{ notice }}</p>
      <div v-if="error" role="alert" class="translation-error mt-3"><p>{{ error }}</p><button type="button" class="translation-link mt-2" @click="emit('retry')">重试</button><button type="button" class="translation-link ml-3" @click="emit('settings')">检查设置</button></div>
    </div>
    <button type="button" class="comic-btn mx-4 mb-3" :disabled="!ready" @click="emit('batch')"><Icon name="layers" :size="16" />批量翻译</button>
    <div class="translation-panel-results">
      <template v-if="records.some((record) => record.blocks.length)">
        <section v-for="record in records" :key="record.pageIndex">
          <h3 v-if="records.length > 1" class="translation-muted mb-2">第 {{ record.pageIndex + 1 }} 页</h3>
          <article v-for="(block, index) in record.blocks" :key="block.id" class="translation-entry" :class="{ 'is-active': activeId === `${record.pageIndex}:${block.id}` }">
            <button type="button" class="translation-locate" @click="emit('locate', record.pageIndex, block)"><span class="translation-entry-number">{{ String(index + 1).padStart(2, '0') }}</span><span>对白 {{ index + 1 }}</span><Icon name="locate" :size="14" /></button>
            <TranslationText :block="block" :busy="busy" @correct="emit('correct', record.pageIndex, block.id, $event)" />
          </article>
        </section>
      </template>
      <div v-else class="translation-empty"><Icon name="languages" :size="30" /><p class="mt-3 font-semibold">读懂每一段对白</p><p class="translation-muted mt-2">翻译当前页后，点击漫画中的编号查看译文。漏掉的文字可以框选补译。</p></div>
    </div>
    <footer class="translation-panel-footer"><button type="button" class="translation-link" :disabled="busy || !ready" @click="emit('translate', true)"><Icon name="refresh" :size="14" />重新识别本页</button><button type="button" class="translation-link" :disabled="busy" @click="emit('clear')">清除此书缓存</button></footer>
  </aside>
</template>
