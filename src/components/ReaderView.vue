<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type { Comic, ReaderController, ReaderFile, ReaderUiState } from '../types'
import { useLibrary } from '../stores/library'
import { useReadingSettings } from '../stores/settings'
import ReaderTopBar from './ReaderTopBar.vue'
import ReaderControlDock from './ReaderControlDock.vue'
import SettingsPanel from './SettingsPanel.vue'
import Icon from './Icon.vue'
import VirtualThumbnailGrid from './VirtualThumbnailGrid.vue'
import { useOverlayFocus } from '../composables/useOverlayFocus'
import { bookmarkPageOf, isSameBookmarkPage } from '../utils/readerState'
import { createThumbnailProvider } from '../services/thumbnailProvider'
import { useTranslation } from '../composables/useTranslation'
import { useTranslationJobs } from '../stores/translationJobs'
import type { TranslationBlock } from '../types/translation'
import TranslationPanel from './TranslationPanel.vue'
import TranslationCard from './TranslationCard.vue'
import TranslationSettingsDialog from './TranslationSettingsDialog.vue'

// Lazy-load readers so pdfjs isn't in the initial bundle (faster first paint)
const ImageReader = defineAsyncComponent(() => import('./readers/ImageReader.vue'))
const PdfReader = defineAsyncComponent(() => import('./readers/PdfReader.vue'))

const props = defineProps<{ comic: Comic; files: ReaderFile[]; initialPage?: number | null }>()
const emit = defineEmits<{ (e: 'back'): void; (e: 'open', comic: Comic): void }>()

const lib = useLibrary()
const settings = useReadingSettings()
const readerRef = ref<ReaderController | null>(null)
const settingsOpen = ref(false)
const ReaderComp = computed(() => {
  switch (props.comic.format) {
    case 'pdf':
      return PdfReader
    default:
      return ImageReader
  }
})
// 已移除的格式(epub/mobi)在旧书架数据中仍可能存在: 打开时给出明确提示而非崩溃
const isSupported = computed(() => props.comic.format === 'images' || props.comic.format === 'pdf')

const position = ref(props.initialPage && props.initialPage >= 1 ? props.initialPage : (props.comic.lastPosition || 1))
const total = ref(props.comic.totalPages || 1)
let readingSessionId = ''
let readingSessionGeneration = 0
const readerReady = ref(false)
const locked = ref(false)
const show = ref(true)
const readerUi = ref<ReaderUiState>({
  readMode: props.comic.readMode ?? 'page',
  pageMode: props.comic.pageMode ?? 'single',
  pageDir: props.comic.pageDir ?? 'rtl',
  fit: props.comic.fit ?? 'width',
  zoom: 1,
})
const readerStage = ref<HTMLElement>()
const translation = reactive(useTranslation(() => props.comic, readerRef, position, readerReady, () => readerUi.value.pageDir))
const translationJobs = useTranslationJobs()
function batchTranslation() { translationJobs.configure(props.comic.id, total.value, Math.max(1, Math.floor(position.value)), translation.sourceLanguage, translation.targetLanguage, readerUi.value.pageDir) }
function toggleTranslation() { translation.toggle(); show.value = true; clearHide() }
async function locateTranslation(pageIndex: number, block: TranslationBlock) {
  if (!readerRef.value?.visiblePages().includes(pageIndex)) {
    readerRef.value?.goTo(pageIndex + 1)
    await nextTick()
  }
  const anchor = readerStage.value?.querySelector<HTMLElement>(`[data-translation-page="${pageIndex}"] [data-block-id="${block.id}"]`)
  if (anchor) { anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' }); translation.select({ pageIndex, block, anchor }) }
}
const introHint = ref(false)
// webtoon(竖向滚动)模式下点击翻页区与滚轮翻页应让位于原生滚动
const isWebtoon = computed(
  () =>
    (props.comic.format === 'images' || props.comic.format === 'pdf') &&
    readerUi.value.readMode === 'webtoon',
)
// 仅图片/PDF 支持单双页与阅读方向(快捷键 1/2/L/R 只对它们生效)
const isPagedFormat = () => props.comic.format === 'images' || props.comic.format === 'pdf'

// 书签位置在 webtoon 模式下可能是小数(如 12.4), 取整口径统一由 readerState 提供,
// 保证「已加书签」的显示、添加、删除三处判定完全一致。
const currentBookmark = computed(() =>
  lib.bookmarksFor(props.comic.id).find((b) => isSameBookmarkPage(b.position, position.value)),
)
const bookmarked = computed(() => !!currentBookmark.value)

// 常驻阅读进度(不随工具栏自动隐藏)
const progressPct = computed(() =>
  total.value ? Math.min(100, Math.max(0, (position.value / total.value) * 100)) : 0,
)

// ---- toolbar auto-hide ----
// 菜单在鼠标进入顶部或底部热区时唤起, 阅读区(中部)移动鼠标不再灵敏触发。
// 此外可用快捷键 H 自由切换菜单显隐。
const TOP_ZONE = 96
const BOTTOM_ZONE = 96
let hideTimer: number | undefined
let introTimer: number | undefined
function scheduleHide() {
  if (locked.value) return
  clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => (show.value = false), 2600)
}
function onMove(e: MouseEvent) {
  if (locked.value) return
  const h = window.innerHeight || document.documentElement.clientHeight
  if (e.clientY <= TOP_ZONE || e.clientY >= h - BOTTOM_ZONE) {
    show.value = true
    scheduleHide()
  }
}
function clearHide() {
  clearTimeout(hideTimer)
}
function toggleLock() {
  locked.value = !locked.value
  if (locked.value) {
    show.value = true
    clearTimeout(hideTimer)
  } else scheduleHide()
}

