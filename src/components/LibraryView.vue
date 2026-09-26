<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLibrary, tagLabel, seriesOf, chapterNum } from '../stores/library'
import type { Comic, Bookmark, ImportResult } from '../types'
import ComicCard from './ComicCard.vue'
import { useTranslationJobs } from '../stores/translationJobs'
import ComicCover from './ComicCover.vue'
import ThemeToggle from './ThemeToggle.vue'
import Icon from './Icon.vue'
import { focusFirst, trapFocus } from '../utils/focus'
import { alertDialog, confirmDialog } from '../composables/useDialog'
import { nativeAvailable, type NativeBookCandidate } from '../services/nativeFiles'
import { clearNativeReaderCache, getNativeCacheStats, listenNativeSourceChanges, unwatchNativeLibraryRoot, watchNativeLibraryRoot, type NativeCacheStats } from '../services/nativeReader'
import { pickNativeDirectory } from '../services/nativeFiles'
import { sourceIssueLabel } from '../utils/library'

const lib = useLibrary()
const hasFilters = computed(() => !!lib.query || lib.activeTag !== null || lib.shelfFilter !== 'all')
function clearFilters() {
  lib.query = ''
  lib.activeTag = null
  lib.shelfFilter = 'all'
}
const translationJobs = useTranslationJobs()
const fsaSupported = typeof (window as any).showDirectoryPicker === 'function'
const nativeSupported = nativeAvailable()
const importing = ref(false)
const folderInput = ref<HTMLInputElement>()
const fileInput = ref<HTMLInputElement>()
const relinkFolderInput = ref<HTMLInputElement>()
const relinkFileInput = ref<HTMLInputElement>()
const relinkId = ref<string>()
const archiveInput = ref<HTMLInputElement>()
const batchInput = ref<HTMLInputElement>()
const importOpen = ref(false)
const manageOpen = ref(false)
const importError = ref('')
const importReport = ref<ImportResult | null>(null)
const restoreInput = ref<HTMLInputElement>()
const dragActive = ref(false)
const healthOpen = ref(false)
const cacheStats = ref<NativeCacheStats>({ bytes: 0, files: 0, limitBytes: 0 })
const watchedRoots = ref<string[]>(JSON.parse(localStorage.getItem('mangareader.watchedRoots') || '[]'))
let stopSourceListener: (() => void) | undefined
let sourceChangeTimer = 0
const pendingSourceChanges = new Map<string, Set<string>>()

