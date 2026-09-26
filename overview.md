# 锐化功能升级：拉普拉斯卷积 → 带阈值非锐化掩码（USM）

## 背景
锐化算法参考了 Avisynth 中 warpsharp / MangaMeeya 的 **UnsharpMask / USM** 思想：**用模糊版近似低频，原图减模糊得高频细节，仅当细节强度超过 `threshold` 时才加回**——即只锐化强边缘、放过平坦区，避免噪点被放大、线稿更干净。当前实现位于 `src/utils/sharpenCore.ts`，不依赖原生插件 DLL，旧参考包已从项目移除。

原 Lumina 锐化是一个 3×3 **拉普拉斯卷积**（`0 -1 0 / -1 5 -1 / 0 -1 0`），属于**全频提升、无阈值**，会一视同仁地加强平坦区噪点。本次按插件算法思想将其升级为带阈值的 USM。

## 关键工程判断
纯 SVG 滤镜无法实现"带符号阈值"：`feComponentTransfer` 会把负向高频夹到 0，导致漫画黑线只锐一边、产生白边光晕。因此改用 **canvas 像素级 USM** 才能忠实落地阈值思想，并用**按可见页边界的缓存**把内存开销控住（与之前 webtoon / PDF 的窗口化同一思路）。

## 改动清单
- **新增 `src/utils/sharpen.ts`** — `unsharpMask()` + `sharpenFileToUrl()`
  - Box 模糊用**积分图（prefix-sum）**实现，复杂度 O(n)，整页一次性处理；
  - USM 公式：`out = src + (src − blur) × strength`，仅当 `|src − blur| > threshold` 时加回（阈值门控）；透明像素直接透传；
  - `createImageBitmap` 解码 → canvas → `getImageData` → `putImageData` → `toBlob('image/png')` 返回 blob URL。
- **`src/stores/settings.ts`** — 在 `sharpen` 布尔外新增 `sharpenStrength`（默认 1.6）、`sharpenRadius`（默认 1）、`sharpenThreshold`（默认 6），均纳入持久化 / 监听 / 重置。
- **`src/components/readers/ImageReader.vue`** — 移除 SVG 卷积滤镜块与 `.is-sharpen` class；改为按可见页缓存的 canvas USM：
  - `sharpCache: reactive(Map<idx,url>)` + `sharpPending: Set` + `srcFor(i)`（生成中先显示原图，完成后自动切换）；
  - 翻页模式 `syncPageSharpen()` 只生成可见页并回收其余；webtoon 由 `IntersectionObserver` 驱动（进入视口生成、离开回收，`intersecting: Set` 跟踪）；
  - watcher 监听锐化开关 / 三参数 / 翻页，参数变更时清旧缓存重生；`onBeforeUnmount` 回收全部。
- **`src/components/SettingsPanel.vue`** — 锐化开关下加「强度 / 模糊半径 / 阈值」三个滑块。
- **`src/style.css`** — 删除死规则 `.is-sharpen img { filter: url(#lumina-sharpen) }`。

## 验证
`vue-tsc -b && vite build` 全部通过；全局 grep `is-sharpen | lumina-sharpen | feConvolveMatrix` 零残留。

## 内存
仅可见页持有锐化 bitmap（翻页 1–2 页；webtoon 视口窗口），关闭 / 换参 / 切走即 revoke，不退化到全本常驻。

## 使用方式
硬刷 `localhost:5173` → 打开任意图片漫画 → 点右下角浮动条「锐化」或设置面板开启；设置面板可调 强度 / 半径 / 阈值。扫描发灰页会更锐利且不过度放大噪点。
