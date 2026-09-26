# Lumina 阅读器 · 性能 & 体验改进评审

> 范围：图片(CBZ/CBR)、PDF 两种阅读器的翻页/滚动模式，以及阅读视图外壳(ReaderView)、工具栏、设置面板。
> 结论基于当前代码逐行核对，按优先级排序。✅ = 现状已做得好；🔴 = 必修(影响体验/有 bug)；🟠 = 性能/体验明显可优化；🟡 = 锦上添花。

---

## 一、现状做得好的地方（先肯定，避免误改）

- ✅ **阅读器按需异步加载**（`defineAsyncComponent`），pdfjs / epubjs 不进首屏包，首屏快。
- ✅ **PDF 滚动模式窗口化渲染 + 远端回收**（`WEBTOON_KEEP=6` + `evictFarPages`），长 PDF 不会全本位图常驻，内存有界。
- ✅ **锐化按"可见页"缓存并回收**：图片阅读器 `sharpCache` 翻页只留可见页、webtoon 滚出视口即 `revoke`，内存可控。
- ✅ **滚动索引计算用 `requestAnimationFrame` 节流**（`onScroll` → `computeWebtoonIndex`），不卡滚动。
- ✅ **阅读进度防抖落盘**（`saveTimer` 400ms），避免每翻页写库。
- ✅ **菜单顶/底双热区唤起 + 固定锁**，底部也能操作（上轮已修）。
- ✅ **双页默认 RTL + 快捷键 1/2/L/R**（上轮已加）。

---

## 二、🔴 P0 — 正确性 / 体验硬伤

### 1. 快捷键与设置面板滑块"抢键"（真实 bug）
`ReaderView.onKey` 直接挂在 `window` 上，且**完全没检查焦点目标**：

```ts
function onKey(e: KeyboardEvent) {
  const k = e.key
  if (k === 'ArrowRight' || k === ' ' || k === 'PageDown') { ... next() }
  ...
  else if (k === '1') { ... setMode('single') }
  else if (k === 'l' || k === 'L') { ... setDir('ltr') }
```

设置面板里 `sharpenStrength / sharpenRadius / sharpenThreshold / fontSize / lineHeight / brightness` 全是 `<input type="range">`。
**后果**：设置面板打开、焦点在某滑块上时，按 ←/→ 会**一边拖动滑块、一边翻页**；按 1/2/L/R 也会误触发切模式/方向。用户在调锐化参数时页面乱跳，非常割裂。

**修复（低成本，高收益）**：`onKey` 开头加焦点守卫，
```ts
const t = e.target as HTMLElement
if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
  // 仅允许 Esc 返回，其余交还给控件自身
  if (k === 'Escape') emit('back')
  return
}
```
丢弃原生 `prompt()` 跳转（见 P2 #10）后此守卫更干净。

---

## 三、🟠 P1 — 性能瓶颈

### 2. 锐化(USM)在主线程跑，且临时内存巨大
`src/utils/sharpen.ts` 的 `boxBlur` 用**二维积分图**：
```ts
const sat = new Float32Array((w + 1) * (h + 1) * chans)  // 约 4× 像素体积
```
对一张 1400×2000 的页，`sat` ≈ 1401×2001×4×4B ≈ **180MB**，加上 `blur/out/px` 三份 ≈ **350MB 瞬时分配**。
而且它**同步**执行在：
- PDF：`applySharpenIfNeeded` 在 `renderPageTo`/`renderPage` 里 `getImageData→unsharpMask→putImageData`；
- 图片：`sharpenFileToUrl`（`createImageBitmap` + canvas + `toBlob`）。

**后果**：开启锐化后，翻页 / 滚动进入新页时主线程被长时间占用 → 卡顿、掉帧，视网膜屏(dpr=2)的 PDF 滚动尤为明显。

**优化（两档）**：
- **快赢**：把二维积分图改成**可分离一维前缀和**（先横后纵），scratch 从 `(w+1)*(h+1)*4` 降到 `O(w)+O(h)`，内存砍 3~4 倍、更快。
- **彻底**：把 USM 丢进 **Web Worker**（ImageData 经 structured clone 传入、传出），与渲染主线程彻底解耦；图片阅读器本来就是异步 `toBlob`，改 worker 很自然。

**附加**：PDF 的 canvas 是 `fit*dpr` 分辨率，但 USM 只需在**显示分辨率**（`fit`，不带 dpr）上做就够清晰——可在缩放前对低分辨率位图做 USM，或仅对 dpr=1 层增强，进一步降负载。

### 3. PDF 滚动模式缩放时"全量重渲染"
`zoom()` 在 webtoon 下直接 `rendered.clear()` + `rerenderVisible()`，每按一次（步进 0.2）就把视口内所有页**重跑 PDF 渲染 + 全分辨率 USM**。快速连按时主线程反复重压。
**优化**：缩放用 `requestAnimationFrame` + 去抖（如末次 120ms 才重渲染）；或仅对变化页增量更新。

