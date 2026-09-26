<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ThumbnailProvider } from '../services/thumbnailProvider'

const props = defineProps<{ total: number; current: number; provider: ThumbnailProvider }>()
const emit = defineEmits<{ (e: 'jump', page: number): void }>()

const scroller = ref<HTMLElement | null>(null)
const width = ref(800)
const scrollTop = ref(0)
const viewportHeight = ref(600)
const urls = reactive(new Map<number, string>())
const loading = reactive(new Map<number, number>())
const ROW_HEIGHT = 172
const GAP = 12
const MIN_ITEM_WIDTH = 112
const columns = computed(() => Math.max(2, Math.floor((width.value + GAP) / (MIN_ITEM_WIDTH + GAP))))
const rowCount = computed(() => Math.ceil(props.total / columns.value))
const firstRow = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - 2))
const lastRow = computed(() => Math.min(rowCount.value - 1, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + 2))
const visiblePages = computed(() => {
  const start = firstRow.value * columns.value
  const end = Math.min(props.total, (lastRow.value + 1) * columns.value)
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
})
const topHeight = computed(() => firstRow.value * ROW_HEIGHT)
const bottomHeight = computed(() => Math.max(0, (rowCount.value - lastRow.value - 1) * ROW_HEIGHT))
let generation = 0
let controller = new AbortController()
let ro: ResizeObserver | undefined

async function loadVisible() {
  const my = ++generation
  controller.abort()
  controller = new AbortController()
  const control = controller
  const provider = props.provider
  const pages = [...visiblePages.value]
  provider.retain?.(pages)
  const keep = new Set(pages)
  for (const page of Array.from(urls.keys())) if (!keep.has(page)) urls.delete(page)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(3, pages.length) }, async () => {
    while (next < pages.length && !control.signal.aborted) {
    const page = pages[next++]!
    if (urls.has(page)) continue
    loading.set(page, my)
    try {
      const url = await provider.get(page, control.signal)
      if (my === generation && !control.signal.aborted) urls.set(page, url)
    } catch (error: any) {
      if (error?.name !== 'AbortError') console.warn('Thumbnail failed', page, error)
    } finally {
      if (loading.get(page) === my) loading.delete(page)
    }
    }
  }))
}

function onScroll() {
  if (!scroller.value) return
  scrollTop.value = scroller.value.scrollTop
  viewportHeight.value = scroller.value.clientHeight
}

watch(visiblePages, () => void loadVisible(), { immediate: true })
// provider 换新(换书/文件重解析)时, 旧 provider 已 revoke 其 blob URL; 必须清空本地缓存,
// 否则 loadVisible 见 key 已存在会跳过重取, 于是渲染出已失效的 blob URL -> 裂图。
watch(
  () => props.provider,
  () => {
    urls.clear()
    loading.clear()
    void loadVisible()
  },
)
onMounted(async () => {
  await nextTick()
  const el = scroller.value
  if (!el) return
  width.value = el.clientWidth
  viewportHeight.value = el.clientHeight
  const currentRow = Math.floor(Math.max(0, props.current - 1) / columns.value)
  el.scrollTop = Math.max(0, currentRow * ROW_HEIGHT - el.clientHeight / 3)
  onScroll()
  ro = new ResizeObserver(() => {
    width.value = el.clientWidth
    viewportHeight.value = el.clientHeight
  })
  ro.observe(el)
})
onBeforeUnmount(() => {
  generation++
  controller.abort()
  props.provider.retain?.([])
  ro?.disconnect()
})
</script>

<template>
  <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto pr-1" @scroll.passive="onScroll">
    <div :style="{ height: `${topHeight}px` }" aria-hidden="true" />
    <div class="grid gap-3" :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }">
      <button
        v-for="pageIndex in visiblePages"
        :key="pageIndex"
        class="group relative h-40 overflow-hidden border bg-[color:var(--surface-2)] text-[color:var(--text-dim)]"
        :class="current === pageIndex + 1 ? 'border-[color:var(--accent)] ring-2 ring-[color:var(--accent)]/30' : 'border-[color:var(--line)]'"
        :aria-label="`跳转到第 ${pageIndex + 1} 页`"
        @click="emit('jump', pageIndex + 1)"
      >
        <img v-if="urls.get(pageIndex)" :src="urls.get(pageIndex)" alt="" class="h-full w-full object-contain" />
        <span v-else class="grid h-full place-items-center text-xs">{{ loading.has(pageIndex) ? '生成中…' : '暂无预览' }}</span>
        <span class="absolute bottom-1 right-1 bg-black/75 px-1.5 py-0.5 text-[11px] text-white">{{ pageIndex + 1 }}</span>
      </button>
    </div>
    <div :style="{ height: `${bottomHeight}px` }" aria-hidden="true" />
  </div>
</template>
