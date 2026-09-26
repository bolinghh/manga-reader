// 带阈值的非锐化掩码 (Unsharp Mask, USM) —— 纯计算核心(无 DOM 依赖, 可被 Web Worker 复用)
//
// 算法思想借鉴自 Avisynth 插件包中的 warpsharp(UnsharpMask) 与 MangaMeeya(USM锐化):
//   1. 用模糊版本近似"低频" —— blur = 对原图做 Box 模糊 (半径 radius)
//   2. 高频细节 = 原图 - blur
//   3. 阈值门控: 仅当 |高频| > threshold 时才把细节加回 (strength 倍)
//      —— 平坦区 / 弱噪点被放过, 只锐化真正的边缘, 避免线稿产生光晕、不放大扫描噪点
//
// 与之前"全频拉普拉斯卷积"的区别: 卷积对平坦区也一律加强, 会放大噪点;
// USM + 阈值只强化强边缘, 更适合漫画/扫描页。
//
// 性能: Box 模糊用**可分离一维前缀和**(先横后纵)实现, O(n) 时间,
//   且仅用 O(w)+O(h) 的 1D 前缀暂存(整数累加), 相比旧版"二维积分图"
//   (w+1)*(h+1)*4 的 Float 数组, 临时内存约下降 3~4 倍, 同时更快。

export interface SharpenOptions {
  /** 模糊半径(px), 越大越平滑、细节越少。漫画线稿建议 1 */
  radius: number
  /** 锐化强度(细节加回倍数), 通常 0.5–3 */
  strength: number
  /** 阈值(0–255): 低于该对比度的区域不锐化, 用于抑制噪点/平坦区 */
  threshold: number
}

/**
 * 可分离 Box 模糊: 横向一维前缀和 -> 纵向一维前缀和。
 * 用 Uint32 累加前缀(单通道单行/列累加上限 ~w*255, 远在 Uint32 范围内),
 * 窗口均值落到 Uint8ClampedArray, 避免 Float 大数组。
 */
function boxBlur(img: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const ch = 4
  const n = w * h
  const tmp = new Uint8ClampedArray(n * ch)
  const sat = new Uint32Array(w + 1)

  // ---- 横向 ----
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let c = 0; c < ch; c++) {
      sat[0] = 0
      for (let x = 0; x < w; x++) sat[x + 1] = sat[x] + img[(row + x) * ch + c]
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r)
        const x1 = Math.min(w - 1, x + r)
        const area = x1 - x0 + 1
        tmp[(row + x) * ch + c] = (sat[x1 + 1] - sat[x0]) / area
      }
    }
  }

  // ---- 纵向 ----
  const out = new Uint8ClampedArray(n * ch)
  const satV = new Uint32Array(h + 1)
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < ch; c++) {
      satV[0] = 0
      for (let y = 0; y < h; y++) satV[y + 1] = satV[y] + tmp[(y * w + x) * ch + c]
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - r)
        const y1 = Math.min(h - 1, y + r)
        const area = y1 - y0 + 1
        out[(y * w + x) * ch + c] = (satV[y1 + 1] - satV[y0]) / area
      }
    }
  }
  return out
}

/** 对 ImageData 原位做带阈值 USM, 返回新的 ImageData */
export function unsharpMask(data: ImageData, opts: SharpenOptions): ImageData {
  const { width: w, height: h, data: px } = data
  const r = Math.max(1, Math.round(opts.radius))
  const blur = boxBlur(px, w, h, r)
  const out = new Uint8ClampedArray(px.length)
  const T = Math.max(0, opts.threshold)
  const S = Math.max(0, opts.strength)
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    if (a === 0) {
      out[i] = px[i]
      out[i + 1] = px[i + 1]
      out[i + 2] = px[i + 2]
      out[i + 3] = 0
      continue
    }
    for (let c = 0; c < 3; c++) {
      const diff = px[i + c] - blur[i + c]
      // 阈值门控: 仅强边缘参与锐化
      out[i + c] = Math.abs(diff) > T ? px[i + c] + diff * S : px[i + c]
    }
    out[i + 3] = a
  }
  return new ImageData(out, w, h)
}
