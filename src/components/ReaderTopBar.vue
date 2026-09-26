<script setup lang="ts">
import type { ComicFormat } from '../types'
import Icon from './Icon.vue'

defineProps<{
  title: string
  format: ComicFormat
  position: number
  total: number
  bookmarked: boolean
  locked: boolean
  translationEnabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'go'): void
  (e: 'bookmark'): void
  (e: 'bookmarks'): void
  (e: 'thumbnails'): void
  (e: 'fullscreen'): void
  (e: 'settings'): void
  (e: 'toggle-lock'): void
  (e: 'translation'): void
}>()
</script>

<template>
  <div class="reader-top-bar glass-bar pointer-events-auto">
    <button class="icon-button" title="返回书架" aria-label="返回书架" @click="emit('back')">
      <Icon name="arrow-left" :size="19" />
    </button>

    <div class="min-w-0 flex-1 px-1">
      <div class="reader-bar-kicker mb-0.5 font-[var(--font-condensed)] text-[10px] font-bold tracking-[0.14em] text-[color:var(--accent)]">CURRENT EDITION</div>
      <div class="truncate text-sm font-semibold text-[color:var(--text)]" :title="title">{{ title }}</div>
      <div class="reader-bar-format mt-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-dim)]">
        {{ format === 'pdf' ? 'PDF DOCUMENT' : 'IMAGE COMIC' }}
      </div>
    </div>

    <button class="reader-page-button" title="跳转页码" @click="emit('go')">
      <span class="tabular-nums">{{ position }} / {{ total }}</span>
      <span class="sr-only">页，点击跳转</span>
    </button>

    <button
      class="icon-button"
      :class="bookmarked ? 'reader-action-active' : ''"
      :aria-pressed="bookmarked"
      :title="bookmarked ? '移除当前页书签' : '添加当前页书签'"
      :aria-label="bookmarked ? '移除当前页书签' : '添加当前页书签'"
      @click="emit('bookmark')"
    >
      <Icon name="bookmark" :size="18" />
    </button>
    <button class="icon-button" title="本书书签" aria-label="本书书签" @click="emit('bookmarks')">
      <Icon name="list-checks" :size="18" />
    </button>
    <button class="icon-button" title="页缩略图" aria-label="打开页缩略图" @click="emit('thumbnails')">
      <Icon name="grid" :size="18" />
    </button>
    <button class="icon-button" title="全屏" aria-label="切换全屏" @click="emit('fullscreen')">
      <Icon name="maximize" :size="18" />
    </button>
    <button class="reader-translation-button" :class="translationEnabled ? 'reader-action-active' : ''" :aria-pressed="!!translationEnabled" title="切换翻译模式 (T)" @click="emit('translation')"><Icon name="languages" :size="18" /><span>翻译</span></button>
    <button class="icon-button" title="阅读设置" aria-label="阅读设置" @click="emit('settings')">
      <Icon name="sliders-horizontal" :size="18" />
    </button>
    <button
      class="icon-button"
      :class="locked ? 'reader-action-active' : ''"
      :title="locked ? '取消固定控制栏' : '固定控制栏'"
      :aria-label="locked ? '取消固定控制栏' : '固定控制栏'"
      :aria-pressed="locked"
      @click="emit('toggle-lock')"
    >
      <Icon :name="locked ? 'pin' : 'eye'" :size="18" />
    </button>
  </div>
</template>
