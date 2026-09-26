<script setup lang="ts">
import { readBrowserPage } from '../../services/browserPageCache'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Comic, ReaderFile, ReaderUiState } from '../../types'
import { readFile } from '@tauri-apps/plugin-fs'
import { useLibrary } from '../../stores/library'
import { useReadingSettings } from '../../stores/settings'
import { sharpenImageData } from '../../utils/sharpen'
import { FenwickTree } from '../../utils/readerState'
import Icon from '../Icon.vue'
import TranslationLayer from '../TranslationLayer.vue'
import type { TranslationActivation, TranslationLayerState, TranslationRect, TranslationSelection } from '../../types/translation'
import { encodeTranslationFrame, throwIfAborted } from '../../utils/translationImage'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const settings = useReadingSettings()

const props = defineProps<{ comic: Comic; files: ReaderFile[]; initialPage?: number | null; translation?: TranslationLayerState }>()
const emit = defineEmits<{
  (e: 'progress', p: { position: number; total: number }): void
  (e: 'ui-state', state: ReaderUiState): void
  (e: 'translation-select', value: TranslationActivation): void
  (e: 'translation-region', value: TranslationSelection): void
}>()
const lib = useLibrary()

const root = ref<HTMLDivElement>()
const wrap = ref<HTMLDivElement>()
const canvasL = ref<HTMLCanvasElement>()
const canvasR = ref<HTMLCanvasElement>()
const displayedPages = reactive(new Map<number, number>())
watch([canvasL, canvasR], (canvases, previous) => {
  canvases.forEach((canvas, slot) => { if (canvas !== previous[slot]) displayedPages.delete(slot) })
})
// 离屏缓冲 canvas: 先把整页渲染到离屏, 完成后再一次性拷到可见 canvas。
// 这样翻页时旧页始终可见, 直到新页渲染完毕瞬间整页替换, 杜绝"清屏闪白 / 渐进绘制"的闪烁。
const webtoonEl = ref<HTMLElement | null>(null)
const total = ref(0)
// 初始页: 从书签进入时携带 initialPage, 否则用上次阅读进度 lastPosition(total 在 loadPdf 时才确定, 此处暂不钳制)
const startIndex = props.initialPage && props.initialPage >= 1 ? Math.max(0, props.initialPage - 1) : (props.comic.lastPosition || 1) - 1
const idx = ref(Math.max(0, startIndex))
const readMode = ref<'page' | 'webtoon'>(props.comic.readMode ?? 'page')
const mode = ref<'single' | 'double'>(props.comic.pageMode ?? 'single')
const dir = ref<'ltr' | 'rtl'>(props.comic.pageDir ?? 'rtl')
// 适应模式(翻页): 宽度(默认) / 高度 / 原大
const fit = ref<'width' | 'height' | 'actual'>(props.comic.fit ?? 'width')
const rotation = computed(() => props.comic.rotation || 0)
const spreadOffset = computed(() => props.comic.spreadOffset || 0)
function alignDouble(index: number) {
  if (spreadOffset.value === 1) return index <= 0 ? 0 : Math.floor((index - 1) / 2) * 2 + 1
  return Math.floor(index / 2) * 2
}
const FIT_ORDER = ['width', 'height', 'actual'] as const
function cycleFit() {
  const i = FIT_ORDER.indexOf(fit.value)
  fit.value = FIT_ORDER[(i + 1) % FIT_ORDER.length]
  lib.setFitMode(props.comic.id, fit.value)
  clearPageCache() // 适应模式变化 -> 缓存的位图尺寸失效
  if (readMode.value !== 'webtoon') renderSpreadFade()
}
const currentIndex = ref(idx.value) // 当前页(进度); page 模式=idx, webtoon 由滚动推导
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const loading = ref(true)
const error = ref('')
let doc: any = null

