export function pagedIndexFromWebtoon(currentIndex: number, mode: 'single' | 'double', total: number): number {
  const clamped = Math.min(Math.max(0, currentIndex), Math.max(0, total - 1))
  return mode === 'double' ? Math.floor(clamped / 2) * 2 : clamped
}

export function pageIndexForTarget(page: number, total: number): number {
  return Math.min(Math.max(0, Math.round(page) - 1), Math.max(0, total - 1))
}

/**
 * 书签与「当前页」的匹配。
 *
 * webtoon(竖向滚动)模式下 position 是小数(如 12.4), 而书签按钮的「已加/未加」状态、
 * 添加、删除必须共用同一套取整口径, 否则会出现「图标显示已收藏, 点击却又加一条」的错位。
 * 统一规则: 一律按 Math.round(position) 归到整数页再比较。
 */
export function bookmarkPageOf(position: number): number {
  return Math.round(position)
}

export function isSameBookmarkPage(bookmarkPosition: number, currentPosition: number): boolean {
  return Math.abs(bookmarkPosition - bookmarkPageOf(currentPosition)) < 0.5
}

export function webtoonWindow(center: number, total: number, radius = 10): { lo: number; hi: number } {
  const last = Math.max(0, total - 1)
  const target = Math.min(Math.max(0, center), last)
  return {
    lo: Math.max(0, target - Math.max(0, radius)),
    hi: Math.min(last, target + Math.max(0, radius)),
  }
}

/**
 * 前缀和树 (Fenwick / Binary Indexed Tree)。
 *
 * 用于「每页高度」这类**频繁单点更新 + 需要区间/前缀和**的场景：
 *   - 单点更新 O(log n)
 *   - 前缀和 / 区间和查询 O(log n)
 *
 * 阅读器的窗口外占位高度需要「窗口上方所有页高之和」与「窗口下方所有页高之和」。
 * 若每次求和都对区间线性累加 (O(n))，则每一页图片加载/尺寸变化都会触发一次 O(n) 重算；
 * 超长文档(数千页)下随距离放大。用前缀和树把每次更新降到 O(log n)，根除该热点。
 */
export class FenwickTree {
  private readonly tree: Float64Array
  private readonly length: number
  constructor(size: number) {
    this.length = Math.max(0, Math.floor(size))
    this.tree = new Float64Array(this.length + 1)
  }
  get size(): number {
    return this.length
  }
  /** 单点叠加 delta (索引越界或 delta 为 0 时忽略) */
  add(index: number, delta: number) {
    if (index < 0 || index >= this.length || !delta) return
    for (let x = index + 1; x <= this.length; x += x & -x) this.tree[x] += delta
  }
  /** 前 count 项之和，即 Σ values[0 .. count-1] */
  prefix(count: number): number {
    let sum = 0
    for (let x = Math.min(Math.max(0, count), this.length); x > 0; x -= x & -x) sum += this.tree[x]
    return sum
  }
  /** 区间和 [from, toExclusive) */
  range(from: number, toExclusive: number): number {
    const lo = Math.min(Math.max(0, from), this.length)
    const hi = Math.min(Math.max(0, toExclusive), this.length)
    return hi <= lo ? 0 : this.prefix(hi) - this.prefix(lo)
  }
  /** 用整体数值数组重置 (列宽/标题尺寸变化等导致所有页高重算时使用) */
  reset(values: ArrayLike<number>) {
    this.tree.fill(0)
    for (let i = 0; i < this.length; i++) {
      const v = values[i]
      if (!v) continue
      for (let x = i + 1; x <= this.length; x += x & -x) this.tree[x] += v
    }
  }
}