### 4. ResizeObserver 未去抖
`PdfReader` 的 `ResizeObserver` 回调里窗口尺寸变化直接同步 `renderSpread()` / `rerenderVisible()`，拖动改变窗口时会**每帧重渲染**多次。
**优化**：回调里 `requestAnimationFrame` 包一层，或 100ms 去抖。

### 5. Webtoon 锐化"并发洪峰"
图片阅读器 `initWebtoon` 的 IntersectionObserver 一旦多页同时进入视口，就并发 `ensureSharpened`（各自跑完整 USM + `toBlob`）。快速滚动时 N 个全分辨率 USM 同时排队，主线程 pile-up。
**优化**：给锐化加一个**并发受限队列**（同时 1~2 个），其余排队；PDF 滚动同理在 `renderPage` 内限流。

---

## 四、🟡 P2 — 体验打磨 / 高级感

### 6. 翻页无过渡 + 邻页未预解码（图片阅读器）
翻页模式 `<img :src="srcFor(p)">` 直接换源，**大图解码前会闪一下**；且 `decoding="async"` 只加在 webtoon 的图上，翻页模式没加。
**优化**：
- 翻页 `<img>` 也加 `decoding="async"`，并监听 `@load` 做淡入（`opacity 0→1`，150ms）。
- **预解码邻页**：翻到 `idx` 时对 `idx±step` 调用 `img.decode()`，翻页即出图无闪。

### 7. 翻页模式缺"滑动手势"
目前翻页只靠：点击区（左 1/3 上一页 / 右 2/3 下一页）+ 键盘 + 滚轮。触屏设备**没有滑动翻页**，平板/手机上体验割裂（webtoon 能原生滚动，翻页不能滑）。
**优化**：paged 模式加 pointer 滑动手势（水平位移超阈值 → next/prev），与现有 `onDown/onMove/onUp` 的缩放拖拽并存（仅在 `scale<=1` 时识别滑动）。

### 8. 仅有"适应宽度"(scale=1)，缺适应高度/原始尺寸
PDF 渲染 `fit = perPage / base.width` 恒为**适应宽度**。长条漫画/双页想看全高时只能手动缩放。
**优化**：加"适应高度 / 实际大小"两种 fit 模式切换（复用 zoom 体系）。

### 9. 图片/PDF 缺"暖色/护眼"夜间滤镜
`readerTheme` 的 sepia 仅作用于 EPUB 文字区；图片/PDF 只有全局 `brightness` 滤镜。纯降亮度对夜间刺眼缓解有限。
**优化**：在 `ReaderView` 的滤镜容器上叠加**琥珀/sepia 暖色叠层**（opacity 可调），比单纯降亮度更护眼，也更"高级"。

### 10. 跳转用原生 `prompt()`，割裂且不可主题化
`goTo()` 调 `prompt(...)` 阻塞 UI、样式与 App 不统一、且无障碍差。
**优化**：改成应用内跳转输入框（工具栏内联小弹层或底部浮条上的输入），可主题化、不阻塞。

### 11. 底部提示条与底部工具栏可能叠压
提示条 `bottom-20`、底部工具栏 `bottom-4`，矮窗口下两者纵向相邻显挤。
**优化**：底部工具栏出现时隐藏/上移提示条，或合并为一条。

### 12. 快捷键可发现性差
1/2/L/R/H/←→/空格/PageUp·Dn 很强，但只在提示条里一闪而过。
**优化**：加 `?` 唤出快捷键速查浮层（轻量）。

---

## 五、已知限制（非 bug，知悉即可）
- `props.files` 在会话期间持有**全部 File 对象**（大压缩包会常驻内存到返回书架）。已靠 `back()` 清空 `activeFiles` 缓解，属可接受权衡。
- PDF USM 在 dpr 缩放后的位图上跑（见 P1 #2 优化项）。

---

## 六、建议落地顺序（按性价比）
1. **P0 #1 焦点守卫** — 10 分钟，消除调参翻页乱跳。
2. **P1 #2 可分离前缀和 + P1 #4/#5 去抖/限流** — 半天内，锐化卡顿与缩放/resize 抖动大幅改善。
3. **P2 #6 淡入+邻页预解码、#7 滑动手势** — 翻页顺滑度与触屏体验直接上一个台阶。
4. **P1 #2 Web Worker 化 / P2 #8~#12** — 有余力再做彻底解耦与高级功能。

> 要我直接开干的话，建议先把 P0 + P1 的快赢（#1/#2 separable/#4/#5）一次性做了，见效最快、风险最低。