// webtoon 相关
const pageRefs = ref<(HTMLCanvasElement | null)[]>([])
const rendered = reactive(new Set<number>())
const loadingPage = reactive(new Set<number>())
let io: IntersectionObserver | null = null
let webtoonGeneration = 0
const webtoonTasks = new Map<number, any>()
function cancelWebtoonRenders() {
  webtoonGeneration++
  for (const task of webtoonTasks.values()) {
    try { task.cancel() } catch { /* already complete */ }
  }
  webtoonTasks.clear()
  loadingPage.clear()
}
let scrollRaf = 0
let zoomTimer: number | undefined
// 程序化设置 scrollTop 时, 在短时间窗内忽略随之而来的 scroll 事件, 避免 onScroll 误判为手动滚动。
// 用"时间窗"而非计数器: 浏览器对"设置成相同的 scrollTop"不会触发 scroll 事件, 若用计数器会只增不减,
// 把之后用户的真实滚动一并吞掉(表现为滚动间歇失灵)。时间窗可自愈, 不会累积。
let ignoreScrollUntil = 0
let pendingAnchor: number | null = null
function setScrollTop(el: HTMLElement, top: number) {
  ignoreScrollUntil = performance.now() + 120
  el.scrollTop = Math.max(0, top)
}
// 渲染窗口: 仅保留视口附近 ±WEBTOON_KEEP 页的位图, 其余回收, 避免长 PDF 全本位图常驻内存
const WEBTOON_KEEP = 6
// #3: DOM 虚拟化 —— 仅挂载视口附近 ±RENDER_K 的 <canvas> 节点, 其余页面用占位高度空 div,
// 避免超长 PDF 一次性创建上万 <canvas>(位图已受 WEBTOON_KEEP 回收, 这里再压 DOM 数量)
// RENDER_K 与 WEBTOON_KEEP 保持一致, 让 canvas 挂载窗口 = 位图保留窗口, 避免回窗时空白。
const RENDER_K = WEBTOON_KEEP
const PDF_WEBTOON_BUDGET = 128 * 1024 * 1024
const PDF_UNKNOWN_PAGE_BYTES = 8 * 1024 * 1024
const pdfCanvasBytes = new Map<number, number>()
const renderLo = ref(0)
const renderHi = ref(0)
// 已渲染页真实高度(供窗口外占位, 维持滚动条比例与连续滚动); 未渲染用估算高度
const pageH = reactive(new Map<number, number>())
const estimatedH = ref(1400)
// 已渲染页高度之和/计数 的前缀和树(Fenwick): 单点更新 O(log n)。
//   区间占位高度 = Σ(已渲染页真实高度) + 未渲染页数 × estimatedH
// 于是 estimatedH 全局变化无需重建(只影响"未渲染页数 × estimatedH"一项), 树仅在单页渲染完成时增量更新。
// 取代原先每次对区间线性累加(O(n)), 长 PDF 滚动/渲染不再触发 O(n) 重算。
let heightSumTree = new FenwickTree(0)
let heightCntTree = new FenwickTree(0)
const heightVersion = ref(0)
function resetHeightIndex(pageCount: number) {
  heightSumTree = new FenwickTree(pageCount)
  heightCntTree = new FenwickTree(pageCount)
  heightVersion.value++
}
function recordPageHeight(i: number, h: number) {
  const prev = pageH.get(i)
  if (prev === undefined) {
    heightSumTree.add(i, h)
    heightCntTree.add(i, 1)
  } else {
    heightSumTree.add(i, h - prev)
  }
  pageH.set(i, h)
  heightVersion.value++
}
function pageStyle(i: number) {
  const h = pageH.get(i)
  return { minHeight: (h ?? estimatedH.value) + 'px' }
}
function virtualHeight(from: number, to: number) {
  void heightVersion.value
  const lo = Math.min(Math.max(0, from), total.value)
  const hi = Math.min(Math.max(0, to), total.value)
  if (hi <= lo) return 0
  const knownCnt = heightCntTree.range(lo, hi)
  return heightSumTree.range(lo, hi) + (hi - lo - knownCnt) * estimatedH.value
}
const renderIndices = computed(() => {
  if (!total.value || renderHi.value < renderLo.value) return []
  return Array.from({ length: renderHi.value - renderLo.value + 1 }, (_, i) => renderLo.value + i)
})
const topSpacerHeight = computed(() => virtualHeight(0, renderLo.value))
const bottomSpacerHeight = computed(() => virtualHeight(renderHi.value + 1, total.value))
function updateRenderWindow(center: number) {
  const t = total.value || 0
  let used = pdfCanvasBytes.get(center) || PDF_UNKNOWN_PAGE_BYTES
  let radius = 0
  for (let next = 1; next <= RENDER_K; next++) {
    const before = center - next >= 0 ? (pdfCanvasBytes.get(center - next) || PDF_UNKNOWN_PAGE_BYTES) : 0
    const after = center + next < t ? (pdfCanvasBytes.get(center + next) || PDF_UNKNOWN_PAGE_BYTES) : 0
    if (next > 2 && used + before + after > PDF_WEBTOON_BUDGET) break
    used += before + after
    radius = next
  }
  radius = Math.max(2, radius)
  renderLo.value = Math.max(0, center - radius)
  renderHi.value = Math.min(t - 1, center + radius)
}
const dragging = ref(false)
let sx = 0
let sy = 0
let stx = 0
let sty = 0
let sType = ''
// 翻页模式: 防止 resize/调速时竞态渲染
let spreadToken = 0
let spreadAbort = new AbortController()
let prefetchAbort = new AbortController()

// 邻页预解码缓存: 翻完当前跨页后后台渲染下一跨页到离屏 canvas, 命中缓存时直接 drawImage,
// 跳过最慢的 JBIG2 解码 -> 翻页更跟手。缓存以布局(layoutKey)为版本号, 布局变化时整体失效。
const pageCache = new Map<number, { canvas: HTMLCanvasElement; key: string; dprVp: any; dpr: number; bytes: number }>()
const PAGE_CACHE_BUDGET = 128 * 1024 * 1024
let prefetchToken = 0
function layoutKey() {
  const dpr = window.devicePixelRatio || 1
  const w = wrap.value?.clientWidth || 0
  const h = wrap.value?.clientHeight || 0
  return [
    fit.value,
    mode.value,
    Math.round(w) + 'x' + Math.round(h),
    dpr,
    settings.sharpen,
    settings.sharpenStrength,
    settings.sharpenRadius,
    settings.sharpenThreshold,
  ].join('|')
}
function evictCache() {
  let bytes = 0
  for (const entry of pageCache.values()) bytes += entry.bytes
  while (bytes > PAGE_CACHE_BUDGET && pageCache.size > 1) {
    const oldest = pageCache.keys().next().value as number
    const entry = pageCache.get(oldest)
    if (!entry) break
    bytes -= entry.bytes
    entry.canvas.width = 0
    entry.canvas.height = 0
    pageCache.delete(oldest)
  }
}
function clearPageCache() {
  spreadAbort.abort(); prefetchAbort.abort(); prefetchToken++
  for (const entry of pageCache.values()) {
    entry.canvas.width = 0
    entry.canvas.height = 0
  }
  pageCache.clear()
}

const position = computed(() => currentIndex.value + 1)

function emitProgress() {
  emit('progress', { position: position.value, total: total.value })
}

