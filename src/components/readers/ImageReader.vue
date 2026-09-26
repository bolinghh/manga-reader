<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type { Comic, ReaderFile, ReaderUiState } from '../../types'
import { readFile } from '@tauri-apps/plugin-fs'
import { useReadingSettings } from '../../stores/settings'
import { useLibrary } from '../../stores/library'
import { sharpenFileToUrl } from '../../utils/sharpen'
import { pagedIndexFromWebtoon, webtoonWindow, FenwickTree } from '../../utils/readerState'
import { autoCropFileToUrl } from '../../utils/autoCrop'
import TranslationLayer from '../TranslationLayer.vue'
import type { TranslationActivation, TranslationLayerState, TranslationRect, TranslationSelection } from '../../types/translation'
import { frameFromBlob, throwIfAborted } from '../../utils/translationImage'
import { readBrowserPage } from '../../services/browserPageCache'

const props = defineProps<{ comic: Comic; files: ReaderFile[]; initialPage?: number | null; translation?: TranslationLayerState }>()
const emit = defineEmits<{
  (e: 'progress', p: { position: number; total: number }): void
  (e: 'ui-state', state: ReaderUiState): void
  (e: 'translation-select', value: TranslationActivation): void
  (e: 'translation-region', value: TranslationSelection): void
}>()

// 按需创建/回收 blob URL: 不一次性为所有图片 createObjectURL, 只在使用范围内持有,
// 避免整本(尤其文件夹里上千张)图片 URL 与解码常驻内存。翻页=可见+邻页; 滚动=窗口±10。
const total = props.files.length
// 初始页: 从书签进入时携带 initialPage, 否则用上次阅读进度 lastPosition
const startPage = props.initialPage && props.initialPage >= 1 ? Math.min(props.initialPage, total) : (props.comic.lastPosition || 1)
const urlCache = reactive(new Map<number, string>())
const urlPending = new Map<number, Promise<string>>()
const objectUrls = new Set<number>()
type PageFrame = { index: number; url: string }
// Decode the actual incoming DOM images before switching the complete spread.
const pageBuffers = shallowRef<PageFrame[][]>([[], []])
const activeBuffer = ref(0)
const bufferImages = [new Map<number, HTMLImageElement>(), new Map<number, HTMLImageElement>()]
const preloadImages = new Map<number, { url: string; image: HTMLImageElement; ready: Promise<void> }>()
const retiredUrls = new Set<string>()
const pageLoading = ref(false)
const loadingHint = ref(false)
const pageError = ref('')
let loadingHintTimer: number | undefined
let pageGeneration = 0
let sourceGeneration = 0
let disposed = false
function holdsUrl(url: string) { return pageBuffers.value.some((pages) => pages.some((page) => page.url === url)) }
function flushRetiredUrls() {
  for (const url of retiredUrls) {
    if (!holdsUrl(url)) { URL.revokeObjectURL(url); retiredUrls.delete(url) }
  }
}
function urlFor(i: number): string {
  return i < 0 || i >= props.files.length ? '' : (urlCache.get(i) || '')
}
async function ensurePageUrl(i: number): Promise<string> {
  if (i < 0 || i >= props.files.length) return ''
  const cached = urlCache.get(i)
  if (cached) return cached
  const pending = urlPending.get(i)
  if (pending) return pending
  const generation = sourceGeneration
  const task: Promise<string> = (async () => {
    const source = props.files[i]
    let url = ''
    let objectUrl = false
    if (props.comic.autoCrop) {
      url = await autoCropFileToUrl(await materialize(i))
      objectUrl = true
    } else if (source.kind === 'native-resource') {
      url = source.url
    } else if (source.kind === 'native-path') {
      url = URL.createObjectURL(await materialize(i))
      objectUrl = true
    } else {
      const file = await materialize(i)
      url = URL.createObjectURL(file)
      objectUrl = true
    }
    // A late handle read from an obsolete jump must not resurrect an out-of-window page.
    if (disposed || generation !== sourceGeneration || !inActiveRange(i)) {
      if (objectUrl) URL.revokeObjectURL(url)
      return ''
    }
    urlCache.set(i, url)
    if (objectUrl) objectUrls.add(i)
    return url
  })().finally(() => { if (urlPending.get(i) === task) urlPending.delete(i) })
  urlPending.set(i, task)
  return task
}
function releaseUrl(i: number) {
  const u = urlCache.get(i)
  if (u) {
    if (objectUrls.has(i)) {
      if (holdsUrl(u)) retiredUrls.add(u)
      else URL.revokeObjectURL(u)
    }
    objectUrls.delete(i)
    urlCache.delete(i)
    preloadImages.delete(i)
    loadedPages.delete(i)
  }
}
function releaseAllUrls() {
  for (const i of [...urlCache.keys()]) releaseUrl(i)
  preloadImages.clear()
  flushRetiredUrls()
}
async function materialize(i: number): Promise<File> {
  const source = props.files[i]
  if (source.kind === 'file') return source.file
  if (source.kind === 'cached-page') return readBrowserPage(source.comicId, source.pageIndex)
  if (source.kind === 'fsa-handle') return source.handle.getFile()
  if (source.kind === 'native-resource') {
    const blob = await (await fetch(source.url)).blob()
    return new File([blob], source.name, { type: source.type })
  }
  const bytes = await readFile(source.path)
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new File([data], source.name, { type: source.type })
}
const settings = useReadingSettings()
const lib = useLibrary()