const sourceIssues = computed(() => lib.comics.filter((comic) => comic.source.status && comic.source.status !== 'available'))
const formatBytes = (bytes: number) => bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`
async function refreshCacheStats() { cacheStats.value = await getNativeCacheStats() }
async function openHealthCenter() { healthOpen.value = true; await refreshCacheStats() }
async function addWatchedRoot() {
  const path = await pickNativeDirectory()
  if (!path || watchedRoots.value.includes(path)) return
  await watchNativeLibraryRoot(path)
  watchedRoots.value = [...watchedRoots.value, path]
  localStorage.setItem('mangareader.watchedRoots', JSON.stringify(watchedRoots.value))
}
async function removeWatchedRoot(path: string) {
  await unwatchNativeLibraryRoot(path)
  watchedRoots.value = watchedRoots.value.filter((item) => item !== path)
  localStorage.setItem('mangareader.watchedRoots', JSON.stringify(watchedRoots.value))
}
async function clearCache() {
  if (!(await confirmDialog('清理阅读缓存？原文件与阅读进度不会受影响。'))) return
  await clearNativeReaderCache()
  await refreshCacheStats()
}
async function scanWatchedRoots() {
  if (!watchedRoots.value.length) return
  importing.value = true
  try {
    const combined: ImportResult = { added: [], skipped: [], failed: [], durability: 'permanent' }
    for (const root of watchedRoots.value) {
      const result = await lib.importNativeRoot(root)
      combined.added.push(...result.added)
      combined.skipped.push(...result.skipped)
      combined.failed.push(...result.failed)
    }
    if (combined.failed.length && !combined.added.length) combined.durability = 'failed'
    acceptImportResult(combined)
  } finally {
    importing.value = false
  }
}
async function rescanChangedSources() {
  const targets = sourceIssues.value.filter((comic) => comic.source.type === 'native-dir')
  if (!targets.length) return
  const changes: { id: string; candidate: NativeBookCandidate; added: number; removed: number }[] = []
  for (const comic of targets) {
    try {
      const preview = await lib.previewNativeRescan(comic.id)
      if (preview.added.length || preview.removed.length) changes.push({ id: comic.id, candidate: preview.candidate, added: preview.added.length, removed: preview.removed.length })
    } catch { /* keep unresolved sources in the list */ }
  }
  if (!changes.length) { await alertDialog('没有可自动应用的目录变更。'); return }
  const added = changes.reduce((sum, item) => sum + item.added, 0)
  const removed = changes.reduce((sum, item) => sum + item.removed, 0)
  if (!(await confirmDialog(`将更新 ${changes.length} 本目录漫画：新增 ${added} 页、移除 ${removed} 页。是否应用？`))) return
  for (const change of changes) await lib.applyNativeRescan(change.id, change.candidate)
}

onMounted(async () => {
  if (!nativeSupported) return
  for (const root of watchedRoots.value) await watchNativeLibraryRoot(root).catch(() => undefined)
  stopSourceListener = await listenNativeSourceChanges((change) => {
    const paths = pendingSourceChanges.get(change.root) || new Set<string>()
    change.paths.forEach((path) => paths.add(path))
    pendingSourceChanges.set(change.root, paths)
    clearTimeout(sourceChangeTimer)
    sourceChangeTimer = window.setTimeout(() => {
      for (const [root, changedPaths] of pendingSourceChanges) void lib.markSourcesChanged(root, [...changedPaths])
      pendingSourceChanges.clear()
    }, 650)
  })
})
onBeforeUnmount(() => {
  stopSourceListener?.()
  clearTimeout(sourceChangeTimer)
})

const emit = defineEmits<{ (e: 'open', c: Comic, page?: number): void }>()

// ---- selection / batch delete / clear shelf ----
const selecting = ref(false)
const selected = ref<Set<string>>(new Set())

function toggleSelect(id: string) {
  const s = new Set(selected.value)
  s.has(id) ? s.delete(id) : s.add(id)
  selected.value = s
}
function selectAll() {
  const s = new Set(selected.value)
  lib.filtered.forEach((c) => s.add(c.id))
  selected.value = s
}
function clearSelection() {
  selected.value = new Set()
  selecting.value = false
}
async function deleteSelected() {
  const ids = [...selected.value]
  if (!ids.length) return
  if (!(await confirmDialog({ title: '删除选中漫画', message: `确定删除选中的 ${ids.length} 本漫画？阅读进度会一并删除，且不可撤销。`, confirmText: '删除', danger: true }))) return
  await lib.removeComics(ids)
  selected.value = new Set()
  selecting.value = false
}
async function clearShelf() {
  if (!lib.comics.length) return
  if (!(await confirmDialog({ title: '清空书架', message: '确定清空整个书架？所有漫画与阅读进度都会被删除，且不可撤销。', confirmText: '清空', danger: true }))) return
  await lib.clearAll()
  selected.value = new Set()
  selecting.value = false
}
async function confirmRemove(id: string) {
  if (!(await confirmDialog({ title: '删除漫画', message: '确定删除这本漫画？阅读进度会一并删除，且不可撤销。', confirmText: '删除', danger: true }))) return
  await lib.removeComic(id)
}
async function confirmReset(id: string) {
  if (!(await confirmDialog({ title: '重置进度', message: '将这本漫画的阅读进度重置为未读？书签会保留。', confirmText: '重置' }))) return
  await lib.resetProgress(id)
}
async function rescanComic(id: string) {
  try {
    const preview = await lib.previewNativeRescan(id)
    if (!preview.added.length && !preview.removed.length) {
      await alertDialog('扫描完成，目录内容没有变化。')
      return
    }
    if (!(await confirmDialog(`检测到新增 ${preview.added.length} 页、移除 ${preview.removed.length} 页。是否应用这些变更？`))) return
    await lib.applyNativeRescan(id, preview.candidate)
  } catch (error: any) {
    importError.value = error?.message || '重新扫描失败。'
  }
}
async function relinkComic(id: string) {
  const comic = lib.comics.find((item) => item.id === id)
  if (!comic) return
  if (comic.source.type === 'input' || comic.source.type === 'web-cache') {
    relinkId.value = id
    if (comic.format === 'images' && comic.source.filePaths?.some((path) => path.includes('/'))) relinkFolderInput.value?.click()
    else relinkFileInput.value?.click()
    return
  }
  if (comic.source.type === 'fsa-dir' || comic.source.type === 'fsa-file') {
    healthOpen.value = false
    emit('open', comic)
    return
  }
  try {
    if (await lib.relinkSource(id)) await alertDialog('已重新关联原文件。')
  } catch (error: any) {
    importError.value = error?.message || '重新关联失败。'
  }
}
async function onRelinkSelection(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length || !relinkId.value) return
  importing.value = true
  try {
    acceptImportResult(await lib.relinkBrowserFiles(relinkId.value, input.files))
    healthOpen.value = false
  } catch (error: any) {
    importError.value = error?.message || '重新导入失败，请选择原来的目录或文件。'
  } finally {
    importing.value = false
    input.value = ''
    relinkId.value = undefined
  }
}
async function deleteSource(comic: Comic) {
  const location = comic.source.type === 'native-file' ? comic.source.path : comic.source.rootPath
  if (!(await confirmDialog({ title: '永久删除源文件', message: `这会永久删除“${comic.title}”的原文件${comic.source.type === 'native-dir' ? '（仅删除该书目的图片页，不删除目录）' : ''}，且无法从书架恢复。\n\n位置：${location}\n\n确定继续？`, confirmText: '继续', danger: true }))) return
  if (!(await confirmDialog({ title: '最后确认', message: '永久删除源文件并移出书架？此操作不可撤销。', confirmText: '永久删除', danger: true }))) return
  try {
    await lib.deleteSourceFiles(comic.id)
  } catch (error: any) {
    importError.value = error?.message || '源文件删除失败，书目已保留。'
  }
}

const editOpen = ref(false)
const editComic = ref<Comic | null>(null)
const editTitle = ref('')
const editSeries = ref('')
const editTags = ref('')
const editCover = ref<string | undefined>()
async function openEdit(comic: Comic) {
  editComic.value = comic
  editTitle.value = comic.title
  editSeries.value = comic.series || seriesOf(comic.title)
  editTags.value = comic.tags.join(', ')
  editCover.value = await lib.coverDataUrl(comic)
  editOpen.value = true
}
async function saveEdit() {
  if (!editComic.value) return
  await lib.updateComic(editComic.value.id, {
    title: editTitle.value,
    series: editSeries.value,
    tags: editTags.value.split(/[,，]/),
    cover: editCover.value,
  })
  editOpen.value = false
}
function onCoverFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => { editCover.value = String(reader.result) }
  reader.readAsDataURL(file)
}

// ---- series grouping + chapter ordering ----
const expanded = ref<Set<string>>(new Set())
function toggleExpand(series: string) {
  const s = new Set(expanded.value)
  s.has(series) ? s.delete(series) : s.add(series)
  expanded.value = s
}
const seriesGroups = computed(() => {
  const map = new Map<string, Comic[]>()
  for (const c of lib.filtered) {
    const s = c.series || seriesOf(c.title)
    if (!map.has(s)) map.set(s, [])
    map.get(s)!.push(c)
  }
  return [...map.entries()].map(([series, comics]) => {
    comics.sort(
      (a, b) => chapterNum(a.title) - chapterNum(b.title) || a.title.localeCompare(b.title, undefined, { numeric: true }),
    )
    return { series, comics, count: comics.length }
  })
})
const PAGE_SIZE = 120
const catalogPage = ref(1)
const catalogPages = computed(() => Math.max(1, Math.ceil((selecting.value ? lib.filtered.length : seriesGroups.value.length) / PAGE_SIZE)))
const pagedSeriesGroups = computed(() => {
  const start = (catalogPage.value - 1) * PAGE_SIZE
  return seriesGroups.value.slice(start, start + PAGE_SIZE)
})
const pagedSelection = computed(() => {
  const start = (catalogPage.value - 1) * PAGE_SIZE
  return lib.filtered.slice(start, start + PAGE_SIZE)
})
const seriesPages = ref<Record<string, number>>({})
function visibleSeriesComics(series: string, comics: Comic[]) {
  const page = seriesPages.value[series] || 1
  const start = (page - 1) * PAGE_SIZE
  return comics.slice(start, start + PAGE_SIZE)
}
function setSeriesPage(series: string, page: number, count: number) {
  const max = Math.max(1, Math.ceil(count / PAGE_SIZE))
  seriesPages.value = { ...seriesPages.value, [series]: Math.min(max, Math.max(1, page)) }
}
watch([() => lib.query, () => lib.activeTag, () => lib.shelfFilter, () => lib.sortMode], () => {
  catalogPage.value = 1
  seriesPages.value = {}
})
watch(catalogPages, (pages) => {
  if (catalogPage.value > pages) catalogPage.value = pages
})
watch(selecting, () => { catalogPage.value = 1 })

// ---- import handlers ----
function acceptImportResult(result: ImportResult, openFirst = false) {
  importReport.value = result
  importError.value = result.failed.length && !result.added.length ? result.failed[0].reason : ''
  if (openFirst && result.added[0]) emit('open', result.added[0])
}
async function onFolder(e: Event) {
  const fl = (e.target as HTMLInputElement).files
  if (!fl || !fl.length) return
  importing.value = true
  try {
    importError.value = ''
    acceptImportResult(await lib.importInputFiles(fl), true)
  } catch (err) {
    console.error(err)
    importError.value = '图片文件夹导入失败，请确认文件可访问后重试。'
  } finally {
    importing.value = false
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function onFiles(e: Event) {
  const fl = (e.target as HTMLInputElement).files
  if (!fl || !fl.length) return
  importing.value = true
  try {
    importError.value = ''
    acceptImportResult(await lib.importInputFiles(fl), true)
  } catch (err) {
    console.error(err)
    importError.value = '文件导入失败，请检查格式或文件权限。'
  } finally {
    importing.value = false
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function onArchive(e: Event) {
  const fl = (e.target as HTMLInputElement).files
  if (!fl || !fl.length) return
  importing.value = true
  try {
    importError.value = ''
    acceptImportResult(await lib.importArchive(fl[0]), true)
  } catch (err) {
    console.error(err)
    importError.value = '压缩包无法读取，请确认文件未损坏且格式受支持。'
  } finally {
    importing.value = false
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function onBatch(e: Event) {
  const fl = (e.target as HTMLInputElement).files
  if (!fl || !fl.length) return
  importing.value = true
  try {
    importError.value = ''
    acceptImportResult(await lib.batchImportFromInput(fl))
  } catch (err: any) {
    console.error(err)
    importError.value = '批量导入未完成，请检查所选目录。'
  } finally {
    importing.value = false
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function onDrop(event: DragEvent) {
  dragActive.value = false
  const files = event.dataTransfer?.files
  if (!files?.length) return
  importing.value = true
  try {
    acceptImportResult(await lib.batchImportFromInput(files))
  } catch (error: any) {
    importError.value = error?.message || '拖放导入失败。'
  } finally {
    importing.value = false
  }
}

async function exportBackup() {
  const payload = JSON.stringify({ ...(await lib.exportMetadata()), settings: localStorage.getItem('lumina.readingSettings') }, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `mangareader-backup-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}
