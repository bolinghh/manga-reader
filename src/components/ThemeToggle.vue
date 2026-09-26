<script setup lang="ts">
import { useTheme } from '../composables/useTheme'
import Icon from './Icon.vue'

const { mode, set, modes } = useTheme()
</script>

<template>
  <div class="seg" role="group" :aria-label="`主题：${modes.find((m) => m.v === mode)?.label}`">
    <button
      v-for="m in modes"
      :key="m.v"
      type="button"
      class="seg-item"
      :class="mode === m.v ? 'is-active' : ''"
      :title="m.label"
      :aria-label="`${m.label}主题`"
      :aria-pressed="mode === m.v"
      @click="set(m.v)"
    >
      <Icon :name="m.icon" :size="16" /><span class="hidden xl:inline">{{ m.label }}</span>
    </button>
  </div>
</template>
