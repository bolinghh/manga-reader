<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { useLibrary } from './stores/library'
import type { Comic, ReaderFile } from './types'
import LibraryView from './components/LibraryView.vue'
import ReaderView from './components/ReaderView.vue'
import AppDialog from './components/AppDialog.vue'
import TranslationJobsDialog from './components/TranslationJobsDialog.vue'
import { useTranslationJobs } from './stores/translationJobs'
import ErrorBoundary from './components/ErrorBoundary.vue'
import { alertDialog } from './composables/useDialog'
import { listenNativeDrops } from './services/nativeFiles'
import { closeNativeReaderFiles } from './services/nativeReader'

const lib = useLibrary()
const translationJobs = useTranslationJobs()
const view = ref<'library' | 'reader'>('library')
const activeComic = ref<Comic | null>(null)
const activeFiles = ref<ReaderFile[]>([])

let stopNativeDrop: (() => void) | undefined
onMounted(async () => {
  await lib.load()
  await translationJobs.load()
  if (isTauri()) {
    const startupFiles = await invoke<string[]>('startup_files')
    if (startupFiles.length) {
      const result = await lib.importNativePaths(startupFiles)
      if (result.added[0]) await openComic(result.added[0])
    }
    stopNativeDrop = await listenNativeDrops(async (paths) => {
      const result = await lib.importNativePaths(paths)
      if (result.added[0]) await openComic(result.added[0])
    })
  }
})
onBeforeUnmount(() => {
  stopNativeDrop?.()
  void closeNativeReaderFiles(activeFiles.value)
})

const activeTargetPage = ref<number | null>(null)

async function openComic(comic: Comic, targetPage?: number) {
  let files: ReaderFile[]
  try {
    files = await lib.resolveFiles(comic)
  } catch (error: any) {
    await alertDialog({ title: '无法打开', message: error?.message || '无法访问原文件，请重新关联。' })
    return
  }
  if (!files.length) {
    await alertDialog({ title: '无法打开', message: '该漫画的本地文件已失效，请重新导入。' })
    return
  }
  await closeNativeReaderFiles(activeFiles.value)
  // 从书签进入时携带目标页码, 打开后自动跳到该书签页
  activeTargetPage.value = targetPage && targetPage >= 1 ? targetPage : null
  activeFiles.value = files
  activeComic.value = comic
  view.value = 'reader'
}

function back() {
  void closeNativeReaderFiles(activeFiles.value)
  view.value = 'library'
  activeComic.value = null
  // 释放当前漫画的全部页面文件, 避免返回书架后仍被引用占用内存
  activeFiles.value = []
  activeTargetPage.value = null
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden">
    <div class="app-backdrop" />

    <!-- 顶层错误边界: 组件异常时降级为可恢复界面, 而不是白屏 -->
    <ErrorBoundary>
      <Transition name="view" mode="out-in">
        <LibraryView v-if="view === 'library'" @open="openComic" />
        <ReaderView
          v-else
          :key="activeComic!.id"
          :comic="activeComic!"
          :files="activeFiles"
          :initial-page="activeTargetPage"
          @back="back"
          @open="openComic"
        />
      </Transition>
    </ErrorBoundary>

    <!-- 应用内主题化对话框(替代原生 confirm/alert) -->
    <AppDialog />
    <TranslationJobsDialog />
  </div>
</template>
