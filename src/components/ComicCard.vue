<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Comic } from '../types'
import { tagLabel, useLibrary } from '../stores/library'
import Icon from './Icon.vue'
import { sourceIssueLabel } from '../utils/library'

const props = defineProps<{ comic: Comic; compact?: boolean; selectable?: boolean; selected?: boolean; index?: number }>()
const emit = defineEmits<{
  (e: 'open', c: Comic): void
  (e: 'remove', id: string): void
  (e: 'edit', comic: Comic): void
  (e: 'reset', id: string): void
  (e: 'favorite', id: string): void
  (e: 'rescan', id: string): void
  (e: 'relink', id: string): void
  (e: 'delete-source', comic: Comic): void
  (e: 'toggle', id: string): void
}>()
const menuOpen = ref(false)
const lib = useLibrary()
const coverUrl = ref('')
let coverGeneration = 0
const menuTrigger = ref<HTMLButtonElement>()
const menuEl = ref<HTMLElement>()
const menuStyle = ref<Record<string, string>>({})

const badge = computed(() => (props.comic.format === 'pdf' ? 'PDF' : '图片'))
const progress = computed(() =>
  props.comic.totalPages ? Math.min(100, Math.round((props.comic.lastPosition / props.comic.totalPages) * 100)) : 0
)

function activate() {
  props.selectable ? emit('toggle', props.comic.id) : emit('open', props.comic)
}

