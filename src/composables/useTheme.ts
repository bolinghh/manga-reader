import { ref, watch } from 'vue'
import type { ThemeMode } from '../types'

const STORAGE_KEY = 'lumina.theme'
const mode = ref<ThemeMode>((localStorage.getItem(STORAGE_KEY) as ThemeMode) || 'light')

// Canvas colors mirror style.css :root / .dark --canvas, kept here so the browser
// chrome (address bar / window frame) matches the app background instead of a stale gray.
const CANVAS = { light: '#f3efe7', dark: '#0f0e0d' }

function syncThemeColor(dark: boolean) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = dark ? CANVAS.dark : CANVAS.light
}

function apply(m: ThemeMode) {
  const dark = m === 'dark' || (m === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  syncThemeColor(dark)
}

apply(mode.value)

// React to OS theme changes when in system mode
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (mode.value === 'system') apply('system')
})

watch(mode, (m) => {
  localStorage.setItem(STORAGE_KEY, m)
  apply(m)
})

const MODES: { v: ThemeMode; icon: string; label: string }[] = [
  { v: 'light', icon: 'sun', label: '亮色' },
  { v: 'dark', icon: 'moon', label: '暗色' },
  { v: 'system', icon: 'monitor', label: '跟随系统' },
]

export function useTheme() {
  const set = (m: ThemeMode) => {
    mode.value = m
  }
  // Cycle through light -> dark -> system (was a no-op: `set(mode.value)`)
  const cycle = () => {
    const i = MODES.findIndex((x) => x.v === mode.value)
    set(MODES[(i + 1) % MODES.length].v)
  }
  const icon = () => MODES.find((x) => x.v === mode.value)?.icon ?? '☀️'
  const label = () => MODES.find((x) => x.v === mode.value)?.label ?? '亮色'
  return { mode, set, cycle, icon, label, modes: MODES }
}
