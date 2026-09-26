<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TranslationActivation, TranslationLayerState, TranslationRect, TranslationSelection } from '../types/translation'
import { pagePoint } from '../utils/translationImage'

const props = defineProps<{ pageIndex: number; state?: TranslationLayerState; rotation: number }>()
const emit = defineEmits<{ (e: 'select', value: TranslationActivation): void; (e: 'region', value: TranslationSelection): void }>()
const surface = ref<HTMLElement>()
const start = ref<{ x: number; y: number } | null>(null)
const end = ref<{ x: number; y: number } | null>(null)
let pointer: number | null = null
const blocks = computed(() => props.state?.pages[props.pageIndex] || [])
const selection = computed<TranslationRect | null>(() => start.value && end.value ? { x: Math.min(start.value.x, end.value.x), y: Math.min(start.value.y, end.value.y), width: Math.abs(end.value.x - start.value.x), height: Math.abs(end.value.y - start.value.y) } : null)
const boxStyle = (rect: TranslationRect) => ({ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` })
function reset() { start.value = null; end.value = null; pointer = null }
watch(() => props.state?.selecting, reset)
function down(event: PointerEvent) {
  if (!props.state?.selecting || event.button !== 0 || !surface.value) return
  event.preventDefault()
  pointer = event.pointerId
  start.value = pagePoint(event.clientX, event.clientY, surface.value.getBoundingClientRect(), props.rotation)
  end.value = start.value
  surface.value.setPointerCapture(event.pointerId)
}
function move(event: PointerEvent) {
  if (pointer !== event.pointerId || !surface.value) return
  end.value = pagePoint(event.clientX, event.clientY, surface.value.getBoundingClientRect(), props.rotation)
}
function up(event: PointerEvent) {
  if (pointer !== event.pointerId) return
  move(event)
  const rect = selection.value
  const bounds = surface.value?.getBoundingClientRect()
  if (surface.value?.hasPointerCapture(event.pointerId)) surface.value.releasePointerCapture(event.pointerId)
  reset()
  if (rect && bounds && rect.width * bounds.width > 8 && rect.height * bounds.height > 8) emit('region', { pageIndex: props.pageIndex, rect })
}
function activate(event: MouseEvent, block: typeof blocks.value[number]) {
  emit('select', { pageIndex: props.pageIndex, block, anchor: event.currentTarget as HTMLElement })
}
</script>

<template>
  <div v-if="state?.enabled" ref="surface" class="translation-layer" :class="{ 'is-selecting': state.selecting }" :data-translation-page="pageIndex"
    @pointerdown.stop="down" @pointermove.stop="move" @pointerup.stop="up" @pointercancel.stop="reset" @lostpointercapture="reset" @touchstart.stop @touchmove.stop @touchend.stop @click.stop>
    <button v-for="(block, index) in blocks" v-show="!state.selecting" :key="block.id" type="button" class="translation-region"
      :class="{ 'is-active': state.activeId === `${pageIndex}:${block.id}` }" :style="boxStyle(block.rect)" :data-block-id="block.id"
      :aria-label="`对白 ${index + 1}：${block.translation}`" :title="`查看对白 ${index + 1} 的译文`" @click="activate($event, block)">
      <span class="translation-region-number" :style="{ transform: `rotate(${-rotation}deg)` }">{{ index + 1 }}</span>
    </button>
    <div v-if="selection" class="translation-selection" :style="boxStyle(selection)" />
  </div>
</template>