// ---- progress persistence (debounced) ----
let saveTimer: number | undefined
function onProgress(p: { position: number; total: number }) {
  readerReady.value = true
  position.value = p.position
  total.value = p.total
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => lib.touch(props.comic.id, p.position, p.total), 400)
}

function onUiState(state: ReaderUiState) {
  readerUi.value = state
}

function next() {
  readerRef.value?.next()
}
function prev() {
  readerRef.value?.prev()
}
function zoom(delta: number) {
  readerRef.value?.zoom(delta)
}
function toggleReadMode() {
  readerRef.value?.toggleReadMode()
}
function setMode(mode: 'single' | 'double') {
  readerRef.value?.setMode(mode)
}
function setDir(dir: 'ltr' | 'rtl') {
  readerRef.value?.setDir(dir)
}
function cycleFit() {
  readerRef.value?.cycleFit()
}
function goTo() {
  openJump()
}
// 应用内跳转输入(替代原生 prompt, 不阻塞、可主题化)
const jumpOpen = ref(false)
const jumpValue = ref('')
const helpOpen = ref(false)
const bookmarksOpen = ref(false)
const thumbnailsOpen = ref(false)
const helpDialog = ref<HTMLElement>()
const jumpDialog = ref<HTMLElement>()
const readerBookmarkDialog = ref<HTMLElement>()
const thumbnailDialog = ref<HTMLElement>()

// 三个浮层统一走 useOverlayFocus: 内建 opener 记录 + 关闭回填 + Tab 陷阱
const helpOverlay = useOverlayFocus(helpOpen, helpDialog)
const jumpOverlay = useOverlayFocus(jumpOpen, jumpDialog)
const bookmarkOverlay = useOverlayFocus(bookmarksOpen, readerBookmarkDialog)
const thumbnailOverlay = useOverlayFocus(thumbnailsOpen, thumbnailDialog)

function openJump() {
  jumpValue.value = String(position.value)
  jumpOverlay.open()
  show.value = true
  clearHide()
}
function submitJump() {
  const n = Number(jumpValue.value)
  if (Number.isFinite(n) && n >= 1 && n <= total.value) readerRef.value?.goTo(n)
  jumpOverlay.close()
}
function closeJump() {
  jumpOverlay.close()
}
// 书签按钮支持二次点击删除: 当前页已有书签则移除, 否则新增(避免同页堆叠多个书签)
function toggleBookmark() {
  const existing = currentBookmark.value
  if (existing) lib.removeBookmark(existing.id)
  else lib.addBookmark(props.comic.id, bookmarkPageOf(position.value))
}
// 书签列表面板: 列出本书全部书签, 点击跳转到对应页, ✕ 删除
const bookmarkList = computed(() =>
  [...lib.bookmarksFor(props.comic.id)].sort((a, b) => a.position - b.position),
)
function openBookmarks() {
  bookmarkOverlay.open()
  show.value = true
  clearHide()
}
function closeReaderBookmarks() {
  bookmarkOverlay.close()
}
function jumpBookmark(pos: number) {
  readerRef.value?.goTo(Math.round(pos))
  closeReaderBookmarks()
}
function removeBm(id: string) {
  lib.removeBookmark(id)
}
function updateBm(id: string, event: Event) {
  lib.updateBookmark(id, (event.target as HTMLInputElement).value)
}