// ---- 阅读状态 ----
const idx = ref(Math.min(Math.max(0, startPage - 1), total - 1))
const mode = ref<'single' | 'double'>(props.comic.pageMode ?? 'single')
const dir = ref<'ltr' | 'rtl'>(props.comic.pageDir ?? 'rtl')
const readMode = ref<'page' | 'webtoon'>(props.comic.readMode ?? 'page')
const currentIndex = ref(idx.value) // 当前页(用于进度 + 缩略图高亮), page 模式等于 idx, webtoon 由滚动推导
// 适应模式(翻页): 宽度(默认, contain) / 高度 / 原大
const fit = ref<'width' | 'height' | 'actual'>(props.comic.fit ?? 'width')
const rotation = computed(() => props.comic.rotation || 0)
const spreadOffset = computed(() => props.comic.spreadOffset || 0)
// ---- 跨页大图自动合并 (opt-in, 仅双页模式) ----
// 识别"横向宽页"(宽/高 > 阈值)并让其独占一摊, 避免被当作普通页与相邻页错配。
const autoSpread = computed(() => props.comic.autoSpread === true)
const WIDE_RATIO = 1.35
const widePages = reactive(new Set<number>())
let spreadLayout: number[] = []
let spreadLayoutKey = ''
function rebuildSpreadLayout() {
  const key = `${total}|${spreadOffset.value}|${[...widePages].sort((a, b) => a - b).join(',')}`
  if (key === spreadLayoutKey) return
  spreadLayoutKey = key
  const layout = new Array<number>(total)
  let i = 0
  while (i < total) {
    layout[i] = i
    if (spreadOffset.value === 1 && i === 0) { i += 1; continue } // 封面单独一摊
    if (widePages.has(i)) { i += 1; continue } // 宽页独占
    if (i + 1 < total && !widePages.has(i + 1)) { layout[i + 1] = i; i += 2 }
    else i += 1
  }
  spreadLayout = layout
}
function alignDouble(index: number) {
  if (autoSpread.value) {
    rebuildSpreadLayout()
    return spreadLayout[Math.min(Math.max(0, index), total - 1)] ?? index
  }
  if (spreadOffset.value === 1) return index <= 0 ? 0 : Math.floor((index - 1) / 2) * 2 + 1
  return Math.floor(index / 2) * 2
}
const fitClass = computed(() => {
  if (fit.value === 'height') return 'max-h-[92vh]'
  if (fit.value === 'actual') return ''
  return 'max-h-[92vh] max-w-full' // width: contain
})
// #5: 滚动模式列宽缩放 —— 通过列容器 max-width 实现(布局级缩放, 滚动天然正确), 不再用 zoom/transform 叠加
const webtoonScale = ref(1)
const webtoonColStyle = computed(() => {
  if (readMode.value !== 'webtoon') return {}
  return { maxWidth: Math.round(1000 * webtoonScale.value) + 'px' }
})
const FIT_ORDER = ['width', 'height', 'actual'] as const
function cycleFit() {
  const i = FIT_ORDER.indexOf(fit.value)
  fit.value = FIT_ORDER[(i + 1) % FIT_ORDER.length]
  lib.setFitMode(props.comic.id, fit.value)
}

// ---- 翻页(paged) ----
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)
const start = { x: 0, y: 0, tx: 0, ty: 0, type: '' as string }

const visibleIdx = computed(() => {
  if (readMode.value === 'webtoon') return [idx.value]
  if (mode.value !== 'double') return [idx.value]
  if (spreadOffset.value === 1 && idx.value === 0) return [0]
  if (autoSpread.value) {
    const base = alignDouble(idx.value)
    if (widePages.has(base)) return [base] // 宽页独占一屏
    const b = base + 1
    const pair = dir.value === 'rtl' ? [b, base] : [base, b]
    return pair.filter((i) => i < total && !widePages.has(i))
  }
  const a = idx.value
  const b = idx.value + 1
  // 双页铺开方向: ltr 左页小号、右页大号(从左往右); rtl 反之(漫画从右往左)
  return dir.value === 'rtl'
    ? [b, a].filter((i) => i < total)
    : [a, b].filter((i) => i < total)
})
const position = computed(() => currentIndex.value + 1)