function setPageRef(i: number, el: any) {
  pageRefs.value[i] = el ? (el as HTMLCanvasElement) : null
}

async function loadPdf() {
  try {
    const source = props.files[0]
    const sourceInput = source.kind === 'native-resource'
      ? { url: source.documentUrl || source.url }
      : source.kind === 'file'
        ? { data: await source.file.arrayBuffer() }
        : source.kind === 'native-path'
          ? { data: (await readFile(source.path)).buffer }
          : { data: await (source.kind === 'cached-page' ? await readBrowserPage(source.comicId, source.pageIndex) : await source.handle.getFile()).arrayBuffer() }
    // wasmUrl / cMapUrl 指向随构建发布的 pdfjs 解码资源(public_root/pdfjs/)。
    // 关键: 漫画 PDF 常用 JBIG2 压缩, pdfjs 默认不带解码器, 不提供 wasmUrl 会
    // "JBig2 failed to initialize" 并静默丢弃图像 XObject -> 页面空白(渲染异常)。
    const assetBase = import.meta.env.BASE_URL
    doc = await pdfjsLib.getDocument({
      ...sourceInput,
      wasmUrl: assetBase + 'pdfjs/wasm/',
      cMapUrl: assetBase + 'pdfjs/cmaps/',
      cMapPacked: true,
    }).promise
    total.value = doc.numPages
    resetHeightIndex(doc.numPages)
    // 初始页优先用书签携带的 initialPage, 否则用上次阅读进度 lastPosition
    const startPage = props.initialPage && props.initialPage >= 1 ? props.initialPage : (props.comic.lastPosition || 1)
    idx.value = Math.min(Math.max(0, startPage - 1), total.value - 1)
    currentIndex.value = idx.value
    loading.value = false
    await nextTick()
    await nextTick()
    if (readMode.value === 'webtoon') initWebtoon()
    else await renderSpread()
    emitProgress()
  } catch (e: any) {
    error.value = 'PDF 解析失败：' + (e?.message || e)
    loading.value = false
  }
}