const thumbnailProvider = shallowRef(createThumbnailProvider(props.comic, props.files))
watch([() => props.comic.id, () => props.files], () => {
  thumbnailProvider.value.close()
  thumbnailProvider.value = createThumbnailProvider(props.comic, props.files)
})
function openThumbnails() {
  thumbnailOverlay.open()
  show.value = true
  clearHide()
}
function closeThumbnails() {
  thumbnailOverlay.close()
}
function jumpThumbnail(page: number) {
  readerRef.value?.goTo(page)
  closeThumbnails()
}
async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen()
  else await document.documentElement.requestFullscreen()
}

const seriesName = (comic: Comic) => comic.series || comic.title.replace(/[\s\-_#·]*(?:第\s*|No\.?\s*|no\.?\s*)?\d+[\s]*[话卷期集回章节册]?$/i, '').trim()
const siblingChapters = computed(() => lib.comics
  .filter((comic) => seriesName(comic) === seriesName(props.comic))
  .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })))
const currentChapterIndex = computed(() => siblingChapters.value.findIndex((comic) => comic.id === props.comic.id))
const previousChapter = computed(() => siblingChapters.value[currentChapterIndex.value - 1])
const nextChapter = computed(() => siblingChapters.value[currentChapterIndex.value + 1])
const completed = computed(() => readerReady.value && total.value > 0 && position.value >= total.value)
async function openChapter(comic: Comic) {
  await Promise.all([
    lib.setReadMode(comic.id, readerUi.value.readMode),
    lib.setPageMode(comic.id, readerUi.value.pageMode),
    lib.setPageDir(comic.id, readerUi.value.pageDir),
    lib.setFitMode(comic.id, readerUi.value.fit),
  ])
  emit('open', comic)
}
function openSettings() {
  settingsOpen.value = true
  show.value = true
  clearTimeout(hideTimer)
}

function closeHelp() {
  helpOverlay.close()
}

// ---- keyboard ----
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}
function onKey(e: KeyboardEvent) {
  // Esc: 优先关闭浮层(帮助/书签/跳转), 否则返回书架
  if (e.key === 'Escape') {
    if (translation.configOpen) { translation.configOpen = false; return }
    if (helpOpen.value) {
      closeHelp()
      return
    }
    if (bookmarksOpen.value) {
      closeReaderBookmarks()
      return
    }
    if (jumpOpen.value) {
      closeJump()
      return
    }
    if (thumbnailsOpen.value) {
      closeThumbnails()
      return
    }
    if (translation.escape()) { e.preventDefault(); return }
    emit('back')
    return
  }
  // 焦点在输入/滑块上时, 方向键等应交给控件本身, 不要翻页/切模式(避免调参时页面乱跳)
  if (isTypingTarget(e.target)) return
  const k = e.key
  // 任一浮层(帮助/跳转/书签/缩略图/设置)打开时, 除上面的 Esc 外不应触发阅读器操作,
  // 否则方向键/空格会在弹窗背后偷偷翻页。例外: 帮助面板仍允许用 ? 再次关闭。
  const overlayOpen = helpOpen.value || jumpOpen.value || bookmarksOpen.value || thumbnailsOpen.value || settingsOpen.value || translation.configOpen || translationJobs.open
  if (overlayOpen && !(helpOpen.value && k === '?')) return
  if ((k === 't' || k === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); toggleTranslation()
  } else if (translation.selecting) {
    return
  } else if (k === 'ArrowRight' || k === ' ' || k === 'PageDown') {
    e.preventDefault()
    next()
  } else if (k === 'ArrowLeft' || k === 'PageUp') {
    e.preventDefault()
    prev()
  } else if (k === 'b' || k === 'B') {
    if (isPagedFormat()) toggleBookmark()
  } else if (k === 'h' || k === 'H') {
    if (locked.value) return // 已锁定(常显)时, 用锁定按钮取消固定
    e.preventDefault()
    show.value = !show.value
    if (show.value) clearHide()
    else scheduleHide()
  } else if (k === '1') {
    if (isPagedFormat()) readerRef.value?.setMode('single')
  } else if (k === '2') {
    if (isPagedFormat()) readerRef.value?.setMode('double')
  } else if (k === 'l' || k === 'L') {
    if (isPagedFormat()) readerRef.value?.setDir('ltr')
  } else if (k === 'r' || k === 'R') {
    if (isPagedFormat()) readerRef.value?.setDir('rtl')
  } else if (e.ctrlKey && e.shiftKey && (k === 'f' || k === 'F')) {
    e.preventDefault()
    toggleFullscreen()
  } else if (k === 'f' || k === 'F') {
    if (isPagedFormat()) readerRef.value?.cycleFit()
  } else if (k === '?') {
    if (helpOpen.value) helpOverlay.close()
    else helpOverlay.open()
    show.value = true
    clearHide()
  }
}