// ---- 轻量锐化 (canvas 带阈值 USM, 借鉴 warpsharp/MangaMeeya 的 UnsharpMask 思想) ----
// 仅对"可见页"生成锐化结果并按索引缓存 blob URL; 切走/关闭/换参即回收, 内存有界。
const sharpCache = reactive(new Map<number, string>())
const sharpPending = new Map<number, number>()
// 并发受限: 滚动进入多页时, 解码+锐化最多同时 2 个, 其余排队, 避免主线程瞬时 pile-up
const SHARP_CONCURRENCY = 2
const SHARP_BUDGET_BYTES = 128 * 1024 * 1024
let sharpRunning = 0
let sharpGeneration = 0
const sharpQueue: { index: number; generation: number }[] = []
function enforceSharpBudget(center: number) {
  let bytes = [...sharpCache.keys()].reduce((sum, index) => sum + (decodedBytes[index] || UNKNOWN_PAGE_BYTES), 0)
  const candidates = [...sharpCache.keys()]
    .filter((index) => index !== center)
    .sort((a, b) => Math.abs(b - center) - Math.abs(a - center))
  while (bytes > SHARP_BUDGET_BYTES && candidates.length) {
    const index = candidates.shift()!
    bytes -= decodedBytes[index] || UNKNOWN_PAGE_BYTES
    revokeSharp(index)
  }
}
function pumpSharp() {
  while (sharpRunning < SHARP_CONCURRENCY && sharpQueue.length) {
    const job = sharpQueue.shift()!
    const i = job.index
    sharpRunning++
    materialize(i).then((file) => sharpenFileToUrl(file, sharpenParams()))
      .then((url) => {
        if (job.generation === sharpGeneration && inActiveRange(i)) {
          sharpCache.set(i, url)
          enforceSharpBudget(currentIndex.value)
        } else URL.revokeObjectURL(url)
      })
      .catch(() => {
        /* 锐化失败 -> 保留原图 */
      })
      .finally(() => {
        sharpRunning--
        if (sharpPending.get(i) === job.generation) sharpPending.delete(i)
        pumpSharp()
      })
  }
}
function sharpenParams() {
  return {
    radius: settings.sharpenRadius,
    strength: settings.sharpenStrength,
    threshold: settings.sharpenThreshold,
  }
}
function revokeSharp(i: number) {
  const u = sharpCache.get(i)
  if (u) {
    URL.revokeObjectURL(u)
    sharpCache.delete(i)
  }
}
function ensureSharpened(i: number) {
  if (!settings.sharpen || i < 0 || i >= props.files.length) return
  if (sharpCache.has(i) || sharpPending.has(i)) return
  sharpPending.set(i, sharpGeneration)
  sharpQueue.push({ index: i, generation: sharpGeneration })
  pumpSharp()
}
function cancelSharpenWork() {
  sharpGeneration++
  sharpQueue.length = 0
  sharpPending.clear()
  sharpCache.forEach((_, index) => revokeSharp(index))
}
// 翻页模式: 只生成可见页, 回收其余缓存
function syncPageSharpen() {
  if (!settings.sharpen) {
    sharpCache.forEach((_, k) => revokeSharp(k))
    return
  }
  const vis = new Set(visibleIdx.value)
  sharpCache.forEach((_, k) => {
    if (!vis.has(k)) revokeSharp(k)
  })
  visibleIdx.value.forEach(ensureSharpened)
}

function emitProgress() {
  emit('progress', { position: position.value, total })
}

function clamp() {
  const max = total - (mode.value === 'double' ? Math.min(2, total) : 1)
  idx.value = Math.min(Math.max(0, idx.value), Math.max(0, max))
  if (mode.value === 'double' && total === 1) idx.value = 0
}

function resetZoom() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
  webtoonScale.value = 1
}

// ---- 导航(两种模式统一出口) ----
function next() {
  if (readMode.value === 'webtoon') {
    scrollEl.value?.scrollBy({ top: scrollEl.value.clientHeight * 0.9, behavior: 'smooth' })
    return
  }
  if (mode.value === 'double' && autoSpread.value) {
    idx.value = alignDouble(Math.min(idx.value + 2, total - 1))
  } else {
    idx.value = mode.value === 'double' && spreadOffset.value === 1 && idx.value === 0
      ? Math.min(1, total - 1)
      : Math.min(idx.value + (mode.value === 'double' ? 2 : 1), total - 1)
  }
  currentIndex.value = idx.value
  resetZoom()
  emitProgress()
  prefetch()
  gcUrls()
}
function prev() {
  if (readMode.value === 'webtoon') {
    scrollEl.value?.scrollBy({ top: -scrollEl.value.clientHeight * 0.9, behavior: 'smooth' })
    return
  }
  if (mode.value === 'double' && autoSpread.value) {
    idx.value = alignDouble(Math.max(0, idx.value - 2))
  } else {
    idx.value = mode.value === 'double' && spreadOffset.value === 1 && idx.value <= 1
      ? 0
      : Math.max(idx.value - (mode.value === 'double' ? 2 : 1), 0)
  }
  currentIndex.value = idx.value
  resetZoom()
  emitProgress()
  prefetch()
  gcUrls()
}
function goTo(n: number) {
  const i = Math.min(Math.max(0, n - 1), total - 1)
  if (readMode.value === 'webtoon') {
    void jumpToWebtoon(i, 'jump')
  } else {
    idx.value = mode.value === 'double' ? alignDouble(i) : i
    currentIndex.value = i
    resetZoom()
    emitProgress()
    gcUrls()
  }
}
function zoom(d: number) {
  if (readMode.value === 'webtoon') {
    setWebtoonZoom(d)
  } else {
    scale.value = Math.min(4, Math.max(0.4, Math.round((scale.value + d) * 10) / 10))
    if (scale.value === 1) {
      tx.value = 0
      ty.value = 0
    }
  }
}
function setMode(target: 'single' | 'double') {
  if (mode.value === target) return
  const wasLeft = idx.value
  mode.value = target
  idx.value = target === 'double' ? alignDouble(wasLeft) : wasLeft
  clamp()
  currentIndex.value = idx.value
  resetZoom()
  emitProgress()
  lib.setPageMode(props.comic.id, mode.value)
}
function setDir(target: 'ltr' | 'rtl') {
  if (dir.value === target) return
  dir.value = target
  lib.setPageDir(props.comic.id, dir.value)
}
function toggleReadMode() {
  const nextMode = readMode.value === 'webtoon' ? 'page' : 'webtoon'
  readMode.value = nextMode
  lib.setReadMode(props.comic.id, nextMode)
  if (nextMode === 'webtoon') {
    resetZoom()
    nextTick(() => void jumpToWebtoon(currentIndex.value, 'mode-switch'))
  } else {
    jumpGeneration++
    pendingAnchor = null
    cancelSharpenWork()
    idx.value = mode.value === 'double' ? alignDouble(currentIndex.value) : pagedIndexFromWebtoon(currentIndex.value, mode.value, total)
    clamp()
    currentIndex.value = idx.value
    emitProgress()
    syncPageSharpen()
    gcUrls()
  }
}

