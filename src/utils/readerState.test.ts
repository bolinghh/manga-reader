import { describe, expect, it } from 'vitest'
import { FenwickTree, bookmarkPageOf, isSameBookmarkPage, pageIndexForTarget, pagedIndexFromWebtoon, webtoonWindow } from './readerState'

describe('reader mode transitions', () => {
  it('keeps the current webtoon page when returning to single-page mode', () => {
    expect(pagedIndexFromWebtoon(4, 'single', 20)).toBe(4)
  })

  it('aligns the current page to the spread start in double-page mode', () => {
    expect(pagedIndexFromWebtoon(4, 'double', 20)).toBe(4)
    expect(pagedIndexFromWebtoon(5, 'double', 20)).toBe(4)
  })

  it('clamps far jumps and repeated transitions', () => {
    expect(pageIndexForTarget(999, 12)).toBe(11)
    expect(pagedIndexFromWebtoon(99, 'single', 12)).toBe(11)
    expect(pagedIndexFromWebtoon(-1, 'double', 12)).toBe(0)
  })

  it('opens a bounded webtoon window around a far target without rendering page one', () => {
    expect(webtoonWindow(49, 100)).toEqual({ lo: 39, hi: 59 })
    expect(webtoonWindow(49, 100).lo).toBeGreaterThan(0)
  })

  it('clamps the webtoon window at both book boundaries', () => {
    expect(webtoonWindow(0, 100)).toEqual({ lo: 0, hi: 10 })
    expect(webtoonWindow(99, 100)).toEqual({ lo: 89, hi: 99 })
  })
})

describe('bookmark page matching', () => {
  it('rounds a fractional webtoon position to the nearest page', () => {
    expect(bookmarkPageOf(12.4)).toBe(12)
    expect(bookmarkPageOf(12.5)).toBe(13)
    expect(bookmarkPageOf(1)).toBe(1)
  })

  it('matches a bookmark regardless of which side is fractional', () => {
    // 书签存的是整数页, 当前位置是小数 -> 必须命中同一页
    expect(isSameBookmarkPage(13, 12.6)).toBe(true)
    expect(isSameBookmarkPage(12, 12.4)).toBe(true)
    // 相差一页以上不得误判
    expect(isSameBookmarkPage(12, 13.6)).toBe(false)
    expect(isSameBookmarkPage(20, 12.4)).toBe(false)
  })

  it('is symmetric so the toggle never adds a duplicate for a bookmarked page', () => {
    // 关键回归: 旧实现中 bookmarked 用原始 position、toggle 用 round 后的值,
    // 在 12.6 这类位置会「显示已加书签但点击又新增一条」。统一口径后两者一致。
    for (const pos of [12.1, 12.4, 12.5, 12.6, 12.9]) {
      const alreadyBookmarked = isSameBookmarkPage(bookmarkPageOf(pos), pos)
      expect(alreadyBookmarked).toBe(true)
    }
  })
})

describe('FenwickTree (incremental prefix sums for page-height spacers)', () => {
  it('matches naive prefix/range sums after point updates', () => {
    const n = 500
    const values = Array.from({ length: n }, (_, i) => (i % 7) + 1)
    const tree = new FenwickTree(n)
    tree.reset(values)
    for (const i of [0, 3, 250, 499]) {
      values[i] += 100
      tree.add(i, 100)
    }
    const naive = (from: number, to: number) => values.slice(from, to).reduce((s, v) => s + v, 0)
    expect(tree.prefix(0)).toBe(0)
    expect(tree.prefix(1)).toBe(values[0])
    expect(tree.prefix(n)).toBe(naive(0, n))
    expect(tree.range(0, 250)).toBe(naive(0, 250))
    expect(tree.range(250, 500)).toBe(naive(250, 500))
    expect(tree.range(100, 100)).toBe(0)
  })

  it('clamps queries and ignores out-of-range updates', () => {
    const tree = new FenwickTree(4)
    tree.reset([1, 2, 3, 4])
    expect(tree.prefix(-5)).toBe(0)
    expect(tree.prefix(999)).toBe(10)
    tree.add(-1, 5)
    tree.add(4, 5)
    expect(tree.prefix(4)).toBe(10)
  })
})