// ---- 翻页模式: 渲染当前跨页(单/双页) ----
async function renderSpread() {
  if (!doc) return
  const my = ++spreadToken
  spreadAbort.abort(); prefetchAbort.abort()
  const control = new AbortController(); spreadAbort = control
  // Layout changes can create or remove the second canvas even when wrap exists.
  await nextTick()
  if (!wrap.value || my !== spreadToken) return
  const pages =
    mode.value === 'double' && spreadOffset.value === 1 && idx.value === 0
      ? [0]
      : mode.value === 'double'
      ? [idx.value, idx.value + 1].filter((p) => p < total.value)
      : [idx.value]
  const cvs = [canvasL.value, canvasR.value]
  cvs.forEach((c, i) => {
    if (c) c.style.display = i < pages.length ? '' : 'none'
  })
  for (let k = 0; k < pages.length; k++) {
    if (my !== spreadToken) return // 已被新的渲染取代
    try { await renderPageTo(cvs[k]!, pages[k], my, control.signal) }
    catch (cause) { if (!control.signal.aborted) error.value = cause instanceof Error ? cause.message : '页面渲染失败'; return }
  }
}
async function renderSpreadFade() {
  await renderSpread()
  schedulePrefetch()
}
// 渲染整页到「基础分辨率(base, dpr=1)」离屏位图并锐化, 返回该位图与 dpr 缩放后的视口。
// 性能关键: USM 锐化只在 base 分辨率运行(像素数约为 dpr 缩放版的 1/dpr², 2x 屏省 ~75% 算力),
// 可见 canvas 再用 drawImage 一次性放大到 dpr 尺寸(浏览器硬件平滑, 几乎零成本)。
// 注意: b 为复用离屏 canvas(bufL/bufR), 调用方须顺序 await, 不可并发渲染到同一 b。
async function renderPageBitmap(page: any, b: HTMLCanvasElement, signal: AbortSignal): Promise<{ canvas: HTMLCanvasElement; dprVp: any; dpr: number }> {
  throwIfAborted(signal)
  const base = page.getViewport({ scale: 1 })
  let fitScale: number
  if (fit.value === 'height') {
    const availH = (wrap.value?.clientHeight || 800) - 32
    fitScale = Math.max(0.1, availH / base.height)
  } else if (fit.value === 'actual') {
    fitScale = 1
  } else {
    const avail = (wrap.value?.clientWidth || 800) - 32
    const perPage = mode.value === 'double' ? (avail - 4) / 2 : avail
    fitScale = Math.max(0.1, perPage / base.width)
  }
  const baseVp = page.getViewport({ scale: Math.min(fitScale, Math.sqrt(12_000_000 / (base.width * base.height))) })
  const pixelCapDpr = Math.sqrt(12_000_000 / Math.max(1, base.width * base.height * fitScale * fitScale))
  const dpr = Math.min(window.devicePixelRatio || 1, pixelCapDpr)
  const dprVp = page.getViewport({ scale: fitScale * dpr })
  b.width = baseVp.width
  b.height = baseVp.height
  const task = page.render({ canvasContext: b.getContext('2d')!, viewport: baseVp })
  const abort = () => task.cancel()
  signal.addEventListener('abort', abort, { once: true })
  try { await task.promise; throwIfAborted(signal) }
  finally { signal.removeEventListener('abort', abort) }
  await applySharpenIfNeeded(b)
  throwIfAborted(signal)
  return { canvas: b, dprVp, dpr }
}
async function renderPageTo(cv: HTMLCanvasElement, pageNum: number, token: number, signal: AbortSignal) {
  if (!doc) return
  const key = layoutKey()
  // 命中预解码缓存: 直接把缓存的 base 位图放大到可见 canvas, 跳过最慢的 JBIG2 解码 (翻页跟手)
  const cached = pageCache.get(pageNum)
  if (cached && cached.key === key) {
    if (token !== spreadToken) return
    pageCache.delete(pageNum)
    pageCache.set(pageNum, cached)
    const dp = cached.dprVp
    cv.width = dp.width
    cv.height = dp.height
    cv.style.width = dp.width / cached.dpr + 'px'
    cv.style.height = dp.height / cached.dpr + 'px'
    cv.getContext('2d')!.drawImage(cached.canvas, 0, 0, dp.width, dp.height)
    displayedPages.set(cv === canvasL.value ? 0 : 1, pageNum)
    return
  }
  const page = await doc.getPage(pageNum + 1)
  throwIfAborted(signal)
  const buf = document.createElement('canvas')
  try {
  const { canvas: base, dprVp, dpr } = await renderPageBitmap(page, buf, signal)
  if (token !== spreadToken) return
  // 离屏 base 位图 -> 可见 canvas: 放大到 dpr 尺寸, 与旧页瞬时替换, 无空白闪烁
  cv.width = dprVp.width
  cv.height = dprVp.height
  cv.style.width = dprVp.width / dpr + 'px'
  cv.style.height = dprVp.height / dpr + 'px'
  cv.getContext('2d')!.drawImage(base, 0, 0, dprVp.width, dprVp.height)
  displayedPages.set(cv === canvasL.value ? 0 : 1, pageNum)
  // 写入缓存: 另存一份 base 分辨率副本(已含锐化), 供后续翻页命中
  const cc = document.createElement('canvas')
  cc.width = base.width
  cc.height = base.height
  cc.getContext('2d')!.drawImage(base, 0, 0)
  pageCache.set(pageNum, { canvas: cc, key, dprVp, dpr, bytes: cc.width * cc.height * 4 })
  evictCache()
  } finally { buf.width = 0; buf.height = 0 }
}
// 后台预解码下一跨页: 布局变化时 prefetchToken 自增使旧任务作废, 避免把过期布局写入缓存
function schedulePrefetch() {
  if (readMode.value === 'webtoon' || !doc || !wrap.value) return
  const step = mode.value === 'double' ? 2 : 1
  const nextIdx = idx.value + step
  if (nextIdx >= total.value) return
  const pages = mode.value === 'double' ? [nextIdx, nextIdx + 1].filter((p) => p < total.value) : [nextIdx]
  const my = ++prefetchToken
  prefetchAbort.abort()
  const control = new AbortController(); prefetchAbort = control
  const key = layoutKey()
  void (async () => {
    for (const p of pages) {
      if (my !== prefetchToken || control.signal.aborted) return
      if (pageCache.has(p) && pageCache.get(p)!.key === key) continue
      try {
        const page = await doc.getPage(p + 1)
        throwIfAborted(control.signal)
        const c = document.createElement('canvas')
        try {
        const { canvas, dprVp, dpr } = await renderPageBitmap(page, c, control.signal)
        if (my !== prefetchToken || control.signal.aborted) return
        pageCache.set(p, { canvas, key, dprVp, dpr, bytes: canvas.width * canvas.height * 4 })
        evictCache()
        } finally { if (pageCache.get(p)?.canvas !== c) { c.width = 0; c.height = 0 } }
      } catch {
        /* skip */
      }
    }
  })()
}
/** pdf.js 直接渲染到 canvas: 锐化只需对位图做 USM, 零额外解码开销(走 Worker, 不卡主线程) */
async function applySharpenIfNeeded(cv: HTMLCanvasElement) {
  if (!settings.sharpen || cv.width === 0 || cv.height === 0) return
  const ctx = cv.getContext('2d')!
  const img = ctx.getImageData(0, 0, cv.width, cv.height)
  const out = await sharpenImageData(img, {
    radius: settings.sharpenRadius,
    strength: settings.sharpenStrength,
    threshold: settings.sharpenThreshold,
  })
  ctx.putImageData(out, 0, 0)
}

// ---- webtoon 模式: 渲染指定页到对应 canvas (懒渲染) ----
async function renderPage(n: number) {
  if (!doc || !pageRefs.value[n] || rendered.has(n) || loadingPage.has(n)) return
  const cv = pageRefs.value[n]!
  const generation = webtoonGeneration
  loadingPage.add(n)
  try {
    const page = await doc.getPage(n + 1)
    const base = page.getViewport({ scale: 1 })
    const avail = (webtoonEl.value?.clientWidth || 800) - 16
    const fit = Math.max(0.1, (avail * scale.value) / base.width)
    const cssViewport = page.getViewport({ scale: fit })
    const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(12_000_000 / Math.max(1, cssViewport.width * cssViewport.height)))
    const vp = page.getViewport({ scale: fit * dpr })
    cv.width = vp.width
    cv.height = vp.height
    cv.style.width = vp.width / dpr + 'px'
    cv.style.height = vp.height / dpr + 'px'
    recordPageHeight(n, vp.height / dpr) // 记录真实高度供窗口外占位, 避免滚动跳动
    pdfCanvasBytes.set(n, cv.width * cv.height * 4)
    updateRenderWindow(currentIndex.value)
    refreshEstimatedH()
    if (pendingAnchor === n) placeAnchor()
    const ctx = cv.getContext('2d')!
    const task = page.render({ canvasContext: ctx, viewport: vp })
    webtoonTasks.set(n, task)
    await task.promise
    if (generation !== webtoonGeneration || pageRefs.value[n] !== cv) return
    await applySharpenIfNeeded(cv)
    if (generation !== webtoonGeneration || pageRefs.value[n] !== cv) return
    rendered.add(n)
  } catch {
    /* cancelled or failed */
  } finally {
    webtoonTasks.delete(n)
    loadingPage.delete(n)
  }
}