// ---- pan (paged, zoomed) + 滑动手势 (仅触屏/笔) ----
function onImgLoad(i: number, e?: Event) {
  loadedPages.add(i)
  failedPages.delete(i)
  if (!e) return
  const img = e.target as HTMLImageElement
  recordImageSize(i, img)
}
function recordImageSize(i: number, img: HTMLImageElement) {
  if (!img.naturalWidth || !img.naturalHeight) return
  const quarterTurn = rotation.value === 90 || rotation.value === 270
  const dispW = quarterTurn ? img.naturalHeight : img.naturalWidth
  const dispH = quarterTurn ? img.naturalWidth : img.naturalHeight
  decodedBytes[i] = Math.max(1, img.naturalWidth * img.naturalHeight * 4)
  // 跨页自动合并: 记录"横向宽页"(翻页/滚动模式都记, 切模式后立即可用)
  if (autoSpread.value) {
    const wide = dispW / dispH > WIDE_RATIO
    if (wide && !widePages.has(i)) widePages.add(i)
    else if (!wide && widePages.has(i)) widePages.delete(i)
  }
  if (readMode.value === 'webtoon') {
    // 用真实宽高比更新该页稳定高度; 视口上方页面高度变化时补偿 scrollTop, 避免画面跳动
    refreshPageHeight(i, dispW, dispH, img.clientWidth)
    updateWindow(currentIndex.value)
  }
}
function onImgError(i: number) {
  failedPages.add(i)
  loadedPages.delete(i)
  if (pendingAnchor === i) pendingAnchor = null
}
function onDown(e: PointerEvent) {
  if (pinchActive) return // 双指缩放进行中, 忽略单指拖动
  start.x = e.clientX
  start.y = e.clientY
  start.tx = tx.value
  start.ty = ty.value
  start.type = e.pointerType
  if (scale.value > 1) {
    dragging.value = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
}
function onMove(e: PointerEvent) {
  if (!dragging.value || pinchActive) return
  tx.value = start.tx + e.clientX - start.x
  ty.value = start.ty + e.clientY - start.y
}
function onUp(e?: PointerEvent) {
  if (dragging.value) {
    dragging.value = false
    return
  }
  if (!e) return
  // 仅触屏/笔设备允许横向滑动翻页; 鼠标拖拽一律不触发, 避免桌面端误触翻页
  if (start.type !== 'touch' && start.type !== 'pen') return
  // 翻页模式滑动手势: 水平位移超阈值且明显大于垂直 -> 翻页(左滑下一页, 右滑上一页)
  const dx = e.clientX - start.x
  const dy = e.clientY - start.y
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (dx < 0) next()
    else prev()
  }
}
// ---- 双指缩放 (触屏捏合) ----
// 分页模式改 scale(transform); 滚动模式改列宽。滚动模式若每次 move 都重算高度模型会很贵,
// 故 move 只更新视觉列宽(cheap), touchend 再按新列宽重排并把当前页钉回原位。
let pinchDist = 0
let pinchActive = false
const clampScale = (v: number) => Math.min(4, Math.max(0.4, v))
function pinchSpan(touches: TouchList) {
  const a = touches[0]
  const b = touches[1]
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}
function onTouchStart(e: TouchEvent) {
  if (e.touches.length === 2) {
    pinchDist = pinchSpan(e.touches)
    pinchActive = true
  }
}
function onTouchMove(e: TouchEvent) {
  if (!pinchActive || e.touches.length !== 2 || !pinchDist) return
  e.preventDefault()
  const span = pinchSpan(e.touches)
  if (!span) return
  const factor = span / pinchDist
  pinchDist = span
  if (readMode.value === 'webtoon') {
    webtoonScale.value = clampScale(webtoonScale.value * factor)
  } else {
    scale.value = clampScale(scale.value * factor)
    if (scale.value === 1) {
      tx.value = 0
      ty.value = 0
    }
  }
}
function onTouchEnd(e: TouchEvent) {
  if (!pinchActive || e.touches.length >= 2) return
  pinchActive = false
  pinchDist = 0
  if (readMode.value === 'webtoon') {
    const anchor = currentIndex.value
    nextTick(() => {
      syncColW()
      nextTick(() => alignPageToTop(anchor, jumpGeneration))
    })
  }
}

function neighborPages() {
  const visible = visibleIdx.value
  const first = Math.min(...visible), last = Math.max(...visible)
  const step = mode.value === 'double' ? 2 : 1
  return Array.from({ length: step }, (_, offset) => [last + offset + 1, first - offset - 1])
    .flat().filter((page) => page >= 0 && page < total)
}
async function predecodePage(index: number) {
  const url = await ensurePageUrl(index)
  if (!url || disposed || !inActiveRange(index)) return
  let entry = preloadImages.get(index)
  if (!entry || entry.url !== url) {
    const image = new Image()
    image.src = url
    const ready = image.decode().then(() => {
      if (preloadImages.get(index)?.image === image) recordImageSize(index, image)
    })
    entry = { url, image, ready }
    preloadImages.set(index, entry)
  }
  await entry.ready
}
// Hold decoded neighbors in a bounded window, including both pages of a spread.
function prefetch() {
  for (const page of neighborPages()) {
    void predecodePage(page).catch(() => {})
    ensureSharpened(page)
  }
}

