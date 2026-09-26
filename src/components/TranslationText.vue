<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import type { TranslationBlock } from '../types/translation'
import Icon from './Icon.vue'
const props = defineProps<{ block: TranslationBlock; busy: boolean }>()
const emit = defineEmits<{ (e: 'correct', source: string): void }>()
const inputId = useId()
const editing = ref(false), draft = ref(props.block.source), copied = ref(false), copyError = ref(false)
watch(() => props.block.source, (source) => { draft.value = source; editing.value = false })
watch(() => props.block.id, () => { draft.value = props.block.source; editing.value = false; copied.value = false; copyError.value = false })
watch(() => props.block.translation, () => { copied.value = false; copyError.value = false })
async function copy() {
  try { await navigator.clipboard.writeText(props.block.translation); copied.value = true; copyError.value = false }
  catch { copyError.value = true }
}
function correct() { if (draft.value.trim()) emit('correct', draft.value) }
</script>
<template>
  <div class="translation-text">
    <p class="translation-output">{{ block.translation }}</p>
    <p v-if="block.uncertain" class="translation-muted">部分文字识别不确定，可展开原文纠正。</p>
    <details class="translation-original">
      <summary>查看原文</summary>
      <template v-if="!editing">
        <p class="translation-source" lang="und">{{ block.source }}</p>
        <button type="button" class="translation-link" :disabled="busy" @click="editing = true; draft = block.source"><Icon name="edit" :size="14" />纠正原文</button>
      </template>
      <form v-else @submit.prevent="correct">
        <label class="sr-only" :for="inputId">识别原文</label>
        <textarea :id="inputId" v-model="draft" rows="3" maxlength="4000" class="translation-input" />
        <div class="translation-row mt-2">
          <button type="submit" class="comic-btn comic-btn--accent" :disabled="busy || !draft.trim()">{{ busy ? '翻译中…' : '保存并重译' }}</button>
          <button type="button" class="comic-btn comic-btn--ghost" :disabled="busy" @click="editing = false">取消</button>
        </div>
      </form>
    </details>
    <button type="button" class="translation-link" @click="copy"><Icon :name="copied ? 'check' : 'copy'" :size="14" />{{ copied ? '已复制' : '复制译文' }}</button>
    <span v-if="copyError" role="status" class="translation-muted">无法自动复制，请选择译文后复制。</span>
  </div>
</template>
