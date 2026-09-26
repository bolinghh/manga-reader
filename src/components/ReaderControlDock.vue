<script setup lang="ts">
import type { ReaderUiState } from '../types'
import Icon from './Icon.vue'

defineProps<{ state: ReaderUiState }>()

const emit = defineEmits<{
  (e: 'zoom', delta: number): void
  (e: 'toggle-read-mode'): void
  (e: 'set-mode', mode: 'single' | 'double'): void
  (e: 'set-dir', dir: 'ltr' | 'rtl'): void
  (e: 'cycle-fit'): void
}>()

const fitLabel = (fit: ReaderUiState['fit']) =>
  fit === 'width' ? '适应宽度' : fit === 'height' ? '适应高度' : '原始尺寸'
</script>

<template>
  <div class="reader-control-dock glass-bar pointer-events-auto" aria-label="阅读显示控制">
    <span class="reader-dock-label" aria-hidden="true">TYPE / TOOL</span>
    <div class="reader-control-group" aria-label="缩放">
      <button class="dock-icon-button" title="缩小" aria-label="缩小" @click="emit('zoom', -0.2)">
        <Icon name="minus" :size="17" />
      </button>
      <span class="min-w-[52px] text-center text-xs font-semibold tabular-nums text-[color:var(--text)]">{{ Math.round(state.zoom * 100) }}%</span>
      <button class="dock-icon-button" title="放大" aria-label="放大" @click="emit('zoom', 0.2)">
        <Icon name="plus" :size="17" />
      </button>
    </div>

    <div class="reader-dock-divider" />

    <button class="dock-text-button" :class="state.readMode === 'webtoon' ? 'is-active' : ''" @click="emit('toggle-read-mode')">
      <Icon name="layers" :size="17" />
      {{ state.readMode === 'webtoon' ? '滚动阅读' : '翻页阅读' }}
    </button>

    <template v-if="state.readMode === 'page'">
      <button class="dock-text-button" :title="`当前：${fitLabel(state.fit)}`" @click="emit('cycle-fit')">
        {{ fitLabel(state.fit) }}
      </button>

      <div class="reader-control-group" aria-label="单双页模式">
        <button class="dock-text-button compact" :class="state.pageMode === 'single' ? 'is-active' : ''" @click="emit('set-mode', 'single')">单页</button>
        <button class="dock-text-button compact" :class="state.pageMode === 'double' ? 'is-active' : ''" @click="emit('set-mode', 'double')">
          <Icon name="columns-2" :size="16" /> 双页
        </button>
      </div>

      <button
        v-if="state.pageMode === 'double'"
        class="dock-text-button"
        :title="state.pageDir === 'rtl' ? '当前从右向左阅读' : '当前从左向右阅读'"
        @click="emit('set-dir', state.pageDir === 'rtl' ? 'ltr' : 'rtl')"
      >
        <Icon name="arrow-left-right" :size="17" />
        {{ state.pageDir === 'rtl' ? 'RTL' : 'LTR' }}
      </button>
    </template>
  </div>
</template>