// ---- webtoon virtual window ----
const scrollEl = ref<HTMLElement | null>(null)
const colEl = ref<HTMLElement | null>(null)
let scrollRaf = 0
let jumpGeneration = 0
let ignoreScrollUntil = 0
let pendingAnchor: number | null = null
let resizeObserver: ResizeObserver | null = null
let settleTimer: number | undefined
const WEBTOON_WINDOW_MAX = 10
const WEBTOON_WINDOW_MIN = 2
const IMAGE_MEMORY_BUDGET = 192 * 1024 * 1024
const UNKNOWN_PAGE_BYTES = 12 * 1024 * 1024
const WINDOW_SHIFT_EDGE = 3
const GAP = 4
const DEFAULT_ASPECT = 1.414
const winLo = ref(0)
const winHi = ref(0)
const aspects = ref<number[]>(new Array(total).fill(0))
const decodedBytes = new Array<number>(total).fill(0)
const colW = ref(1000)
const loadedPages = reactive(new Set<number>())
const failedPages = reactive(new Set<number>())
const renderIndices = computed(() => Array.from(
  { length: Math.max(0, winHi.value - winLo.value + 1) },
  (_, offset) => winLo.value + offset,
))

function syncColW() {
  const el = colEl.value
  const width = el ? el.clientWidth || 1000 : colW.value
  if (width === colW.value) return
  colW.value = width
  // 列宽变化 -> 每页高度整体重算, 重建前缀和树
  rebuildHeightIndex()
}
function pageHeight(i: number) {
  return Math.max(80, Math.round(colW.value * (aspects.value[i] || DEFAULT_ASPECT)))
}
// 每页高度前缀和树: 单点更新 O(log n)。窗口上方/下方占位高度改由前缀和/区间和求得,
// 取代原先每次对区间线性累加(O(n)) —— 大书(数千页)下每张图加载不再触发 O(n) 全量重算。
const heightTree = new FenwickTree(total)
const heightVersion = ref(0)
function rebuildHeightIndex() {
  const values = new Float64Array(total)
  for (let i = 0; i < total; i++) values[i] = pageHeight(i)
  heightTree.reset(values)
  heightVersion.value++
}
// 占位高度 = 页高前缀和 + 页间 GAP 数, 与逐页累加语义完全一致(仅复杂度从 O(n) 降到 O(log n))
const topSpacerHeight = computed(() => {
  void heightVersion.value
  const count = Math.min(Math.max(0, winLo.value), total)
  if (!count) return 0
  return heightTree.prefix(count) + GAP * (count - 1)
})
const bottomSpacerHeight = computed(() => {
  void heightVersion.value
  const from = Math.min(Math.max(0, winHi.value + 1), total)
  const count = total - from
  if (count <= 0) return 0
  return heightTree.range(from, total) + GAP * count
})
function pageStyle(i: number) {
  return { height: pageHeight(i) + 'px', width: '100%' }
}
function inActiveRange(i: number) {
  if (readMode.value === 'webtoon') return i >= winLo.value && i <= winHi.value
  return visibleIdx.value.includes(i) || neighborPages().includes(i)
    || pageBuffers.value.some((pages) => pages.some((page) => page.index === i))
}
function gcUrls() {
  urlCache.forEach((_, index) => {
    if (!inActiveRange(index)) releaseUrl(index)
  })
  flushRetiredUrls()
}
function ensureWindowSources() {
  const center = currentIndex.value
  const indices = renderIndices.value.slice().sort((a, b) => Math.abs(a - center) - Math.abs(b - center))
  for (const index of indices) ensurePageUrl(index).catch(() => failedPages.add(index))
}
function updateWindow(center: number) {
  let radius = WEBTOON_WINDOW_MIN
  let used = decodedBytes[center] || UNKNOWN_PAGE_BYTES
  for (let next = 1; next <= WEBTOON_WINDOW_MAX; next++) {
    const before = center - next >= 0 ? (decodedBytes[center - next] || UNKNOWN_PAGE_BYTES) : 0
    const after = center + next < total ? (decodedBytes[center + next] || UNKNOWN_PAGE_BYTES) : 0
    if (next > WEBTOON_WINDOW_MIN && used + before + after > IMAGE_MEMORY_BUDGET) break
    used += before + after
    radius = next
  }
  const { lo: nextLo, hi: nextHi } = webtoonWindow(center, total, radius)
  if (nextLo === winLo.value && nextHi === winHi.value) {
    ensureWindowSources()
    return
  }
  winLo.value = nextLo
  winHi.value = nextHi
  gcUrls()
  ensureWindowSources()
}
function setScrollTop(el: HTMLElement, top: number) {
  // Programmatic jumps must be instant. Smooth scrolling emits a long stream of
  // intermediate events that can be mistaken for user scrolling and move the
  // virtual window away from the requested page.
  ignoreScrollUntil = performance.now() + 120
  el.scrollTop = Math.max(0, top)
}
function targetElement(index: number) {
  return colEl.value?.querySelector<HTMLElement>(`[data-page-index="${index}"]`) || null
}
function alignPageToTop(index: number, generation: number) {
  if (generation !== jumpGeneration) return
  const scroller = scrollEl.value
  const page = targetElement(index)
  if (!scroller || !page) return
  const delta = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  setScrollTop(scroller, scroller.scrollTop + delta)
}
async function jumpToWebtoon(targetIndex: number, _reason: 'initial' | 'jump' | 'mode-switch') {
  const target = Math.min(Math.max(0, targetIndex), Math.max(0, total - 1))
  const generation = ++jumpGeneration
  pendingAnchor = target
  currentIndex.value = target
  cancelSharpenWork()
  updateWindow(target)
  emitProgress()
  await nextTick()
  syncColW()
  rebuildHeightIndex()
  alignPageToTop(target, generation)
  await ensurePageUrl(target).catch(() => {
    failedPages.add(target)
    return ''
  })
  if (generation !== jumpGeneration) return
  await nextTick()
  alignPageToTop(target, generation)
  requestAnimationFrame(() => requestAnimationFrame(() => alignPageToTop(target, generation)))
  clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => alignPageToTop(target, generation), 180)
}
function refreshPageHeight(i: number, nw: number, nh: number, _rw: number) {
  if (!nw || !nh) return
  const nextAspect = nh / nw
  if (Math.abs(nextAspect - aspects.value[i]) < 1e-4) {
    if (pendingAnchor === i) {
      alignPageToTop(i, jumpGeneration)
      pendingAnchor = null
    }
    return
  }
  const oldHeight = pageHeight(i)
  const scroller = scrollEl.value
  const oldTop = targetElement(i)?.getBoundingClientRect().top ?? 0
  aspects.value[i] = nextAspect
  // 单页高度变化 -> 前缀和树单点更新(O(log n)), 并触发占位高度重算
  heightTree.add(i, pageHeight(i) - oldHeight)
  heightVersion.value++
  nextTick(() => {
    if (!scroller) return
    if (pendingAnchor === i) {
      alignPageToTop(i, jumpGeneration)
      pendingAnchor = null
      return
    }
    // A page above the viewport changed height; preserve the current visual content.
    if (oldTop < scroller.getBoundingClientRect().top) {
      setScrollTop(scroller, scroller.scrollTop + pageHeight(i) - oldHeight)
    }
  })
}
function currentPageFromDom() {
  const scroller = scrollEl.value
  if (!scroller) return currentIndex.value
  const top = scroller.getBoundingClientRect().top + 12
  let best = currentIndex.value
  let bestDistance = Number.POSITIVE_INFINITY
  for (const index of renderIndices.value) {
    const page = targetElement(index)
    if (!page) continue
    const rect = page.getBoundingClientRect()
    const distance = rect.top <= top && rect.bottom > top ? 0 : Math.min(Math.abs(rect.top - top), Math.abs(rect.bottom - top))
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}
function computeWebtoonIndex() {
  const index = currentPageFromDom()
  if (index !== currentIndex.value) {
    currentIndex.value = index
    emitProgress()
  }
  if (index - winLo.value <= WINDOW_SHIFT_EDGE || winHi.value - index <= WINDOW_SHIFT_EDGE) updateWindow(index)
}
function onScroll() {
  if (readMode.value !== 'webtoon' || !scrollEl.value) return
  if (performance.now() < ignoreScrollUntil) return
  // A real user scroll cancels the outstanding jump anchor.
  pendingAnchor = null
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    computeWebtoonIndex()
  })
}
function initWebtoon() {
  jumpToWebtoon(currentIndex.value, 'initial')
}
// 滚动模式列宽缩放(替代之前的 zoom/transform 叠加, 布局级缩放滚动天然正确)
function setWebtoonZoom(d: number) {
  const anchor = currentIndex.value
  webtoonScale.value = Math.min(4, Math.max(0.4, Math.round((webtoonScale.value + d) * 10) / 10))
  nextTick(() => {
    syncColW()
    nextTick(() => alignPageToTop(anchor, jumpGeneration))
  })
}

