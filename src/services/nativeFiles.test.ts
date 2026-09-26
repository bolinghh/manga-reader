import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './nativeFiles'

describe('native directory metadata scanning', () => {
  it('never exceeds the configured concurrency limit', async () => {
    let active = 0
    let peak = 0
    const results = await mapWithConcurrency(
      Array.from({ length: 80 }, (_, index) => index),
      16,
      async (index) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
        return index * 2
      },
    )

    expect(peak).toBeLessThanOrEqual(16)
    expect(results).toEqual(Array.from({ length: 80 }, (_, index) => index * 2))
  })
})