function rerenderVisible() {
  const el = webtoonEl.value
  if (!el) return
  // 虚拟化后, 重渲染"渲染窗口"而非仅可见区, 否则窗口内但视口外的页在缩放/改参数后会变空白
  cancelWebtoonRenders()
  rendered.clear()
  nextTick(() => {
    for (let i = renderLo.value; i <= renderHi.value; i++) {
      if (pageRefs.value[i]) renderPage(i)
    }
  })
}

// ---- 导航(双模式统一出口) ----
function next() {
  if (readMode.value === 'webtoon') {
    webtoonEl.value?.scrollBy({ top: webtoonEl.value.clientHeight * 0.9, behavior: 'smooth' })
    return
  }
  const step = mode.value === 'double' ? 2 : 1
  if (idx.value < total.value - 1) {
    idx.value = mode.value === 'double' && spreadOffset.value === 1 && idx.value === 0 ? Math.min(1, total.value - 1) : Math.min(idx.value + step, total.value - 1)
    currentIndex.value = idx.value
    tx.value = 0
    ty.value = 0
    renderSpreadFade()
    emitProgress()
  }
}
function prev() {
  if (readMode.value === 'webtoon') {
    webtoonEl.value?.scrollBy({ top: -webtoonEl.value.clientHeight * 0.9, behavior: 'smooth' })
    return
  }
  const step = mode.value === 'double' ? 2 : 1
  if (idx.value > 0) {
    idx.value = mode.value === 'double' && spreadOffset.value === 1 && idx.value <= 1 ? 0 : Math.max(idx.value - step, 0)
    currentIndex.value = idx.value
    tx.value = 0
    ty.value = 0
    renderSpreadFade()
    emitProgress()
  }
}
function goTo(n: number) {
  const i = Math.min(Math.max(0, n - 1), total.value - 1)
  if (readMode.value === 'webtoon') {
    // 目标页可能很远, 上游大量页未渲染(用 estimatedH 占位), 直接用 offsetTop 会跳飞。
    // 改为: 把目标页 i 纳入渲染窗口并强制渲染, 等其真实高度就绪后 placeAnchor 用真实尺寸定位并显示;
    // 定位期间隐藏容器, 杜绝"从第一页滚下来"。estimatedH 同步用窗口内真实页均值刷新, 让上游占位更准。
    cancelWebtoonRenders()
    currentIndex.value = i
    updateRenderWindow(i)
    pendingAnchor = i
    rendered.delete(i)
    emitProgress()
    nextTick(() => {
      for (let k = renderLo.value; k <= renderHi.value; k++) {
        if (pageRefs.value[k]) renderPage(k)
      }
      const el = webtoonEl.value
      if (el) {
        const p = el.querySelector<HTMLElement>(`.webtoon-page[data-i="${i}"]`)
        if (p) setScrollTop(el, p.offsetTop)
      }
    })
  } else {
    cancelWebtoonRenders()
    idx.value = mode.value === 'double' ? alignDouble(i) : i
    currentIndex.value = i
    tx.value = 0
    ty.value = 0
    renderSpreadFade()
    emitProgress()
  }
}
function resetZoom() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}
function zoom(d: number) {
  scale.value = Math.min(4, Math.max(0.4, Math.round((scale.value + d) * 10) / 10))
  if (readMode.value === 'webtoon') {
    // 缩放步进去抖: 快速连按时只末次重渲染, 避免反复全量重渲+USM 卡顿
    clearTimeout(zoomTimer)
    zoomTimer = window.setTimeout(() => {
      rendered.clear()
      rerenderVisible()
    }, 120)
  } else if (scale.value === 1) {
    tx.value = 0
    ty.value = 0
  }
}
function toggleReadMode() {
  const nextMode = readMode.value === 'webtoon' ? 'page' : 'webtoon'
  readMode.value = nextMode
  lib.setReadMode(props.comic.id, nextMode)
  if (nextMode === 'webtoon') {
    currentIndex.value = idx.value
    resetZoom()
    nextTick(initWebtoon)
  } else {
    cancelWebtoonRenders()
    io?.disconnect()
    io = null
    clearPageCache() // 切回翻页模式, 旧的 webtoon 视口与缓存无关, 整体清掉
    idx.value = mode.value === 'double' ? alignDouble(currentIndex.value) : currentIndex.value
    currentIndex.value = idx.value
    resetZoom()
    nextTick(renderSpreadFade)
    emitProgress()
  }
}
function setMode(target: 'single' | 'double') {
  if (mode.value === target) return
  const wasLeft = idx.value
  mode.value = target
  idx.value = target === 'double' ? alignDouble(wasLeft) : wasLeft
  currentIndex.value = idx.value
  lib.setPageMode(props.comic.id, mode.value)
  clearPageCache() // 单/双页切换 -> 每页视口尺寸变化, 缓存失效
  renderSpreadFade()
  emitProgress()
}
function setDir(target: 'ltr' | 'rtl') {
  if (dir.value === target) return
  dir.value = target
  lib.setPageDir(props.comic.id, dir.value)
}

