<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { dismissDialog, resolveDialog, useDialogState } from '../composables/useDialog'
import { focusFirst, trapFocus } from '../utils/focus'
import Icon from './Icon.vue'

const state = useDialogState()
const dialog = ref<HTMLElement>()
let opener: HTMLElement | null = null

watch(
  () => state.visible,
  async (open) => {
    if (open) {
      opener = document.activeElement as HTMLElement | null
      await nextTick()
      focusFirst(dialog.value)
    } else {
      opener?.focus?.()
      opener = null
    }
  },
)
</script>

<template>
  <Transition name="view">
    <div
      v-if="state.visible"
      class="absolute inset-0 z-[60] grid place-items-center bg-black/40 p-6 backdrop-blur-sm"
      @click.self="dismissDialog()"
      @keydown.esc.stop.prevent="dismissDialog()"
      @keydown="trapFocus($event, dialog)"
    >
      <section
        ref="dialog"
        class="card flex w-[400px] max-w-full flex-col gap-4 p-5"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
      >
        <div class="flex items-start justify-between gap-3">
          <h2 id="app-dialog-title" class="font-display text-lg font-bold text-[color:var(--text)]">{{ state.title }}</h2>
          <button class="icon-button" aria-label="关闭" title="关闭" @click="resolveDialog(false)"><Icon name="x" :size="19" /></button>
        </div>
        <p class="whitespace-pre-line text-sm leading-6 text-[color:var(--text)]">{{ state.message }}</p>
        <div class="flex justify-end gap-2">
          <button v-if="state.kind === 'confirm'" class="btn btn--ghost" @click="resolveDialog(false)">{{ state.cancelText }}</button>
          <button
            class="btn"
            :class="state.danger ? 'btn--danger' : 'btn--primary'"
            @click="resolveDialog(true)"
          >{{ state.confirmText }}</button>
        </div>
      </section>
    </div>
  </Transition>
</template>