async function restoreBackup(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const data = JSON.parse(await file.text())
    const restored = await lib.restoreMetadata(data)
    if (typeof data.settings === 'string') localStorage.setItem('lumina.readingSettings', data.settings)
    importError.value = ''
    await alertDialog(`已恢复 ${restored.comics} 本书目和 ${restored.bookmarks} 个书签。源文件不会包含在备份中，部分书目需要重新关联。`)
  } catch (error: any) {
    importError.value = error?.message || '备份恢复失败。'
  } finally {
    input.value = ''
  }
}

async function onFsaDir() {
  importing.value = true
  try {
    importError.value = ''
    acceptImportResult(await lib.importFSADirectory())
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      console.error(err)
      importError.value = '系统目录导入失败，请重新授权目录访问。'
    }
  } finally {
    importing.value = false
  }
}

async function onNativeFiles() {
  importing.value = true
  try {
    acceptImportResult(await lib.importNativeFiles())
  } catch (error: any) {
    if (error?.name !== 'AbortError') importError.value = error?.message || '原生文件导入失败。'
  } finally {
    importing.value = false
  }
}

async function onNativeDirectory() {
  importing.value = true
  try {
    acceptImportResult(await lib.importNativeDirectory())
  } catch (error: any) {
    if (error?.name !== 'AbortError') importError.value = error?.message || '原生目录扫描失败。'
  } finally {
    importing.value = false
  }
}

async function onScan() {
  if (!(await confirmDialog('选择要扫描的文件夹，将递归扫描其中的漫画/电子书并建库（去重）。'))) return
  importing.value = true
  try {
    importError.value = ''
    const n = await lib.importScanDirectory()
    if (n >= 0) await alertDialog(`扫描完成，新增 ${n} 本（已按话数排序）`)
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      console.error(err)
      importError.value = '扫描未完成，请检查目录权限后重试。'
    }
  } finally {
    importing.value = false
  }
}

// ---- 书签管理(主页入口) ----
const bookmarksOpen = ref(false)
const bookmarkDialog = ref<HTMLElement>()
const bookmarkTrigger = ref<HTMLButtonElement>()
const bookmarkList = computed(() => [...lib.bookmarks].sort((a, b) => b.createdAt - a.createdAt))
function comicTitle(id: string) {
  return lib.comics.find((c) => c.id === id)?.title ?? '(已删除)'
}
async function openBookmark(b: Bookmark) {
  const c = lib.comics.find((x) => x.id === b.comicId)
  if (!c) {
    await alertDialog('该书签对应的漫画已不在书架，可手动删除此书签。')
    return
  }
  bookmarksOpen.value = false
  // 携带目标页码, 打开后自动跳到该书签页
  emit('open', c, Math.round(b.position))
}

function toggleBookmarks() {
  bookmarksOpen.value = !bookmarksOpen.value
}

function closeBookmarks() {
  bookmarksOpen.value = false
}

watch(bookmarksOpen, async (open) => {
  if (open) {
    await nextTick()
    focusFirst(bookmarkDialog.value)
  } else {
    bookmarkTrigger.value?.focus()
  }
})

const recent = computed(() => lib.recent)

// ---- 阅读统计 ----
const statsOpen = ref(false)
const stats = ref<Awaited<ReturnType<typeof lib.readingStats>> | null>(null)
async function openStats() {
  stats.value = await lib.readingStats()
  statsOpen.value = true
}
function formatDuration(ms: number) {
  if (!ms) return '0 分钟'
  const mins = Math.max(1, Math.round(ms / 60000))
  if (mins < 60) return `${mins} 分钟`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}
const statsMaxMs = computed(() => Math.max(1, ...(stats.value?.daily.map((d) => d.ms) ?? [1])))

