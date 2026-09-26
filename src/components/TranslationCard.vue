<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { TranslationActivation } from '../types/translation'
import TranslationText from './TranslationText.vue'
import Icon from './Icon.vue'
const props = defineProps<{ active: TranslationActivation; busy: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'correct', source: string): void }>()
const style = ref({ left: '16px', top: '124px', width: '320px', visibility: 'hidden' as 'visible' | 'hidden' })
const card = ref<HTMLElement>()
let frame = 0
function follow() {
  if (!props.active.anchor.isConnected) { emit('close'); return }
  const rect = props.active.anchor.getBoundingClientRect()
  const stage = props.active.anchor.closest('.reader-stage')?.getBoundingClientRect()
  const stageLeft = stage?.left || 0, stageRight = stage?.right ?? window.innerWidth
  const width = Math.min(320, stageRight - stageLeft - 24)
  const height = card.value?.offsetHeight || 240
  const left = Math.max(stageLeft + 12, Math.min(rect.right + 12 + width < stageRight ? rect.right + 12 : rect.left - width - 12, stageRight - width - 12))
  const top = Math.max(124, Math.min(rect.top, window.innerHeight - height - 12))
  const next = { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, width: `${Math.round(width)}px`, visibility: (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < stageLeft || rect.left > stageRight ? 'hidden' : 'visible') as 'visible' | 'hidden' }
  if (next.left !== style.value.left || next.top !== style.value.top || next.width !== style.value.width || next.visibility !== style.value.visibility) style.value = next
  frame = requestAnimationFrame(follow)
}
onMounted(() => { frame = requestAnimationFrame(follow) })
onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>
<template>
  <Teleport to="body">
    <section ref="card" class="translation-card" :style="style" role="region" aria-label="气泡译文" @wheel.stop @keydown.esc.stop.prevent="emit('close')">
      <header class="translation-row justify-between mb-3"><span class="translation-muted">第 {{ active.pageIndex + 1 }} 页 · 气泡译文</span><button type="button" class="icon-button" aria-label="关闭气泡译文" @click="emit('close')"><Icon name="x" :size="16" /></button></header>
      <TranslationText :block="active.block" :busy="busy" @correct="emit('correct', $event)" />
    </section>
  </Teleport>
</template>