function setBufferImage(slot: number, page: number, el: unknown) {
  if (el) bufferImages[slot].set(page, el as HTMLImageElement)
  else bufferImages[slot].delete(page)
}
async function preparePageSpread() {
  const generation = ++pageGeneration
  const pages = [...visibleIdx.value]
  pageLoading.value = true
  loadingHint.value = false
  clearTimeout(loadingHintTimer)
  loadingHintTimer = window.setTimeout(() => {
    if (generation === pageGeneration && pageLoading.value) loadingHint.value = true
  }, 300)
  pageError.value = ''
  try {
    const frames = await Promise.all(pages.map(async (index) => ({ index, url: await ensurePageUrl(index) })))
    if (disposed || generation !== pageGeneration || readMode.value !== 'page') return
    if (frames.some((page) => !page.url)) throw new Error('无法读取页面，请重新打开漫画。')
    const slot = 1 - activeBuffer.value
    pageBuffers.value = pageBuffers.value.map((buffer, index) => index === slot ? frames : buffer)
    await nextTick()
    if (disposed || generation !== pageGeneration) return
    await Promise.all(frames.map(async (frame) => {
      const image = bufferImages[slot].get(frame.index)
      if (!image) throw new Error('页面尚未就绪，请稍后重试。')
      await image.decode()
      recordImageSize(frame.index, image)
      loadedPages.add(frame.index)
      failedPages.delete(frame.index)
    }))
    if (disposed || generation !== pageGeneration || readMode.value !== 'page') return
    activeBuffer.value = slot
    pageLoading.value = false
    clearTimeout(loadingHintTimer)
    await nextTick()
    if (disposed || generation !== pageGeneration) return
    pageBuffers.value = pageBuffers.value.map((buffer, index) => index === slot ? buffer : [])
    await nextTick()
    gcUrls()
  } catch (cause) {
    if (!disposed && generation === pageGeneration) {
      pageError.value = cause instanceof Error ? cause.message : '此页加载失败，请重新打开漫画。'
      pageLoading.value = false
      clearTimeout(loadingHintTimer)
      pageBuffers.value = pageBuffers.value.map((buffer, index) => index === activeBuffer.value ? buffer : [])
      await nextTick()
      gcUrls()
    }
  }
}
function ensurePageModeSources() {
  if (readMode.value !== 'page') return
  void preparePageSpread()
  prefetch()
  gcUrls()
}