// ---- 批量标签 / 系列编辑 ----
const batchEditOpen = ref(false)
const batchAddTags = ref('')
const batchSeries = ref('')
async function applyBatchEdit() {
  const ids = [...selected.value]
  if (!ids.length) return
  await lib.updateComics(ids, {
    addTags: batchAddTags.value.split(/[,，]/),
    // 留空则不改动系列(而不是清空)
    series: batchSeries.value.trim() ? batchSeries.value : undefined,
  })
  batchEditOpen.value = false
  batchAddTags.value = ''
  batchSeries.value = ''
}
</script>

<template>
  <div class="library-shell relative z-10 flex h-full min-w-0 flex-col">
    <header class="library-masthead shrink-0">
      <div class="library-masthead-row mx-auto flex w-full max-w-[1440px] items-center gap-6 px-8 py-5">
        <div class="masthead-brand flex min-w-0 flex-1 items-center gap-3">
          <img src="/favicon.svg" alt="" class="masthead-logo h-11 w-11 shrink-0" />
          <div class="min-w-0">
            <p class="masthead-issue">PRIVATE PRESS · ISSUE 01</p>
            <h1 class="truncate font-display text-xl font-bold leading-tight tracking-tight text-[color:var(--text)]">MangaReader</h1>
            <p class="truncate text-xs text-[color:var(--text-dim)]">本地漫画与 PDF 阅读器</p>
          </div>
        </div>

        <label class="search-field w-[min(32vw,360px)] min-w-[220px]" for="library-search">
          <Icon name="search" :size="18" />
          <input
            id="library-search"
            v-model="lib.query"
            type="search"
            aria-label="搜索漫画"
            placeholder="搜索书名…"
            class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[color:var(--text-dim)]"
          />
        </label>
        <ThemeToggle />
      </div>

      <nav aria-label="书库操作" class="mx-auto flex w-full max-w-[1440px] items-center gap-3 px-8 pb-4">
        <button type="button" class="comic-btn comic-btn--ghost shrink-0" aria-label="翻译任务" @click="translationJobs.open = true"><Icon name="languages" :size="18" /><span class="hidden lg:inline">翻译任务</span><span v-if="translationJobs.activeCount" class="tabular-nums">{{ translationJobs.activeCount }}</span></button>
        <div class="relative shrink-0">
          <button
            type="button"
            class="comic-btn comic-btn--accent"
            aria-haspopup="menu"
            :aria-expanded="importOpen"
            @click="importOpen = !importOpen; manageOpen = false"
          >
            <Icon name="plus" :size="18" />
            导入
            <Icon name="chevron-down" :size="15" />
          </button>
          <div v-if="importOpen" class="import-menu absolute left-0 top-full z-50 mt-2 w-64" role="menu">
            <button v-if="nativeSupported" class="import-menu__item" role="menuitem" @click="importOpen = false; onNativeFiles()">
              <Icon name="file-text" :size="18" /> 选择本机文件
            </button>
            <button v-if="nativeSupported" class="import-menu__item" role="menuitem" @click="importOpen = false; onNativeDirectory()">
              <Icon name="image" :size="18" /> 导入图片文件夹
            </button>
            <div v-if="nativeSupported" class="my-1 border-t border-[color:var(--line)]" />
            <button v-else class="import-menu__item" role="menuitem" @click="importOpen = false; folderInput?.click()">
              <Icon name="image" :size="18" /> 导入图片文件夹
            </button>
            <button class="import-menu__item" role="menuitem" @click="importOpen = false; fileInput?.click()">
              <Icon name="file-text" :size="18" /> 导入 PDF 或图片
            </button>
            <button class="import-menu__item" role="menuitem" @click="importOpen = false; archiveInput?.click()">
              <Icon name="file-archive" :size="18" /> 导入 CBZ / CBR
            </button>
            <button v-if="!nativeSupported" class="import-menu__item" role="menuitem" @click="importOpen = false; batchInput?.click()">
              <Icon name="layers" :size="18" /> 批量导入文件夹
            </button>
            <div v-if="fsaSupported && !nativeSupported" class="my-1 border-t border-[color:var(--line)]" />
            <button v-if="fsaSupported && !nativeSupported" class="import-menu__item" role="menuitem" @click="importOpen = false; onScan()">
              <Icon name="scan-line" :size="18" /> 扫描目录建库
            </button>
            <button v-if="fsaSupported && !nativeSupported" class="import-menu__item" role="menuitem" @click="importOpen = false; onFsaDir()">
              <Icon name="folder-up" :size="18" /> 系统目录导入
            </button>
          </div>
        </div>

        <div v-if="lib.allTags.length" class="no-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5" aria-label="书库筛选">
          <button class="chip shrink-0" :class="lib.activeTag === null ? 'chip--active' : ''" @click="lib.activeTag = null">全部</button>
          <button
            v-for="t in lib.allTags"
            :key="t"
            class="chip shrink-0"
            :class="lib.activeTag === t ? 'chip--active' : ''"
            @click="lib.activeTag = t"
          >
            {{ tagLabel(t) }}
          </button>
        </div>
        <div v-else class="flex-1" />

        <button
          ref="bookmarkTrigger"
          type="button"
          class="comic-btn comic-btn--ghost shrink-0"
          :class="bookmarksOpen ? 'bg-[color:var(--wash)]' : ''"
          @click="toggleBookmarks"
        >
          <Icon name="bookmark" :size="18" />
          <span class="hidden lg:inline">书签</span>
        </button>

        <div class="relative shrink-0">
          <button
            type="button"
            class="comic-btn comic-btn--ghost px-3"
            title="书库管理"
            aria-label="书库管理"
            aria-haspopup="menu"
            :aria-expanded="manageOpen"
            @click="manageOpen = !manageOpen; importOpen = false"
          >
            <Icon name="more-horizontal" :size="20" />
          </button>
          <div v-if="manageOpen" class="import-menu absolute right-0 top-full z-50 mt-2 w-52" role="menu">
            <button class="import-menu__item" role="menuitem" :disabled="!lib.comics.length" @click="manageOpen = false; selecting = true">
              <Icon name="list-checks" :size="18" /> 批量管理
            </button>
            <button class="import-menu__item" role="menuitem" :disabled="!lib.comics.length" @click="manageOpen = false; exportBackup()">
              <Icon name="download" :size="18" /> 备份书库数据
            </button>
            <button class="import-menu__item" role="menuitem" @click="manageOpen = false; restoreInput?.click()">
              <Icon name="upload" :size="18" /> 恢复书库数据
            </button>
            <button v-if="nativeSupported" class="import-menu__item" role="menuitem" @click="manageOpen = false; openHealthCenter()">
              <Icon name="scan-line" :size="18" /> 来源健康中心
            </button>
            <button class="import-menu__item" role="menuitem" @click="manageOpen = false; openStats()">
              <Icon name="bar-chart" :size="18" /> 阅读统计
            </button>
            <button class="import-menu__item text-[color:var(--danger)]" role="menuitem" :disabled="!lib.comics.length" @click="manageOpen = false; clearShelf()">
              <Icon name="trash-2" :size="18" /> 清空书架
            </button>
          </div>
        </div>
      </nav>

      <div v-if="selecting" class="border-t border-[color:var(--line)] bg-[color:var(--surface-2)]">
        <div class="mx-auto flex w-full max-w-[1440px] items-center gap-3 px-8 py-3">
          <strong class="mr-auto text-sm text-[color:var(--text)]">已选 {{ selected.size }} 本</strong>
          <button class="comic-btn comic-btn--ghost" @click="selectAll">全选当前结果</button>
          <button class="comic-btn comic-btn--ghost" :disabled="!selected.size" @click="batchEditOpen = true">
            <Icon name="tag" :size="18" /> 批量标签
          </button>
          <button class="comic-btn comic-btn--accent" :disabled="!selected.size" @click="deleteSelected">
            <Icon name="trash-2" :size="18" /> 删除选中
          </button>
          <button class="comic-btn comic-btn--ghost" @click="clearSelection">完成</button>
        </div>
      </div>
    </header>

    <div v-if="importOpen || manageOpen" class="fixed inset-0 z-40" @click="importOpen = false; manageOpen = false" />

    <input ref="folderInput" type="file" webkitdirectory hidden @change="onFolder" />
    <input ref="fileInput" type="file" multiple accept=".pdf,image/*,.cbz,.cbr,.zip,.rar" hidden @change="onFiles" />
    <input ref="relinkFolderInput" type="file" webkitdirectory hidden @change="onRelinkSelection" />
    <input ref="relinkFileInput" type="file" multiple accept=".pdf,image/*,.cbz,.cbr,.zip,.rar" hidden @change="onRelinkSelection" />
    <input ref="archiveInput" type="file" accept=".cbz,.cbr,.zip,.rar" hidden @change="onArchive" />
    <input ref="batchInput" type="file" webkitdirectory hidden @change="onBatch" />
    <input ref="restoreInput" type="file" accept="application/json,.json" hidden @change="restoreBackup" />

    <main
      class="no-scrollbar relative flex-1 overflow-y-auto px-8 pb-14 pt-8"
      tabindex="-1"
      @dragenter.prevent="dragActive = true"
      @dragover.prevent="dragActive = true"
      @dragleave.self="dragActive = false"
      @drop.prevent="onDrop"
    >
      <div v-if="dragActive" class="pointer-events-none fixed inset-4 z-50 grid place-items-center rounded-2xl border-2 border-dashed border-[color:var(--accent)] bg-[color:var(--surface)]/90 text-center backdrop-blur-sm">
        <div><Icon name="upload" :size="34" /><p class="mt-3 font-semibold text-[color:var(--text)]">松开即可导入</p><p class="mt-1 text-sm text-[color:var(--text-dim)]">支持图片、PDF、CBZ/ZIP、CBR/RAR</p></div>
      </div>
      <div class="mx-auto w-full max-w-[1440px]">
        <div v-if="importError" class="state-panel state-panel--danger mb-6 flex items-start justify-between gap-4 border border-[color:var(--danger)] bg-[color:var(--danger-soft)] px-4 py-3 text-sm text-[color:var(--danger)]" role="alert">
          <span>{{ importError }}</span>
          <button class="icon-button" aria-label="关闭错误提示" title="关闭" @click="importError = ''"><Icon name="x" :size="17" /></button>
        </div>

        <div v-if="importReport && (importReport.added.length || importReport.skipped.length || importReport.failed.length)" class="state-panel mb-6 border border-[color:var(--line)] bg-[color:var(--surface-2)] px-4 py-3 text-sm" role="status" aria-live="polite">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="font-semibold text-[color:var(--text)]">导入完成：已导入 {{ importReport.added.length }} · 跳过 {{ importReport.skipped.length }} · 失败 {{ importReport.failed.length }}</p>
              <p class="mt-1 text-xs" :class="importReport.durability === 'permanent' ? 'text-[color:var(--text-dim)]' : 'text-[color:var(--danger)]'">
                {{ importReport.durability === 'permanent' ? '已保存到本机，刷新后仍可打开' : importReport.durability === 'session' ? '部分内容仅本次会话可用；刷新后需重新选择原文件或目录' : '没有内容被可靠保存' }}
              </p>
              <ul v-if="importReport.failed.length" class="mt-2 space-y-1 text-xs text-[color:var(--danger)]">
                <li v-for="failure in importReport.failed.slice(0, 5)" :key="failure.name">{{ failure.name }}：{{ failure.reason }}</li>
              </ul>
            </div>
            <button class="icon-button" aria-label="关闭导入报告" title="关闭" @click="importReport = null"><Icon name="x" :size="17" /></button>
          </div>
        </div>

        <div v-if="importing" class="editorial-empty halftone-accent mx-auto my-14 grid place-items-center py-16 text-center" role="status" aria-live="polite">
          <div class="mb-4 h-10 w-10 animate-spin rounded-full border-2 border-[color:var(--line)] border-t-[color:var(--accent)]" />
          <p class="font-semibold text-[color:var(--text)]">正在整理书目</p>
          <p class="mt-1 text-sm text-[color:var(--text-dim)]">封面与页数准备好后会自动打开</p>
        </div>

        <template v-else-if="lib.comics.length">
          <section v-if="recent.length && !hasFilters && !selecting" class="mb-12" aria-labelledby="recent-heading">
            <div class="editorial-rule mb-5">
              <div>
                <p class="section-kicker">CONTINUE READING</p>
                <h2 id="recent-heading" class="section-title">最近阅读</h2>
              </div>
              <span class="editorial-count">{{ String(recent.length).padStart(2, '0') }} TITLES</span>
            </div>
            <div class="no-scrollbar flex gap-4 overflow-x-auto pb-2">
              <ComicCard v-for="(c, index) in recent" :key="c.id" :comic="c" :index="index + 1" compact @open="emit('open', $event)" @edit="openEdit" @reset="confirmReset" @favorite="lib.toggleFavorite" @rescan="rescanComic" @relink="relinkComic" @delete-source="deleteSource" @remove="confirmRemove" />
            </div>
          </section>

          <section aria-labelledby="library-heading">
            <div class="editorial-rule mb-6">
              <div>
                <p class="section-kicker">LIBRARY</p>
                <h2 id="library-heading" class="section-title">{{ hasFilters ? '筛选结果' : '全部漫画' }}</h2>
              </div>
              <span class="editorial-count">CATALOG / {{ String(lib.filtered.length).padStart(3, '0') }}</span>
            </div>
            <div class="mb-6 flex flex-wrap items-center gap-2" aria-label="智能书架与排序">
              <button v-for="shelf in [
                ['all', '全部'], ['unread', '未开始'], ['reading', '阅读中'], ['completed', '已完成'], ['favorite', '收藏'], ['source-issues', '来源异常'],
              ]" :key="shelf[0]" class="chip" :class="lib.shelfFilter === shelf[0] ? 'chip--active' : ''" :aria-pressed="lib.shelfFilter === shelf[0]" @click="lib.shelfFilter = shelf[0] as any">{{ shelf[1] }}</button>
              <button v-if="hasFilters" class="comic-btn comic-btn--ghost" @click="clearFilters">清除筛选</button>
              <label class="ml-auto flex min-h-11 items-center gap-2 border-b border-[color:var(--line)] px-2 text-xs text-[color:var(--text-dim)]">
                排序
                <select v-model="lib.sortMode" class="bg-transparent py-2 font-semibold text-[color:var(--text)] outline-none">
                  <option value="recent">最近阅读</option><option value="imported">最近导入</option><option value="title">标题</option><option value="progress">进度</option><option value="series">系列顺序</option>
                </select>
              </label>
            </div>

            <div v-if="selecting && lib.filtered.length" class="library-grid">
              <ComicCard
                v-for="(c, index) in pagedSelection"
                :key="c.id"
                :comic="c"
                :index="(catalogPage - 1) * PAGE_SIZE + index + 1"
                selectable
                :selected="selected.has(c.id)"
                @toggle="toggleSelect"
              />
            </div>

            <div v-else-if="lib.filtered.length" class="library-grid">
              <template v-for="(g, groupIndex) in pagedSeriesGroups" :key="g.series">
                <ComicCard v-if="g.count === 1" :comic="g.comics[0]" :index="(catalogPage - 1) * PAGE_SIZE + groupIndex + 1" @open="emit('open', $event)" @edit="openEdit" @reset="confirmReset" @favorite="lib.toggleFavorite" @rescan="rescanComic" @relink="relinkComic" @delete-source="deleteSource" @remove="confirmRemove" />
                <template v-else>
                  <button type="button" class="series-header" :aria-expanded="expanded.has(g.series)" @click="toggleExpand(g.series)">
                    <div class="relative h-14 w-11 shrink-0 overflow-hidden rounded-lg border border-[color:var(--line)] bg-[color:var(--surface-2)]">
                      <ComicCover :comic="g.comics[0]" :alt="`${g.series} 系列封面`" />
                    </div>
                    <div class="min-w-0 flex-1 text-left">
                      <h3 class="truncate text-base font-semibold text-[color:var(--text)]">{{ g.series }}</h3>
                      <p class="mt-0.5 text-xs text-[color:var(--text-dim)]">{{ g.count }} 话 · {{ expanded.has(g.series) ? '收起系列' : '展开系列' }}</p>
                    </div>
                    <span class="rounded-md bg-[color:var(--surface-3)] px-2 py-1 text-xs font-semibold text-[color:var(--text-dim)]">{{ g.count }}</span>
                    <Icon :name="expanded.has(g.series) ? 'chevron-up' : 'chevron-down'" :size="18" />
                  </button>
                  <div v-if="expanded.has(g.series)" class="library-grid series-grid">
                    <ComicCard v-for="(c, issueIndex) in visibleSeriesComics(g.series, g.comics)" :key="c.id" :comic="c" :index="((seriesPages[g.series] || 1) - 1) * PAGE_SIZE + issueIndex + 1" @open="emit('open', $event)" @edit="openEdit" @reset="confirmReset" @favorite="lib.toggleFavorite" @rescan="rescanComic" @relink="relinkComic" @delete-source="deleteSource" @remove="confirmRemove" />
                    <nav v-if="g.count > PAGE_SIZE" class="col-span-full flex items-center justify-center gap-3 py-3" :aria-label="`${g.series} 分页`">
                      <button class="comic-btn comic-btn--ghost" :disabled="(seriesPages[g.series] || 1) <= 1" @click="setSeriesPage(g.series, (seriesPages[g.series] || 1) - 1, g.count)">上一页</button>
                      <span class="text-xs text-[color:var(--text-dim)]">{{ seriesPages[g.series] || 1 }} / {{ Math.ceil(g.count / PAGE_SIZE) }}</span>
                      <button class="comic-btn comic-btn--ghost" :disabled="(seriesPages[g.series] || 1) >= Math.ceil(g.count / PAGE_SIZE)" @click="setSeriesPage(g.series, (seriesPages[g.series] || 1) + 1, g.count)">下一页</button>
                    </nav>
                  </div>
                </template>
              </template>
            </div>
            <div v-else class="grid min-h-[52vh] place-items-center" aria-live="polite">
              <div class="editorial-empty halftone-accent max-w-md">
                <div class="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-xl bg-[color:var(--surface-3)] text-[color:var(--text-dim)]"><Icon name="search" :size="24" /></div>
                <h2 class="text-xl font-bold text-[color:var(--text)]">没有找到匹配的漫画</h2>
                <p class="mt-2 text-sm text-[color:var(--text-dim)]">试试更短的书名，或清除当前筛选条件。</p>
                <button class="comic-btn comic-btn--ghost mt-5" @click="clearFilters">清除筛选</button>
              </div>
            </div>
            <nav v-if="catalogPages > 1" class="mt-8 flex items-center justify-center gap-3" aria-label="书库分页">
              <button class="comic-btn comic-btn--ghost" :disabled="catalogPage <= 1" @click="catalogPage--">上一页</button>
              <span class="editorial-count">{{ catalogPage }} / {{ catalogPages }}</span>
              <button class="comic-btn comic-btn--ghost" :disabled="catalogPage >= catalogPages" @click="catalogPage++">下一页</button>
            </nav>
          </section>
        </template>

        <section v-else class="grid min-h-[58vh] place-items-center">
          <div class="editorial-empty halftone-accent max-w-lg">
            <img src="/favicon.svg" alt="" class="masthead-logo mb-6 h-16 w-16" />
            <p class="section-kicker">YOUR LOCAL LIBRARY</p>
            <h2 class="mt-2 text-2xl font-bold tracking-tight text-[color:var(--text)]">把第一本漫画放上书架</h2>
            <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-[color:var(--text-dim)]">支持图片文件夹、PDF、CBZ 与 CBR。所有书目和阅读进度都保存在本机。</p>
            <div class="mt-6 flex items-center justify-center gap-3">
              <button class="comic-btn comic-btn--accent" @click="importOpen = true"><Icon name="plus" :size="18" /> 选择文件导入</button>
              <button v-if="nativeSupported" class="comic-btn comic-btn--ghost" @click="onNativeDirectory"><Icon name="scan-line" :size="18" /> 扫描目录</button>
              <button v-else-if="fsaSupported" class="comic-btn comic-btn--ghost" @click="onScan"><Icon name="scan-line" :size="18" /> 扫描目录</button>
            </div>
          </div>
        </section>
      </div>
    </main>

    <Transition name="view">
      <div v-if="healthOpen" class="absolute inset-0 z-50 grid place-items-center bg-black/35 p-6 backdrop-blur-sm" @click.self="healthOpen = false" @keydown.esc="healthOpen = false">
        <section class="card flex max-h-[86vh] w-[min(92vw,720px)] flex-col p-5" role="dialog" aria-modal="true" aria-labelledby="health-title">
          <div class="mb-4 flex items-center justify-between"><div><p class="section-kicker">SOURCE HEALTH</p><h2 id="health-title" class="text-xl font-bold text-[color:var(--text)]">来源健康中心</h2></div><button class="icon-button" aria-label="关闭来源健康中心" @click="healthOpen = false"><Icon name="x" :size="19" /></button></div>
          <div class="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            <section class="panel-section">
              <div class="panel-row"><div><p class="panel-row__label">阅读缓存</p><p class="mt-1 text-xs text-[color:var(--text-dim)]">{{ cacheStats.files }} 个文件 · {{ formatBytes(cacheStats.bytes) }} / {{ formatBytes(cacheStats.limitBytes) }}</p></div><button class="comic-btn comic-btn--ghost" @click="clearCache">清理缓存</button></div>
            </section>
            <section>
              <div class="mb-2 flex items-center justify-between gap-2"><h3 class="mr-auto font-semibold text-[color:var(--text)]">受监控目录</h3><button v-if="watchedRoots.length" class="comic-btn comic-btn--ghost" @click="scanWatchedRoots">扫描并导入</button><button class="comic-btn comic-btn--ghost" @click="addWatchedRoot"><Icon name="plus" :size="16" /> 添加目录</button></div>
              <p v-if="!watchedRoots.length" class="border border-dashed border-[color:var(--line)] p-4 text-sm text-[color:var(--text-dim)]">尚未监控目录。目录变化只会标记待处理状态，不会自动删除书目。</p>
              <ul v-else class="panel-section"><li v-for="root in watchedRoots" :key="root" class="panel-row"><span class="min-w-0 truncate text-sm" :title="root">{{ root }}</span><button class="icon-button" aria-label="停止监控目录" @click="removeWatchedRoot(root)"><Icon name="x" :size="16" /></button></li></ul>
            </section>
            <section>
              <div class="mb-2 flex items-center justify-between"><h3 class="font-semibold text-[color:var(--text)]">待处理来源 · {{ sourceIssues.length }}</h3><button v-if="sourceIssues.some((comic) => comic.source.type === 'native-dir')" class="comic-btn comic-btn--ghost" @click="rescanChangedSources">批量扫描变更</button></div>
              <p v-if="!sourceIssues.length" class="border border-[color:var(--line)] p-4 text-sm text-[color:var(--text-dim)]">所有已知来源状态正常。</p>
              <ul v-else class="panel-section"><li v-for="comic in sourceIssues" :key="comic.id" class="panel-row"><div class="min-w-0"><p class="truncate font-semibold">{{ comic.title }}</p><p class="mt-1 text-xs text-[color:var(--danger)]">{{ sourceIssueLabel(comic.source) }}</p></div><div class="flex gap-1"><button v-if="comic.source.type === 'native-dir'" class="comic-btn comic-btn--ghost" @click="rescanComic(comic.id)">扫描</button><button class="comic-btn comic-btn--ghost" @click="relinkComic(comic.id)">{{ comic.source.type === 'input' || comic.source.type === 'web-cache' ? '重新导入' : comic.source.type === 'fsa-dir' || comic.source.type === 'fsa-file' ? '重新授权' : '关联' }}</button></div></li></ul>
            </section>
          </div>
        </section>
      </div>
    </Transition>

    <Transition name="view">
      <div v-if="editOpen" class="absolute inset-0 z-50 grid place-items-center bg-black/35 p-6 backdrop-blur-sm" @click.self="editOpen = false" @keydown.esc="editOpen = false">
        <form class="card w-[460px] max-w-full space-y-4 p-5" role="dialog" aria-modal="true" aria-labelledby="edit-comic-title" @submit.prevent="saveEdit">
          <div class="flex items-center justify-between"><h2 id="edit-comic-title" class="text-xl font-bold text-[color:var(--text)]">编辑书目</h2><button type="button" class="icon-button" aria-label="关闭编辑" @click="editOpen = false"><Icon name="x" :size="19" /></button></div>
          <label class="block text-sm font-medium text-[color:var(--text)]">书名<input v-model="editTitle" required class="mt-1.5 w-full rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] px-3 py-2.5" /></label>
          <label class="block text-sm font-medium text-[color:var(--text)]">系列<input v-model="editSeries" class="mt-1.5 w-full rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] px-3 py-2.5" placeholder="留空则按书名自动归类" /></label>
          <label class="block text-sm font-medium text-[color:var(--text)]">标签<input v-model="editTags" class="mt-1.5 w-full rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] px-3 py-2.5" placeholder="用逗号分隔" /></label>
          <label class="block text-sm font-medium text-[color:var(--text)]">自定义封面<input type="file" accept="image/*" class="mt-1.5 block w-full text-sm text-[color:var(--text-dim)]" @change="onCoverFile" /></label>
          <div class="flex justify-end gap-3 pt-2"><button type="button" class="comic-btn comic-btn--ghost" @click="editOpen = false">取消</button><button class="comic-btn comic-btn--accent">保存</button></div>
        </form>
      </div>
    </Transition>

    <Transition name="view">
      <div v-if="bookmarksOpen" class="absolute inset-0 z-50 grid place-items-center bg-black/35 p-6 backdrop-blur-sm" @click.self="closeBookmarks" @keydown.esc="closeBookmarks" @keydown="trapFocus($event, bookmarkDialog)">
        <section ref="bookmarkDialog" class="card flex max-h-[80vh] w-[420px] max-w-full flex-col p-5" role="dialog" aria-modal="true" aria-labelledby="bookmark-title">
          <div class="mb-3 flex items-center justify-between">
            <div>
              <p class="section-kicker">SAVED PAGES</p>
              <h2 id="bookmark-title" class="text-xl font-bold text-[color:var(--text)]">书签</h2>
            </div>
            <button class="icon-button" aria-label="关闭书签" title="关闭" @click="closeBookmarks"><Icon name="x" :size="19" /></button>
          </div>
          <div v-if="!bookmarkList.length" class="py-10 text-center text-sm text-[color:var(--text-dim)]">
            还没有书签。在阅读页按 <kbd class="kbd">B</kbd> 保存当前页。
          </div>
          <ul v-else class="flex-1 space-y-1.5 overflow-y-auto pr-1">
            <li v-for="b in bookmarkList" :key="b.id" class="flex items-center gap-2 rounded-lg p-1.5 hover:bg-[color:var(--wash)]">
              <button class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm text-[color:var(--text)]" @click="openBookmark(b)">
                <Icon name="bookmark" :size="16" />
                <span class="min-w-0"><span class="block truncate">{{ comicTitle(b.comicId) }}</span><span v-if="b.label" class="block truncate text-xs text-[color:var(--text-dim)]">{{ b.label }}</span></span>
                <span class="ml-auto shrink-0 text-xs text-[color:var(--text-dim)]">第 {{ Math.round(b.position) }} 页</span>
              </button>
              <input :value="b.label" class="w-24 rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] px-2 py-1.5 text-xs" placeholder="备注" :aria-label="`${comicTitle(b.comicId)} 的书签备注`" @change="lib.updateBookmark(b.id, ($event.target as HTMLInputElement).value)" />
              <button class="icon-button text-[color:var(--text-dim)] hover:text-[color:var(--danger)]" :aria-label="`删除 ${comicTitle(b.comicId)} 的书签`" title="删除书签" @click="lib.removeBookmark(b.id)"><Icon name="trash-2" :size="16" /></button>
            </li>
          </ul>
        </section>
      </div>
    </Transition>

    <!-- 阅读统计 -->
    <Transition name="view">
      <div v-if="statsOpen" class="absolute inset-0 z-50 grid place-items-center bg-black/35 p-6 backdrop-blur-sm" @click.self="statsOpen = false" @keydown.esc="statsOpen = false">
        <section class="card flex max-h-[85vh] w-[520px] max-w-full flex-col gap-4 overflow-y-auto p-5" role="dialog" aria-modal="true" aria-labelledby="stats-title">
          <div class="flex items-center justify-between">
            <div><p class="section-kicker">READING STATS</p><h2 id="stats-title" class="text-xl font-bold text-[color:var(--text)]">阅读统计</h2></div>
            <button class="icon-button" aria-label="关闭阅读统计" title="关闭" @click="statsOpen = false"><Icon name="x" :size="19" /></button>
          </div>
          <template v-if="stats">
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div class="stat-tile"><Icon name="clock" :size="18" /><p class="stat-tile__value">{{ formatDuration(stats.totalMs) }}</p><p class="stat-tile__label">累计阅读</p></div>
              <div class="stat-tile"><Icon name="flame" :size="18" /><p class="stat-tile__value">{{ stats.streakDays }} 天</p><p class="stat-tile__label">连续阅读</p></div>
              <div class="stat-tile"><Icon name="calendar" :size="18" /><p class="stat-tile__value">{{ formatDuration(stats.weekMs) }}</p><p class="stat-tile__label">本周阅读</p></div>
              <div class="stat-tile"><Icon name="book-open" :size="18" /><p class="stat-tile__value">{{ stats.comicsTouched }} 本</p><p class="stat-tile__label">读过书目</p></div>
            </div>
            <div>
              <p class="mb-2 text-sm font-semibold text-[color:var(--text)]">最近 7 天</p>
              <div class="flex items-end gap-2" style="height: 128px">
                <div v-for="d in stats.daily" :key="d.dayKey" class="flex flex-1 flex-col items-center justify-end gap-1">
                  <span class="text-[10px] tabular-nums text-[color:var(--text-dim)]">{{ d.ms ? Math.round(d.ms / 60000) + 'm' : '' }}</span>
                  <div class="stat-bar" :class="{ 'stat-bar--empty': !d.ms }" :style="{ height: Math.max(2, Math.round((d.ms / statsMaxMs) * 84)) + 'px' }" />
                  <span class="text-[10px] text-[color:var(--text-dim)]">{{ d.label }}</span>
                </div>
              </div>
            </div>
            <p class="text-xs text-[color:var(--text-dim)]">共 {{ stats.sessionCount }} 次阅读 · 翻页 {{ stats.pagesTurned }} 页 · 仅统计时长 3 秒以上的有效会话</p>
          </template>
          <p v-else class="py-6 text-center text-sm text-[color:var(--text-dim)]">正在汇总…</p>
        </section>
      </div>
    </Transition>

    <!-- 批量标签 / 系列 -->
    <Transition name="view">
      <div v-if="batchEditOpen" class="absolute inset-0 z-50 grid place-items-center bg-black/35 p-6 backdrop-blur-sm" @click.self="batchEditOpen = false" @keydown.esc="batchEditOpen = false">
        <section class="card w-[420px] max-w-full space-y-4 p-5" role="dialog" aria-modal="true" aria-labelledby="batch-edit-title">
          <div class="flex items-center justify-between">
            <h2 id="batch-edit-title" class="text-xl font-bold text-[color:var(--text)]">批量编辑 · {{ selected.size }} 本</h2>
            <button class="icon-button" aria-label="关闭批量编辑" title="关闭" @click="batchEditOpen = false"><Icon name="x" :size="19" /></button>
          </div>
          <label class="block text-sm font-medium text-[color:var(--text)]">添加标签<input v-model="batchAddTags" class="mt-1.5 w-full rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] px-3 py-2.5" placeholder="用逗号分隔，如：已读, 收藏" /></label>
          <label class="block text-sm font-medium text-[color:var(--text)]">统一系列（留空不改动）<input v-model="batchSeries" class="mt-1.5 w-full rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)] px-3 py-2.5" placeholder="如：海贼王" /></label>
          <div class="flex justify-end gap-3 pt-2">
            <button class="comic-btn comic-btn--ghost" @click="batchEditOpen = false">取消</button>
            <button class="comic-btn comic-btn--accent" @click="applyBatchEdit">应用</button>
          </div>
        </section>
      </div>
    </Transition>
  </div>
</template>
