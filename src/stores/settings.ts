import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

const KEY = 'lumina.readingSettings'

interface Persisted {
  brightness: number
  warmth: number
  // 轻量锐化 (canvas 带阈值 USM, 零模型, 默认关闭)
  sharpen: boolean
  sharpenStrength: number
  sharpenRadius: number
  sharpenThreshold: number
}

const defaults: Persisted = {
  brightness: 1,
  warmth: 0,
  sharpen: false,
  sharpenStrength: 1.6,
  sharpenRadius: 1,
  sharpenThreshold: 6,
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ...defaults }
}

export const useReadingSettings = defineStore('readingSettings', () => {
  const s = load()
  const brightness = ref(s.brightness)
  const warmth = ref(s.warmth)
  const sharpen = ref(s.sharpen)
  const sharpenStrength = ref(s.sharpenStrength)
  const sharpenRadius = ref(s.sharpenRadius)
  const sharpenThreshold = ref(s.sharpenThreshold)

  watch(
    [brightness, warmth, sharpen, sharpenStrength, sharpenRadius, sharpenThreshold],
    () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          brightness: brightness.value,
          warmth: warmth.value,
          sharpen: sharpen.value,
          sharpenStrength: sharpenStrength.value,
          sharpenRadius: sharpenRadius.value,
          sharpenThreshold: sharpenThreshold.value,
        }),
      )
    },
  )

  const reset = () => {
    brightness.value = defaults.brightness
    warmth.value = defaults.warmth
    sharpen.value = defaults.sharpen
    sharpenStrength.value = defaults.sharpenStrength
    sharpenRadius.value = defaults.sharpenRadius
    sharpenThreshold.value = defaults.sharpenThreshold
  }

  return {
    brightness,
    warmth,
    sharpen,
    sharpenStrength,
    sharpenRadius,
    sharpenThreshold,
    reset,
  }
})