// ---- pan (paged, zoomed) + 滑动手势 (仅触屏/笔) ----
function onDown(e: PointerEvent) {
  if (pinchActive) return
  sx = e.clientX
  sy = e.clientY
  stx = tx.value
  sty = ty.value
  sType = e.pointerType
  if (scale.value > 1) {
    dragging.value = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
}
function onMove(e: PointerEvent) {
  if (!dragging.value || pinchActive) return
  tx.value = stx + e.clientX - sx
  ty.value = sty + e.clientY - sy
}
function onUp(e?: PointerEvent) {
  if (dragging.value) {
    dragging.value = false
    return
  }
  if (!e) return
  // 仅触屏/笔设备允许横向滑动翻页; 鼠标拖拽一律不触发, 避免桌面端误触翻页
  if (sType !== 'touch' && sType !== 'pen') return
  // 翻页模式滑动手势: 水平位移超阈值且明显大于垂直 -> 翻页(左滑下一页, 右滑上一页)
  const dx = e.clientX - sx
  const dy = e.clientY - sy
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (dx < 0) next()
    else prev()
  }
}

// ---- 双指缩放 (触屏捏合, 翻页模式) ----
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
  // 滚动模式交给原生滚动(列宽重排需重渲染, 成本高), 仅翻页模式做捏合缩放
  if (!pinchActive || readMode.value === 'webtoon' || e.touches.length !== 2 || !pinchDist) return
  e.preventDefault()
  const span = pinchSpan(e.touches)
  if (!span) return
  const factor = span / pinchDist
  pinchDist = span
  scale.value = clampScale(scale.value * factor)
  if (scale.value === 1) {
    tx.value = 0
    ty.value = 0
  }
}
function onTouchEnd(e: TouchEvent) {
  if (e.touches.length < 2) {
    pinchActive = false
    pinchDist = 0
  }
}

// ---- webtoon scroll tracking ----
function computeWebtoonIndex() {
  const el = webtoonEl.value
  if (!el) return
  const probe = el.scrollTop + el.clientHeight * 0.35
  const pages = el.querySelectorAll<HTMLElement>('.webtoon-page')
  let i = renderLo.value
  for (let k = 0; k < pages.length; k++) {
    if (pages[k].offsetTop <= probe) i = Number(pages[k].dataset.i)
    else break
  }
  currentIndex.value = i
  updateRenderWindow(i)
  emitProgress()
}
function onScroll() {
  if (readMode.value !== 'webtoon' || !webtoonEl.value) return
  if (performance.now() < ignoreScrollUntil) return // 吞掉程序化滚动, 不视为用户操作
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    computeWebtoonIndex()
    evictFarPages()
  })
}

// 回收离当前页超过 ±WEBTOON_KEEP 的已渲染 canvas (清空位图, 保留占位高度)
function evictFarPages() {
  const center = currentIndex.value
  for (const i of Array.from(rendered)) {
    if (Math.abs(i - center) > WEBTOON_KEEP) {
      const cv = pageRefs.value[i]
      if (cv) {
        cv.width = 0
        cv.height = 0
      }
      rendered.delete(i)
    }
  }
}
// 用渲染窗口内已渲染页的真实高度刷新"占位估算高度", 让尚未渲染的上游页占位更接近真实,
// 跳转远页时目标页的 offsetTop 因此更准(不再用固定 1400 估算飞掉)。
// 注意: 只遍历渲染窗口(±几页)而非整张 pageH, 避免随已渲染页增多退化为 O(n)。
function refreshEstimatedH() {
  let sum = 0, n = 0
  const lo = Math.max(0, renderLo.value - 1)
  const hi = Math.min(total.value - 1, renderHi.value + 1)
  for (let k = lo; k <= hi; k++) {
    const h = pageH.get(k)
    if (h) { sum += h; n++ }
  }
  if (n) estimatedH.value = Math.round(sum / n)
}
// 等目标页真实高度就绪后, 用其真实 offsetTop 精确定位并显示容器(隐藏期间完成, 杜绝从第一页滚)。
async function placeAnchor() {
  const el = webtoonEl.value
  if (!el || pendingAnchor == null) return
  await nextTick() // 等 estimatedH 更新后占位高度重排, 否则读到的 offsetTop 基于旧占位
  const p = el.querySelector<HTMLElement>(`.webtoon-page[data-i="${pendingAnchor}"]`)
  if (p) setScrollTop(el, p.offsetTop)
  pendingAnchor = null
}
function observeRenderedPages() {
  const el = webtoonEl.value
  if (!el || !io) return
  io.disconnect()
  el.querySelectorAll<HTMLElement>('.webtoon-page').forEach((p) => io!.observe(p))
}
function initWebtoon() {
  const el = webtoonEl.value
  if (!el) return
  pendingAnchor = currentIndex.value
  updateRenderWindow(currentIndex.value)
  // 先按估算定位(隐藏中); 随后强制渲染窗口内页(含目标页), 等其真实高度就绪后 placeAnchor 精确校正并显示
  nextTick(() => {
    rendered.delete(currentIndex.value)
    for (let k = renderLo.value; k <= renderHi.value; k++) {
      if (pageRefs.value[k]) renderPage(k)
    }
    const p = el.querySelector<HTMLElement>(`.webtoon-page[data-i="${currentIndex.value}"]`)
    if (p) setScrollTop(el, p.offsetTop)
  })
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const i = Number((e.target as HTMLElement).dataset.i)
          renderPage(i)
        }
      }
    },
    { root: el, threshold: 0.01 },
  )
  observeRenderedPages()
}

watch([renderLo, renderHi], async () => {
  if (readMode.value !== 'webtoon') return
  await nextTick()
  observeRenderedPages()
  for (const i of renderIndices.value) {
    if (pageRefs.value[i]) void renderPage(i)
  }
})