onMounted(() => {
  emitProgress()
  if (readMode.value === 'webtoon') {
    void initWebtoon()
    if (colEl.value && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (readMode.value !== 'webtoon') return
        // 缩放/改窗宽导致整体重排: 把"视口顶附近页"钉在原位, 避免跳转
        const anchor = currentIndex.value
        syncColW()
        nextTick(() => alignPageToTop(anchor, jumpGeneration))
      })
      resizeObserver.observe(colEl.value)
    }
  } else {
    ensurePageModeSources()
    syncPageSharpen()
  }
})
onBeforeUnmount(() => {
  disposed = true
  pageGeneration++
  clearTimeout(loadingHintTimer)
  pageBuffers.value = [[], []]
  jumpGeneration++
  cancelAnimationFrame(scrollRaf)
  clearTimeout(settleTimer)
  resizeObserver?.disconnect()
  cancelSharpenWork()
  releaseAllUrls()
})
watch(mode, clamp)
watch(() => props.comic.spreadOffset, () => {
  if (mode.value === 'double' && readMode.value === 'page') {
    idx.value = alignDouble(currentIndex.value)
    currentIndex.value = idx.value
    ensurePageModeSources()
  }
})
// 开关"跨页自动合并"时重新对齐当前摊(宽页独占/恢复配对)
watch(() => props.comic.autoSpread, () => {
  if (mode.value === 'double' && readMode.value === 'page') {
    idx.value = alignDouble(currentIndex.value)
    currentIndex.value = idx.value
    ensurePageModeSources()
  }
})
watch(() => props.comic.autoCrop, () => {
  sourceGeneration++
  urlPending.clear()
  releaseAllUrls()
  loadedPages.clear()
  if (readMode.value === 'webtoon') updateWindow(currentIndex.value)
  else ensurePageModeSources()
})
watch([visibleIdx, readMode], () => {
  if (readMode.value === 'webtoon') {
    pageGeneration++
    clearTimeout(loadingHintTimer)
    pageBuffers.value = [[], []]
    nextTick(gcUrls)
  } else ensurePageModeSources()
})
watch(
  [readMode, mode, dir, fit, scale, webtoonScale],
  () =>
    emit('ui-state', {
      readMode: readMode.value,
      pageMode: mode.value,
      pageDir: dir.value,
      fit: fit.value,
      zoom: readMode.value === 'webtoon' ? webtoonScale.value : scale.value,
    }),
  { immediate: true },
)
// 锐化开关 / 参数变化 / 翻页 -> 翻页模式同步可见页; 滚动模式按当前视口重算(参数变更需清旧缓存)
// 锐化参数/开关变化: 翻页按可见页同步; 滚动按当前窗口重建(旧参数缓存失效)
watch(
  [() => settings.sharpen, () => settings.sharpenStrength, () => settings.sharpenRadius, () => settings.sharpenThreshold, idx, mode],
  () => {
    if (readMode.value === 'webtoon') {
      sharpCache.forEach((_, k) => revokeSharp(k))
      if (settings.sharpen) {
        for (let i = Math.max(winLo.value, currentIndex.value - 1); i <= Math.min(winHi.value, currentIndex.value + 1); i++) ensureSharpened(i)
      }
    } else {
      syncPageSharpen()
    }
  },
)
// 滚动窗口滑动: 窗口内生成锐化, 窗口外回收, 内存有界
watch([winLo, winHi], () => {
  if (readMode.value !== 'webtoon') return
  if (settings.sharpen) {
    for (let i = Math.max(winLo.value, currentIndex.value - 1); i <= Math.min(winHi.value, currentIndex.value + 1); i++) ensureSharpened(i)
  }
  sharpCache.forEach((_, k) => {
    if (Math.abs(k - currentIndex.value) > 1) revokeSharp(k)
  })
})
async function capturePage(pageIndex: number, signal: AbortSignal, region?: TranslationRect) {
  throwIfAborted(signal)
  const url = await ensurePageUrl(pageIndex)
  throwIfAborted(signal)
  if (!url) throw new Error('页面尚未就绪，请稍后重试。')
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('无法读取此页图像，请重新打开漫画。')
  return frameFromBlob(await response.blob(), signal, region)
}
function visiblePages() {
  if (readMode.value !== 'webtoon') return [...visibleIdx.value]
  return [currentIndex.value]
}
defineExpose({ next, prev, goTo, zoom, toggleReadMode, setMode, setDir, cycleFit, capturePage, visiblePages })
</script>