// click zones
function zone(dir: 'prev' | 'next') {
  dir === 'next' ? next() : prev()
}

// wheel paging for paged formats
let wheelLock = false
function onWheel(e: WheelEvent) {
  if (translation.selecting || translation.configOpen || translationJobs.open || thumbnailsOpen.value || bookmarksOpen.value || jumpOpen.value || helpOpen.value || settingsOpen.value) return
  if (isWebtoon.value) return // 滚动模式交给原生滚动
  if (Math.abs(e.deltaY) < 8) return
  if (wheelLock) return
  wheelLock = true
  e.deltaY > 0 ? next() : prev()
  setTimeout(() => (wheelLock = false), 220)
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (!sessionStorage.getItem('mangareader.readerHintSeen')) {
    introHint.value = true
    sessionStorage.setItem('mangareader.readerHintSeen', '1')
    introTimer = window.setTimeout(() => (introHint.value = false), 4200)
  }
  if (!locked.value) scheduleHide()
  const generation = ++readingSessionGeneration
  void lib.beginReadingSession(props.comic.id, position.value).then((id) => {
    if (generation === readingSessionGeneration) readingSessionId = id
    else void lib.finishReadingSession(id, position.value)
  })
})
onBeforeUnmount(() => {
  readingSessionGeneration++
  if (readingSessionId) void lib.finishReadingSession(readingSessionId, position.value)
  window.removeEventListener('keydown', onKey)
  clearTimeout(hideTimer)
  clearTimeout(introTimer)
  clearTimeout(saveTimer)
  thumbnailProvider.value.close()
  lib.touch(props.comic.id, position.value, total.value)
})
</script>