let ro: ResizeObserver | undefined
let roRaf = 0
onMounted(() => {
  loadPdf()
  // resize 去抖: 拖拽改变窗口时合并到一帧, 避免每帧重渲
  ro = new ResizeObserver(() => {
    if (roRaf) return
    roRaf = requestAnimationFrame(() => {
      roRaf = 0
    if (readMode.value === 'webtoon') rerenderVisible()
    else if (scale.value === 1) { clearPageCache(); renderSpread() }
    })
  })
  if (root.value) ro.observe(root.value)
  window.addEventListener('keydown', onFindKey)
})
onBeforeUnmount(() => {
  spreadAbort.abort(); prefetchAbort.abort()
  cancelWebtoonRenders()
  spreadToken++
  prefetchToken++
  ro?.disconnect()
  io?.disconnect()
  io = null
  if (roRaf) cancelAnimationFrame(roRaf)
  if (zoomTimer) clearTimeout(zoomTimer)
  clearPageCache()
  doc?.destroy?.()
  window.removeEventListener('keydown', onFindKey)
})
watch(scale, () => {
  if (scale.value === 1) {
    tx.value = 0
    ty.value = 0
  }
})
watch(() => props.comic.spreadOffset, () => {
  if (readMode.value === 'page' && mode.value === 'double') {
    idx.value = alignDouble(currentIndex.value)
    currentIndex.value = idx.value
    void renderSpreadFade()
  }
})
// 锐化开关/参数变化时实时重渲染当前视图
watch(
  () => [settings.sharpen, settings.sharpenStrength, settings.sharpenRadius, settings.sharpenThreshold],
  () => {
    if (!doc) return
    if (readMode.value === 'webtoon') {
      rendered.clear()
      rerenderVisible()
    } else {
      clearPageCache() // 锐化参数变化 -> 缓存位图未含新锐化, 失效重渲
      renderSpread()
    }
  },
)
watch(
  [readMode, mode, dir, fit, scale],
  () =>
    emit('ui-state', {
      readMode: readMode.value,
      pageMode: mode.value,
      pageDir: dir.value,
      fit: fit.value,
      zoom: scale.value,
    }),
  { immediate: true },
)
// ---- 文本搜索 (pdfjs 文本层) ----
// Ctrl/Cmd+F 打开; 逐页抽取文本匹配, 记录命中页+摘要, 可上一个/下一个跳转。
const findOpen = ref(false)
const findQuery = ref('')
const findBusy = ref(false)
const findResults = ref<{ page: number; snippet: string }[]>([])
const findIndex = ref(-1)
let findToken = 0
async function runFind() {
  const q = findQuery.value.trim().toLowerCase()
  if (!q || !doc) {
    findResults.value = []
    findIndex.value = -1
    return
  }
  const token = ++findToken
  findBusy.value = true
  const results: { page: number; snippet: string }[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (token !== findToken) return
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const text = content.items.map((it: any) => it.str).join(' ')
      const at = text.toLowerCase().indexOf(q)
      if (at >= 0) {
        const from = Math.max(0, at - 20)
        results.push({ page: p, snippet: (from > 0 ? '…' : '') + text.slice(from, at + q.length + 32).trim() + '…' })
      }
      if (results.length >= 200) break // 命中上限, 防止超长文档卡顿
    }
  } catch {
    /* 个别页文本抽取失败忽略 */
  }
  if (token !== findToken) return
  findResults.value = results
  findIndex.value = results.length ? 0 : -1
  findBusy.value = false
  if (results.length) goTo(results[0].page)
}
function findStep(delta: number) {
  if (!findResults.value.length) return
  const n = findResults.value.length
  findIndex.value = (findIndex.value + delta + n) % n
  goTo(findResults.value[findIndex.value].page)
}
function showFind() {
  findOpen.value = true
}
function closeFind() {
  findOpen.value = false
  findToken++
  findBusy.value = false
}
function onFindKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    showFind()
  }
}

function visiblePages() {
  if (readMode.value === 'webtoon') return [currentIndex.value]
  return mode.value === 'double' && !(spreadOffset.value === 1 && idx.value === 0)
    ? [idx.value, idx.value + 1].filter((page) => page < total.value) : [idx.value]
}
async function capturePage(pageIndex: number, signal: AbortSignal, region?: TranslationRect) {
  throwIfAborted(signal)
  if (!doc || pageIndex < 0 || pageIndex >= total.value) throw new Error('PDF 页面尚未就绪，请稍后重试。')
  const page = await doc.getPage(pageIndex + 1)
  throwIfAborted(signal)
  const base = page.getViewport({ scale: 1 })
  const factor = Math.min(3, 2200 / Math.max(base.width, base.height), Math.sqrt(4_000_000 / (base.width * base.height)))
  const viewport = page.getViewport({ scale: factor })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
  const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport })
  const abort = () => task.cancel()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await task.promise
    throwIfAborted(signal)
    return encodeTranslationFrame(canvas, canvas.width, canvas.height, region)
  } catch (cause) { throwIfAborted(signal); throw cause }
  finally { signal.removeEventListener('abort', abort); canvas.width = 0; canvas.height = 0 }
}
defineExpose({ next, prev, goTo, zoom, toggleReadMode, setMode, setDir, cycleFit, capturePage, visiblePages })
</script>

