<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useReadingSettings } from '../stores/settings'
import { focusFirst, trapFocus } from '../utils/focus'
import Icon from './Icon.vue'
import type { Comic } from '../types'
import { useLibrary } from '../stores/library'

const props = defineProps<{ modelValue: boolean; comic: Comic }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()
const settings = useReadingSettings()
const library = useLibrary()
const panel = ref<HTMLElement>()
let opener: HTMLElement | null = null

function close() {
  emit('update:modelValue', false)
}
function rotatePage() {
  const values = [0, 90, 180, 270] as const
  const current = values.indexOf(props.comic.rotation || 0)
  void library.setRotation(props.comic.id, values[(current + 1) % values.length])
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      opener = document.activeElement as HTMLElement | null
      await nextTick()
      focusFirst(panel.value)
    } else {
      opener?.focus()
      opener = null
    }
  },
)
</script>

<template>
  <Transition name="view">
    <div
      v-if="modelValue"
      class="absolute inset-0 z-40 flex justify-end"
      @click.self="close"
      @keydown.esc.stop.prevent="close"
      @keydown="trapFocus($event, panel)"
    >
      <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />

      <aside
        ref="panel"
        class="settings-sheet relative flex h-full w-[380px] max-w-[88vw] flex-col border-l border-[color:var(--line)] bg-[color:var(--surface)] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header class="flex items-start justify-between border-b border-[color:var(--line)] px-6 py-5">
          <div>
            <p class="section-kicker">PRINT ADJUSTMENT / FORM 01</p>
            <h2 id="settings-title" class="mt-1 text-xl font-bold tracking-tight text-[color:var(--text)]">阅读设置</h2>
          </div>
          <button class="icon-button" title="关闭" aria-label="关闭阅读设置" @click="close">
            <Icon name="x" :size="19" />
          </button>
        </header>

        <div class="flex-1 space-y-7 overflow-y-auto px-6 py-6">
          <section aria-labelledby="view-settings-heading">
            <h3 id="view-settings-heading" class="mb-3 text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--text-dim)]"><span class="settings-section-number">01</span>观看效果</h3>
            <div class="panel-section">
              <div class="panel-row">
                <label class="panel-row__label" for="reader-brightness">亮度</label>
                <output class="panel-row__value" for="reader-brightness">{{ Math.round(settings.brightness * 100) }}%</output>
              </div>
              <div class="px-4 pb-5 pt-3">
                <input
                  id="reader-brightness"
                  v-model.number="settings.brightness"
                  type="range"
                  min="0.4"
                  max="1.5"
                  step="0.05"
                  class="range"
                  aria-describedby="brightness-help"
                />
                <p id="brightness-help" class="mt-3 text-xs leading-5 text-[color:var(--text-dim)]">降低页面亮度，减少暗处阅读时的屏幕刺激。</p>
              </div>
            </div>

            <div class="panel-section mt-3">
              <div class="panel-row">
                <label class="panel-row__label" for="reader-warmth">暖色护眼</label>
                <output class="panel-row__value" for="reader-warmth">{{ Math.round(settings.warmth * 100) }}%</output>
              </div>
              <div class="px-4 pb-5 pt-3">
                <input id="reader-warmth" v-model.number="settings.warmth" type="range" min="0" max="1" step="0.05" class="range" aria-describedby="warmth-help" />
                <p id="warmth-help" class="mt-3 text-xs leading-5 text-[color:var(--text-dim)]">叠加柔和暖色，适合夜间或长时间阅读。</p>
              </div>
            </div>
          </section>

          <section aria-labelledby="image-settings-heading">
            <h3 id="image-settings-heading" class="mb-3 text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--text-dim)]"><span class="settings-section-number">02</span>图像增强</h3>
            <div class="panel-section">
              <div class="panel-row items-start">
                <div class="min-w-0 pr-3">
                  <span class="panel-row__label">边缘锐化</span>
                  <p id="sharpen-help" class="mt-1.5 text-xs leading-5 text-[color:var(--text-dim)]">让扫描页的线条和文字更清晰；只处理当前可见页面。</p>
                </div>
                <button
                  class="toggle mt-0.5"
                  :class="settings.sharpen ? 'is-on' : ''"
                  role="switch"
                  :aria-checked="settings.sharpen"
                  aria-label="边缘锐化"
                  aria-describedby="sharpen-help"
                  @click="settings.sharpen = !settings.sharpen"
                />
              </div>

              <div v-if="settings.sharpen" class="space-y-5 border-t border-[color:var(--line)] px-4 py-5">
                <div>
                  <div class="mb-2 flex items-center justify-between text-xs font-semibold text-[color:var(--text)]">
                    <label for="sharpen-strength">锐化强度</label>
                    <output for="sharpen-strength" class="font-normal tabular-nums text-[color:var(--text-dim)]">{{ settings.sharpenStrength.toFixed(1) }}</output>
                  </div>
                  <input id="sharpen-strength" v-model.number="settings.sharpenStrength" type="range" min="0.5" max="3" step="0.1" class="range" />
                </div>
                <div>
                  <div class="mb-2 flex items-center justify-between text-xs font-semibold text-[color:var(--text)]">
                    <label for="sharpen-radius">作用范围</label>
                    <output for="sharpen-radius" class="font-normal tabular-nums text-[color:var(--text-dim)]">{{ settings.sharpenRadius }}</output>
                  </div>
                  <input id="sharpen-radius" v-model.number="settings.sharpenRadius" type="range" min="1" max="3" step="1" class="range" />
                </div>
                <div>
                  <div class="mb-2 flex items-center justify-between text-xs font-semibold text-[color:var(--text)]">
                    <label for="sharpen-threshold">噪点保护</label>
                    <output for="sharpen-threshold" class="font-normal tabular-nums text-[color:var(--text-dim)]">{{ settings.sharpenThreshold }}</output>
                  </div>
                  <input id="sharpen-threshold" v-model.number="settings.sharpenThreshold" type="range" min="0" max="40" step="1" class="range" aria-describedby="threshold-help" />
                  <p id="threshold-help" class="mt-3 text-xs leading-5 text-[color:var(--text-dim)]">数值越高，越能避免放大纸张纹理和扫描噪点。</p>
                </div>
              </div>
            </div>
          </section>

          <section aria-labelledby="layout-settings-heading">
            <h3 id="layout-settings-heading" class="mb-3 text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--text-dim)]"><span class="settings-section-number">03</span>页面校正</h3>
            <div class="panel-section">
              <div class="panel-row">
                <div><span class="panel-row__label">封面单页偏移</span><p class="mt-1 text-xs text-[color:var(--text-dim)]">双页模式先单独显示封面，再从第 2 页配对。</p></div>
                <button class="toggle" :class="comic.spreadOffset === 1 ? 'is-on' : ''" role="switch" :aria-checked="comic.spreadOffset === 1" aria-label="封面单页偏移" @click="library.setSpreadOffset(comic.id, comic.spreadOffset === 1 ? 0 : 1)" />
              </div>
              <div v-if="comic.format === 'images'" class="panel-row">
                <div><span class="panel-row__label">跨页大图自动合并</span><p class="mt-1 text-xs text-[color:var(--text-dim)]">双页模式下自动识别横向跨页图，让它单独占一屏，避免与相邻页错配。</p></div>
                <button class="toggle" :class="comic.autoSpread ? 'is-on' : ''" role="switch" :aria-checked="!!comic.autoSpread" aria-label="跨页大图自动合并" @click="library.setAutoSpread(comic.id, !comic.autoSpread)" />
              </div>
              <div class="panel-row">
                <div><span class="panel-row__label">页面旋转</span><p class="mt-1 text-xs text-[color:var(--text-dim)]">按本书保存，适合方向错误的扫描页。</p></div>
                <button class="comic-btn comic-btn--ghost" @click="rotatePage">{{ comic.rotation || 0 }}°</button>
              </div>
              <div v-if="comic.format === 'images'" class="panel-row">
                <div><span class="panel-row__label">自动裁除纯色页边</span><p class="mt-1 text-xs text-[color:var(--text-dim)]">仅在页面进入可视窗口时处理。</p></div>
                <button class="toggle" :class="comic.autoCrop ? 'is-on' : ''" role="switch" :aria-checked="!!comic.autoCrop" aria-label="自动裁除纯色页边" @click="library.setAutoCrop(comic.id, !comic.autoCrop)" />
              </div>
            </div>
          </section>

          <button class="btn btn--ghost w-full text-sm" @click="settings.reset()">恢复默认阅读设置</button>
        </div>
      </aside>
    </div>
  </Transition>
</template>