function positionMenu() {
  const trigger = menuTrigger.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const width = 176
  const viewportGap = 12
  const height = menuEl.value?.offsetHeight || 220
  const left = Math.min(
    Math.max(viewportGap, rect.right - width),
    Math.max(viewportGap, window.innerWidth - width - viewportGap),
  )
  let top = rect.bottom + 6
  if (top + height > window.innerHeight - viewportGap) top = Math.max(viewportGap, rect.top - height - 6)
  menuStyle.value = { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` }
}

async function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) {
    positionMenu()
    await nextTick()
    positionMenu()
  }
}

function closeMenu(restoreFocus = false) {
  menuOpen.value = false
  if (restoreFocus) nextTick(() => menuTrigger.value?.focus())
}

function onOutsidePointer(event: PointerEvent) {
  const target = event.target as Node
  if (!menuEl.value?.contains(target) && !menuTrigger.value?.contains(target)) closeMenu()
}

function onViewportChange() {
  if (menuOpen.value) closeMenu()
}

watch(menuOpen, (open) => {
  if (open) {
    window.addEventListener('pointerdown', onOutsidePointer, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
  } else {
    window.removeEventListener('pointerdown', onOutsidePointer, true)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
  }
})

watch(() => props.comic.id, async (id, previous) => {
  const generation = ++coverGeneration
  if (previous) lib.releaseCoverUrl(previous)
  const url = await lib.acquireCoverUrl(id, props.comic.cover)
  if (generation === coverGeneration) coverUrl.value = url
  else lib.releaseCoverUrl(id)
}, { immediate: true })

onBeforeUnmount(() => {
  coverGeneration++
  lib.releaseCoverUrl(props.comic.id)
  window.removeEventListener('pointerdown', onOutsidePointer, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <article class="comic-card card card--lift group relative overflow-hidden" :class="compact ? 'comic-card--compact shrink-0' : 'w-full'">
    <button
      type="button"
      class="comic-card__body block w-full cursor-pointer text-left"
      :aria-label="selectable ? `${selected ? '取消选择' : '选择'} ${comic.title}` : `打开 ${comic.title}`"
      @click="activate"
    >
      <div class="comic-card__cover relative m-2 mb-0 aspect-[3/4] w-[calc(100%-1rem)] overflow-hidden border border-[color:var(--line)] bg-[color:var(--surface-2)]">
        <span class="comic-card__issue">NO.{{ String(index || 1).padStart(2, '0') }}</span>
        <img
          v-if="coverUrl"
          :src="coverUrl"
          class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.025]"
          :alt="`${comic.title} 封面`"
        />
        <div v-else class="grid h-full w-full place-items-center bg-[color:var(--surface-3)] text-[color:var(--text-dim)]">
          <Icon name="book-open" :size="40" />
        </div>

        <div
          v-if="selectable"
          class="absolute left-2 top-2 z-10 grid h-7 w-7 place-items-center rounded-full border-2 border-white text-xs font-bold text-transparent shadow-sm transition"
          :class="selected ? 'bg-[color:var(--accent)] text-white' : 'bg-black/45'"
          aria-hidden="true"
        >
          <Icon name="check" :size="14" />
        </div>

        <span class="comic-card__format absolute bottom-3 left-3 px-2 py-1 text-xs font-semibold text-white">
          {{ badge }}
        </span>
        <span v-if="sourceIssueLabel(comic.source)" class="absolute right-2 top-2 rounded-md bg-[color:var(--danger)] px-2 py-1 text-[11px] font-semibold text-white">{{ sourceIssueLabel(comic.source) }}</span>
        <div class="absolute inset-x-0 bottom-0 h-1 bg-black/30" aria-hidden="true">
          <div class="h-full bg-[color:var(--accent)] transition-all duration-200" :style="{ width: progress + '%' }" />
        </div>
      </div>

      <div class="comic-card__info px-3 pb-3 pt-2.5">
        <h3 class="truncate text-sm font-semibold text-[color:var(--text)]" :title="comic.title">{{ comic.title }}</h3>
        <p v-if="!compact" class="mt-0.5 truncate text-xs text-[color:var(--text-dim)]">
          {{ comic.totalPages ? `${comic.totalPages} 页` : '页数未知' }}<span v-if="comic.tags.length"> · {{ tagLabel(comic.tags[0]) }}</span>
        </p>
        <template v-else>
          <p class="mt-2 text-xs tabular-nums text-[color:var(--text-dim)]">{{ comic.lastPosition }} / {{ comic.totalPages }} · {{ progress }}%</p>
          <span class="comic-card__continue">继续阅读 →</span>
        </template>
      </div>
    </button>

    <button
      v-if="!selectable"
      ref="menuTrigger"
      type="button"
      class="comic-card__menu absolute right-3 top-3 grid h-11 w-11 place-items-center border border-white/35 bg-black/65 text-white shadow-sm transition hover:bg-black/85"
      :aria-label="`${comic.title} 的管理菜单`"
      title="管理漫画"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click.stop="toggleMenu"
    >
      <Icon name="more-horizontal" :size="18" />
    </button>
  </article>

  <Teleport to="body">
    <div
      v-if="menuOpen && !selectable"
      ref="menuEl"
      class="import-menu fixed z-[100] w-44"
      :style="menuStyle"
      role="menu"
      @keydown.esc.stop.prevent="closeMenu(true)"
    >
      <button class="import-menu__item" role="menuitem" @click="closeMenu(); emit('edit', comic)"><Icon name="edit" :size="16" /> 编辑书目</button>
      <button class="import-menu__item" role="menuitem" @click="closeMenu(); emit('favorite', comic.id)"><Icon name="bookmark" :size="16" /> {{ comic.favorite ? '取消收藏' : '加入收藏' }}</button>
      <button class="import-menu__item" role="menuitem" @click="closeMenu(); emit('reset', comic.id)"><Icon name="refresh" :size="16" /> 重置进度</button>
      <button v-if="comic.source.type === 'native-dir'" class="import-menu__item" role="menuitem" @click="closeMenu(); emit('rescan', comic.id)"><Icon name="scan-line" :size="16" /> 重新扫描</button>
      <button v-if="comic.source.type === 'native-dir' || comic.source.type === 'native-file'" class="import-menu__item" role="menuitem" @click="closeMenu(); emit('relink', comic.id)"><Icon name="folder-up" :size="16" /> 重新关联</button>
      <button v-else-if="sourceIssueLabel(comic.source)" class="import-menu__item" role="menuitem" @click="closeMenu(); emit('relink', comic.id)"><Icon name="folder-up" :size="16" /> {{ comic.source.type === 'input' || comic.source.type === 'web-cache' ? '重新导入' : '重新授权' }}</button>
      <button v-if="comic.source.type === 'native-dir' || comic.source.type === 'native-file'" class="import-menu__item text-[color:var(--danger)]" role="menuitem" @click="closeMenu(); emit('delete-source', comic)"><Icon name="trash-2" :size="16" /> 删除源文件</button>
      <button class="import-menu__item text-[color:var(--danger)]" role="menuitem" @click="closeMenu(); emit('remove', comic.id)"><Icon name="trash-2" :size="16" /> 移出书架</button>
    </div>
  </Teleport>
</template>