<template>
  <div
    ref="root"
    class="reader-root relative h-full w-full overflow-hidden bg-[color:var(--stage)]"
    @touchstart.passive="onTouchStart"
    @touchmove="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel.passive="onTouchEnd"
  >
    <!-- 加载 / 错误 -->
    <div v-if="loading" class="grid h-full w-full place-items-center text-sm text-[color:var(--text-dim)]">正在加载 PDF…</div>
    <div v-else-if="error" class="grid h-full w-full place-items-center px-6 text-center text-sm font-bold text-[color:var(--accent)]">{{ error }}</div>

    <!-- 翻页模式 (单页 / 双页) -->
    <div
      v-else-if="readMode !== 'webtoon'"
      ref="wrap"
      class="grid h-full w-full place-items-center overflow-hidden p-4"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointerleave="onUp"
    >
      <div
        class="flex max-h-full max-w-full items-center justify-center gap-1 select-none"
        :class="[dragging ? 'cursor-grabbing' : scale > 1 ? 'cursor-grab' : '', mode === 'double' && dir === 'rtl' ? 'flex-row-reverse' : '']"
      >
        <div class="relative shrink-0" :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotation}deg)`, transition: dragging ? 'none' : 'transform .25s cubic-bezier(.16,1,.3,1)' }">
        <canvas
          ref="canvasL"
          class="block border border-white/10 shadow-2xl"
        />
        <TranslationLayer v-if="displayedPages.get(0) === idx && !loading" :page-index="idx" :state="translation" :rotation="rotation" @select="emit('translation-select', $event)" @region="emit('translation-region', $event)" />
        </div>
        <div v-if="mode === 'double' && !(spreadOffset === 1 && idx === 0) && idx + 1 < total" class="relative shrink-0" :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotation}deg)`, transition: dragging ? 'none' : 'transform .25s cubic-bezier(.16,1,.3,1)' }">
        <canvas
          ref="canvasR"
          class="block border border-white/10 shadow-2xl"
        />
        <TranslationLayer v-if="displayedPages.get(1) === idx + 1" :page-index="idx + 1" :state="translation" :rotation="rotation" @select="emit('translation-select', $event)" @region="emit('translation-region', $event)" />
        </div>
      </div>
    </div>

    <!-- Webtoon 竖向滚动模式 (#3: 仅窗口内挂载 canvas, 其余占位维持滚动) -->
    <div v-else ref="webtoonEl" class="webtoon-scroll h-full w-full" @scroll="onScroll">
      <div class="mx-auto flex max-w-[1000px] flex-col items-center gap-1 px-2 py-2">
        <div aria-hidden="true" class="w-full shrink-0" :style="{ height: `${topSpacerHeight}px` }" />
        <div
          v-for="pageIndex in renderIndices"
          :key="pageIndex"
          class="webtoon-page relative"
          :data-i="pageIndex"
          :style="pageStyle(pageIndex)"
        >
          <div class="relative" :style="{ transform: `rotate(${rotation}deg)` }">
          <canvas
            :ref="(el: any) => setPageRef(pageIndex, el)"
            class="webtoon-img block border border-white/10 shadow-lg"
            draggable="false"
          />
          <TranslationLayer v-if="rendered.has(pageIndex)" :page-index="pageIndex" :state="translation" :rotation="rotation" @select="emit('translation-select', $event)" @region="emit('translation-region', $event)" />
          </div>
          <div v-if="loadingPage.has(pageIndex)" class="absolute inset-0 grid place-items-center text-xs text-[color:var(--text-dim)]">渲染中…</div>
        </div>
        <div aria-hidden="true" class="w-full shrink-0" :style="{ height: `${bottomSpacerHeight}px` }" />
      </div>
    </div>

    <!-- 文本搜索 (Ctrl/Cmd+F): 独立于上面的 v-if 链, 避免打断 v-else 邻接 -->
    <button
      v-if="!loading && !error"
      class="pdf-find-trigger glass-bar"
      title="查找文本 (Ctrl+F)"
      aria-label="查找文本"
      @click="showFind"
    ><Icon name="search" :size="18" /></button>

    <Transition name="view">
      <div v-if="findOpen && !loading && !error" class="pdf-find absolute left-4 top-4 z-30 w-[min(92vw,420px)]">
        <div class="card flex items-center gap-1.5 p-2">
          <Icon name="search" :size="16" />
          <input
            v-model="findQuery"
            class="min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
            placeholder="在 PDF 中查找…"
            aria-label="查找文本"
            @keyup.enter="runFind"
          />
          <span class="shrink-0 px-1 text-xs tabular-nums text-[color:var(--text-dim)]">
            {{ findBusy ? '搜索中…' : findResults.length ? (findIndex + 1) + '/' + findResults.length : findQuery ? '无结果' : '' }}
          </span>
          <button class="icon-button" title="上一个匹配" aria-label="上一个匹配" :disabled="!findResults.length" @click="findStep(-1)"><Icon name="chevron-up" :size="17" /></button>
          <button class="icon-button" title="下一个匹配" aria-label="下一个匹配" :disabled="!findResults.length" @click="findStep(1)"><Icon name="chevron-down" :size="17" /></button>
          <button class="icon-button" title="关闭查找" aria-label="关闭查找" @click="closeFind"><Icon name="x" :size="17" /></button>
        </div>
        <ul v-if="findResults.length" class="card mt-1 max-h-60 overflow-y-auto p-1">
          <li v-for="(r, i) in findResults" :key="r.page + '-' + i">
            <button
              class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[color:var(--wash)]"
              :class="i === findIndex ? 'bg-[color:var(--wash)]' : ''"
              @click="findIndex = i; goTo(r.page)"
            >
              <span class="shrink-0 text-xs font-semibold tabular-nums text-[color:var(--accent)]">P{{ r.page }}</span>
              <span class="min-w-0 flex-1 truncate text-xs text-[color:var(--text-dim)]">{{ r.snippet }}</span>
            </button>
          </li>
        </ul>
      </div>
    </Transition>

  </div>
</template>