<template>
  <div
    class="relative z-10 h-full w-full bg-[color:var(--bg)]"
    @mousemove="onMove"
    @mouseleave="scheduleHide"
    @wheel="onWheel"
  >
    <!-- 常驻阅读进度(始终可见, 不随工具栏隐藏) -->
    <div
      class="reader-progress"
      role="progressbar"
      aria-label="阅读进度"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="Math.round(progressPct)"
      :style="{ width: progressPct + '%' }"
    />

    <div
      ref="readerStage"
      class="reader-stage absolute inset-0 z-0"
      :class="{ 'has-translation-panel': translation.enabled && translation.sidebarOpen }"
      :style="{ filter: `brightness(${settings.brightness}) sepia(${settings.warmth})` }"
    >
      <component
        v-if="isSupported"
        :is="ReaderComp"
        :key="comic.id"
        ref="readerRef"
        :comic="comic"
        :files="files"
        :initial-page="initialPage"
        :translation="translation.layer"
        @progress="onProgress"
        @ui-state="onUiState"
        @translation-select="translation.select"
        @translation-region="translation.translateRegion"
      />
      <div v-else class="grid h-full place-items-center px-6 text-center">
        <div>
          <p class="mb-1 font-extrabold text-[color:var(--accent)]">该漫画格式已不再支持</p>
          <p class="text-sm text-[color:var(--text-dim)]">应用已移除 EPUB / MOBI 阅读支持，请从书架删除此条目后重新导入支持的格式（图片 / 压缩包 / PDF）。</p>
        </div>
      </div>
    </div>

    <!-- click zones (滚动模式下隐藏, 让位于原生滚动) -->
    <div v-if="!isWebtoon && !translation.enabled" class="pointer-events-none absolute inset-0 z-20">
      <button
        type="button"
        tabindex="-1"
        class="pointer-events-auto absolute inset-y-24 left-0 w-[12%] cursor-w-resize bg-transparent"
        aria-label="上一页"
        @click="zone('prev')"
      />
      <button
        type="button"
        tabindex="-1"
        class="pointer-events-auto absolute inset-y-24 right-0 w-[12%] cursor-e-resize bg-transparent"
        aria-label="下一页"
        @click="zone('next')"
      />
    </div>

    <!-- top navigation: location and book actions -->
    <Transition name="view">
      <div
        v-show="show"
        class="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-4"
        @mouseenter="clearHide"
        @mouseleave="scheduleHide"
      >
        <ReaderTopBar
          :title="comic.title"
          :format="comic.format"
          :position="position"
          :total="total"
          :locked="locked"
          :bookmarked="bookmarked"
          :translation-enabled="translation.enabled"
          @back="emit('back')"
          @go="goTo"
          @toggle-lock="toggleLock"
          @bookmark="toggleBookmark"
          @bookmarks="openBookmarks"
          @thumbnails="openThumbnails"
          @fullscreen="toggleFullscreen"
          @settings="openSettings"
          @translation="toggleTranslation"
        />
      </div>
    </Transition>

    <Transition name="view">
      <div v-if="completed" class="chapter-end-slip pointer-events-auto absolute bottom-24 left-1/2 z-30 w-[min(92vw,520px)] -translate-x-1/2 p-5 text-center shadow-xl">
        <p class="font-semibold">本章已读完</p>
        <div class="mt-3 flex flex-wrap justify-center gap-2">
          <button v-if="previousChapter" class="comic-btn" @click="openChapter(previousChapter)">上一章</button>
          <button class="comic-btn" @click="emit('back')">返回书库</button>
          <button v-if="nextChapter" class="comic-btn comic-btn--accent" @click="openChapter(nextChapter)">下一章</button>
        </div>
      </div>
    </Transition>

    <!-- bottom dock: display and reading-mode controls -->
    <Transition name="view">
      <div
        v-show="show"
        class="reader-dock-wrapper pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4"
        :class="{ 'has-translation-panel': translation.enabled && translation.sidebarOpen }"
        @mouseenter="clearHide"
        @mouseleave="scheduleHide"
      >
        <ReaderControlDock
          :state="readerUi"
          @zoom="zoom"
          @toggle-read-mode="toggleReadMode"
          @set-mode="setMode"
          @set-dir="setDir"
          @cycle-fit="cycleFit"
        />
      </div>
    </Transition>

    <Transition name="view">
      <div v-if="introHint" class="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center px-4">
        <div class="rounded-lg border border-white/15 bg-black/70 px-4 py-2 text-xs font-medium text-white shadow-lg backdrop-blur-sm">
          移到上下边缘显示控制栏 · 按 <kbd class="ml-1 rounded bg-white/15 px-1.5 py-0.5 font-bold">?</kbd> 查看快捷键
        </div>
      </div>
    </Transition>

    <!-- settings panel -->
    <SettingsPanel v-model="settingsOpen" :comic="comic" />
    <TranslationPanel v-if="translation.enabled && translation.sidebarOpen" :page-index="translation.currentPage" :records="translation.visibleRecords"
      :busy="translation.busy" :busy-page="translation.busyPage" :phase="translation.phase" :error="translation.error" :notice="translation.notice" :ready="translation.settings.ready"
      :active-id="translation.layer.activeId" v-model:source-language="translation.sourceLanguage" v-model:target-language="translation.targetLanguage"
      @close="translation.sidebarOpen = false" @settings="translation.configOpen = true" @translate="translation.translatePage" @region="translation.startSelection"
      @cancel="translation.cancel" @retry="translation.retry" @clear="translation.clearCache" @locate="locateTranslation" @correct="translation.correctSource" @batch="batchTranslation" />
    <div v-if="translation.enabled && !translation.sidebarOpen && !translation.selecting" class="translation-mini-dock" @wheel.stop>
      <button type="button" class="comic-btn" @click="translation.sidebarOpen = true"><Icon name="languages" :size="16" />显示译文</button>
      <button type="button" class="comic-btn" :disabled="translation.busy" @click="translation.startSelection"><Icon name="scan-line" :size="16" />框选</button>
    </div>
    <div v-if="translation.selecting" class="translation-selection-hint" role="status" @wheel.stop>拖拽框选需要翻译的文字 <button type="button" class="translation-link" @click="translation.selecting = false; translation.sidebarOpen = true">取消 · Esc</button></div>
    <TranslationCard v-if="translation.active" :key="`${translation.active.pageIndex}:${translation.active.block.id}`" :active="translation.active" :busy="translation.busy"
      @close="translation.closeCard" @correct="translation.correctSource(translation.active!.pageIndex, translation.active!.block.id, $event)" />
    <TranslationSettingsDialog v-model="translation.configOpen" :source-language="translation.sourceLanguage" />

    <!-- 快捷键速查 (? 唤出) -->
    <Transition name="view">
      <div
        v-if="helpOpen"
        class="absolute inset-0 z-40 grid place-items-center bg-black/40 p-6 backdrop-blur-sm"
        @click.self="closeHelp"
        @keydown.esc.stop.prevent="closeHelp"
        @keydown="helpOverlay.trap($event)"
      >
        <section ref="helpDialog" class="card w-[420px] max-w-full p-5" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
          <div class="mb-3 flex items-center justify-between">
            <h2 id="shortcut-title" class="font-display text-lg font-bold text-[color:var(--text)]">快捷键</h2>
            <button class="icon-button" aria-label="关闭快捷键" title="关闭" @click="closeHelp"><Icon name="x" :size="19" /></button>
          </div>
          <ul class="space-y-1.5 text-sm text-[color:var(--text)]">
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">翻页 / 下一页</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">→</kbd><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">空格</kbd><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">PgDn</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">上一页</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">←</kbd><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">PgUp</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">单页 / 双页</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">1</kbd><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">2</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">方向 左→右 / 右→左</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">L</kbd><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">R</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">适应 宽/高/原大</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">F</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">切换全屏</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">Ctrl ⇧ F</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">显示/隐藏菜单</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">H</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">添加书签</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">B</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">翻译模式</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">T</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">本帮助</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">?</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">返回书架</span><kbd class="rounded bg-[color:var(--wash)] px-1.5 py-0.5 text-xs font-semibold">Esc</kbd></li>
            <li class="flex justify-between gap-3"><span class="text-[color:var(--text-dim)]">触屏翻页</span><span class="text-xs">滑动 / 点按左右</span></li>
          </ul>
        </section>
      </div>
    </Transition>

    <!-- 应用内跳转输入(替代原生 prompt) -->
    <Transition name="view">
      <div
        v-if="jumpOpen"
        class="absolute inset-0 z-40 grid place-items-center bg-black/40 p-6 backdrop-blur-sm"
        @click.self="closeJump"
        @keydown.esc.stop.prevent="closeJump"
        @keydown="jumpOverlay.trap($event)"
      >
        <section ref="jumpDialog" class="card flex w-80 max-w-full flex-col gap-4 p-5" role="dialog" aria-modal="true" aria-labelledby="jump-title">
          <div class="flex items-center justify-between">
            <h2 id="jump-title" class="font-display text-lg font-bold text-[color:var(--text)]">跳转页码</h2>
            <button class="icon-button" aria-label="关闭页码跳转" title="关闭" @click="closeJump"><Icon name="x" :size="19" /></button>
          </div>
          <div class="flex items-center gap-2">
            <label for="jump-page" class="text-sm font-semibold text-[color:var(--text)]">页码</label>
            <input
              id="jump-page"
              v-model="jumpValue"
              type="number"
              min="1"
              :max="total"
              inputmode="numeric"
              class="h-11 w-24 rounded-lg border border-[color:var(--line)] bg-[color:var(--bg-elev)] px-3 text-[color:var(--text)] outline-none focus:border-[color:var(--accent)]"
              @keyup.enter="submitJump"
            />
            <span class="text-sm text-[color:var(--text-dim)]">/ {{ total }} 页</span>
          </div>
          <div class="flex justify-end gap-2">
            <button class="btn btn--ghost" @click="closeJump">取消</button>
            <button class="btn btn--primary" @click="submitJump">跳转</button>
          </div>
        </section>
      </div>
    </Transition>

    <!-- 书签列表面板 -->
    <Transition name="view">
      <div
        v-if="bookmarksOpen"
        class="absolute inset-0 z-40 grid place-items-center bg-black/40 p-6 backdrop-blur-sm"
        @click.self="closeReaderBookmarks"
        @keydown.esc.stop.prevent="closeReaderBookmarks"
        @keydown="bookmarkOverlay.trap($event)"
      >
        <section ref="readerBookmarkDialog" class="card flex max-h-[80vh] w-96 max-w-full flex-col gap-3 p-5" role="dialog" aria-modal="true" aria-labelledby="reader-bookmark-title">
          <div class="mb-1 flex items-center justify-between">
            <h2 id="reader-bookmark-title" class="font-display text-lg font-bold text-[color:var(--text)]">本书书签</h2>
            <button class="icon-button" aria-label="关闭本书书签" title="关闭" @click="closeReaderBookmarks"><Icon name="x" :size="19" /></button>
          </div>
          <div v-if="!bookmarkList.length" class="py-6 text-center text-sm text-[color:var(--text-dim)]">
            还没有书签，按 <kbd class="kbd">B</kbd> 添加当前页
          </div>
          <ul v-else class="flex-1 space-y-1.5 overflow-y-auto pr-1">
            <li
              v-for="bm in bookmarkList"
              :key="bm.id"
              class="group flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition hover:bg-[color:var(--wash)]"
            >
              <button class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm text-[color:var(--text)]" @click="jumpBookmark(bm.position)">
                <Icon name="bookmark" :size="15" />
                <span class="truncate tabular-nums">{{ '第 ' + Math.round(bm.position) + ' 页' }}</span>
              </button>
              <input :value="bm.label" class="min-w-0 flex-1 rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] px-2 py-1.5 text-xs" placeholder="添加备注" :aria-label="`第 ${Math.round(bm.position)} 页书签备注`" @change="updateBm(bm.id, $event)" />
              <button
                class="icon-button shrink-0 text-[color:var(--text-dim)] hover:text-[color:var(--danger)]"
                :aria-label="`删除第 ${Math.round(bm.position)} 页书签`"
                title="删除书签"
                @click="removeBm(bm.id)"
              ><Icon name="trash-2" :size="15" /></button>
            </li>
          </ul>
        </section>
      </div>
    </Transition>

    <Transition name="view">
      <div v-if="thumbnailsOpen" class="absolute inset-0 z-40 bg-black/55 p-6 backdrop-blur-sm" @click.self="closeThumbnails" @keydown.esc.stop.prevent="closeThumbnails" @keydown="thumbnailOverlay.trap($event)">
        <section ref="thumbnailDialog" class="card mx-auto flex h-full max-w-5xl flex-col p-5" role="dialog" aria-modal="true" aria-labelledby="thumbnail-title">
          <div class="mb-4 flex items-center justify-between"><div><p class="section-kicker">QUICK BROWSE</p><h2 id="thumbnail-title" class="text-xl font-bold text-[color:var(--text)]">页缩略图</h2></div><button class="icon-button" aria-label="关闭页缩略图" @click="closeThumbnails"><Icon name="x" :size="19" /></button></div>
          <VirtualThumbnailGrid :total="total" :current="Math.round(position)" :provider="thumbnailProvider" @jump="jumpThumbnail" />
        </section>
      </div>
    </Transition>

  </div>
</template>