<template>
  <div
    class="relative h-full w-full overflow-hidden bg-[color:var(--stage)]"
    @touchstart.passive="onTouchStart"
    @touchmove="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel.passive="onTouchEnd"
  >
    <!-- 翻页模式 (单页 / 双页) -->
    <div
      v-if="readMode !== 'webtoon'"
      class="relative h-full w-full overflow-hidden"
      :aria-busy="pageLoading"
    >
      <div
        v-for="(buffer, slot) in pageBuffers"
        :key="slot"
        :data-page-buffer="slot"
        :data-active="slot === activeBuffer"
        :aria-hidden="slot !== activeBuffer"
        class="grid h-full w-full place-items-center p-4"
        :class="slot === activeBuffer ? 'relative' : 'absolute inset-0 invisible pointer-events-none'"
      >
      <div
        class="flex max-h-full max-w-full items-center justify-center gap-1 select-none"
        :class="dragging ? 'cursor-grabbing' : scale > 1 ? 'cursor-grab' : ''"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointerleave="onUp"
      >
        <!-- Keep the previous spread mounted until every incoming image is decoded. -->
        <div
          v-for="page in buffer"
          :key="`${page.index}:${page.url}`"
          :data-page-index="page.index"
          class="relative border border-white/10 shadow-2xl"
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotation}deg)`, transition: dragging ? 'none' : 'transform .25s cubic-bezier(.16,1,.3,1)' }"
        >
          <img
            :ref="(el: any) => setBufferImage(slot, page.index, el)"
            :src="page.url"
            decoding="sync"
            @load="onImgLoad(page.index, $event)"
            @error="onImgError(page.index)"
            :class="`${fitClass} block`"
            draggable="false"
            alt=""
          />
          <img
            v-if="settings.sharpen && sharpCache.has(page.index)"
            :src="sharpCache.get(page.index)"
            decoding="async"
            class="absolute inset-0 block sharpen-fade"
            :class="fitClass"
            draggable="false"
            alt=""
          />
          <TranslationLayer v-if="slot === activeBuffer && !pageLoading && visibleIdx.includes(page.index)" :page-index="page.index" :state="translation" :rotation="rotation" @select="emit('translation-select', $event)" @region="emit('translation-region', $event)" />
        </div>
      </div>
      </div>
      <div v-if="pageLoading && !pageBuffers[activeBuffer]?.length" class="absolute inset-0 grid place-items-center text-sm text-white/70" role="status">正在加载页面…</div>
      <div v-else-if="pageLoading && loadingHint" class="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-[color:var(--surface-1)] px-3 py-2 text-sm text-[color:var(--text)]" role="status">正在加载页面…</div>
      <div v-if="pageError" class="absolute inset-x-4 bottom-4 z-10 rounded-lg bg-[color:var(--surface-1)] p-3 text-center text-sm text-[color:var(--text)]" role="alert">{{ pageError }}</div>
    </div>

    <!-- Webtoon 滚动模式: 滑动窗口, 仅渲染当前页±10的 img, 其余用占位维持滚动 -->
    <div
      v-else
      ref="scrollEl"
      class="webtoon-scroll h-full w-full"
      @scroll="onScroll"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointerleave="onUp"
    >
      <!-- #5: 滚动模式支持缩放(列宽布局级缩放, 滚动天然正确) -->
      <div
        ref="colEl"
        class="mx-auto flex flex-col items-center gap-1 px-2 py-2"
        :style="webtoonColStyle"
      >
        <div aria-hidden="true" class="shrink-0" :style="{ height: `${topSpacerHeight}px` }" />
        <div
          v-for="i in renderIndices"
          :key="i"
          :data-page-index="i"
          class="webtoon-page relative shrink-0 overflow-hidden"
          :style="pageStyle(i)"
        >
          <div
            v-if="!urlFor(i) && !failedPages.has(i)"
            class="absolute inset-0 animate-pulse bg-white/5"
            aria-label="页面加载中"
          />
          <div
            v-else-if="failedPages.has(i)"
            class="absolute inset-0 grid place-items-center text-sm text-white/60"
            role="status"
          >
            此页加载失败
          </div>
          <div v-else class="relative h-full w-full" :style="{ transform: `rotate(${rotation}deg)` }">
          <img
            :src="urlFor(i)"
            decoding="async"
            class="webtoon-img h-full w-full object-contain border border-white/10 shadow-lg"
            @load="onImgLoad(i, $event)"
            @error="onImgError(i)"
            draggable="false"
            alt=""
          />
          <img
            v-if="settings.sharpen && sharpCache.has(i)"
            :src="sharpCache.get(i)"
            decoding="async"
            class="webtoon-img absolute inset-0 h-full w-full object-contain border border-white/10 shadow-lg sharpen-fade"
            draggable="false"
            alt=""
          />
          <TranslationLayer v-if="loadedPages.has(i)" :page-index="i" :state="translation" :rotation="rotation" @select="emit('translation-select', $event)" @region="emit('translation-region', $event)" />
          </div>
        </div>
        <div aria-hidden="true" class="shrink-0" :style="{ height: `${bottomSpacerHeight}px` }" />
      </div>
    </div>

  </div>
</template>
