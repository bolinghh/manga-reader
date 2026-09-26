<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'

// 顶层错误边界: 任一子组件渲染/生命周期抛错时, 捕获并降级为可操作的兜底界面,
// 避免整页白屏且无任何提示(用户只能强杀应用)。捕获后仍向上抛出以便控制台/日志留痕。
const error = ref<Error | null>(null)
const info = ref('')

onErrorCaptured((err, _instance, trace) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  info.value = trace
  console.error('[MangaReader] 未捕获的组件错误:', err, trace)
  return false // 阻止错误继续向上传播导致应用卸载
})

function reload() {
  error.value = null
  info.value = ''
  location.reload()
}
function dismiss() {
  error.value = null
  info.value = ''
}
</script>

<template>
  <slot v-if="!error" />
  <div v-else class="grid h-full w-full place-items-center bg-[color:var(--bg)] p-6">
    <section class="card flex w-[520px] max-w-full flex-col gap-4 p-6" role="alert">
      <div>
        <p class="section-kicker">UNEXPECTED ERROR</p>
        <h1 class="text-xl font-bold text-[color:var(--text)]">界面遇到问题</h1>
      </div>
      <p class="text-sm leading-6 text-[color:var(--text-dim)]">
        刚才的操作触发了一个未处理的错误，为避免数据丢失，阅读与书库数据仍保存在本地。你可以返回继续操作，或重载界面恢复。
      </p>
      <pre class="max-h-40 overflow-auto rounded-lg bg-[color:var(--wash)] p-3 text-xs text-[color:var(--danger)]">{{ error.message }}</pre>
      <div class="flex justify-end gap-2">
        <button class="btn btn--ghost" @click="dismiss">返回继续</button>
        <button class="btn btn--primary" @click="reload">重载界面</button>
      </div>
    </section>
  </div>
</template>
