<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { Comic } from '../types'
import { useLibrary } from '../stores/library'
import Icon from './Icon.vue'

const props = defineProps<{ comic: Comic; alt?: string }>()
const library = useLibrary()
const url = ref('')
let generation = 0

watch(() => props.comic.id, async (id, previous) => {
  const current = ++generation
  if (previous) library.releaseCoverUrl(previous)
  const resolved = await library.acquireCoverUrl(id, props.comic.cover)
  if (current === generation) url.value = resolved
  else library.releaseCoverUrl(id)
}, { immediate: true })

onBeforeUnmount(() => {
  generation++
  library.releaseCoverUrl(props.comic.id)
})
</script>

<template>
  <img v-if="url" :src="url" class="h-full w-full object-cover" :alt="alt || `${comic.title} 封面`" />
  <div v-else class="grid h-full w-full place-items-center text-[color:var(--text-dim)]"><Icon name="book-open" :size="22" /></div>
</template>
