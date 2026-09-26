<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTranslationJobs } from '../stores/translationJobs'
import { useLibrary } from '../stores/library'
import { useOverlayFocus } from '../composables/useOverlayFocus'
import Icon from './Icon.vue'
import TranslationSettingsDialog from './TranslationSettingsDialog.vue'
const queue = useTranslationJobs(), lib = useLibrary()
const { open } = storeToRefs(queue)
const dialog = ref<HTMLElement>()
const settingsOpen = ref(false)
const overlay = useOverlayFocus(open, dialog)
const title = computed(() => lib.comics.find(book => book.id === queue.draft?.comicId)?.title || '')
const labels = { queued: '等待中', running: '翻译中', paused: '已暂停', complete: '已完成', failed: '部分失败', cancelled: '已取消' }
function close() { queue.open = false; queue.draft = null }
</script>
<template>
  <Transition name="view">
    <div v-if="queue.open" class="translation-settings-scrim" @click.self="close" @keydown.esc.stop.prevent="close" @keydown="overlay.trap($event)" @wheel.stop @pointerdown.stop>
      <section ref="dialog" class="translation-settings-card card" role="dialog" aria-modal="true" aria-labelledby="translation-jobs-title">
        <header class="translation-row justify-between"><div><p class="section-kicker">TRANSLATION / TASKS</p><h2 id="translation-jobs-title" class="mt-1 text-xl">翻译任务</h2></div><div class="translation-row"><button class="icon-button" aria-label="翻译任务的服务设置" title="服务设置" @click="settingsOpen = true"><Icon name="settings" :size="18" /></button><button class="icon-button" aria-label="关闭翻译任务" @click="close"><Icon name="x" /></button></div></header>
        <p class="translation-muted mt-3">返回书库后继续处理；关闭应用会暂停，下次打开可继续。已完成的页面会复用缓存。</p>
        <form v-if="queue.draft" class="mt-5 border-b border-[color:var(--line)] pb-5" @submit.prevent="queue.start">
          <h3 class="mb-3 truncate font-semibold">{{ title }}</h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-sm">起始页<input v-model.number="queue.draft.start" class="translation-input mt-2" type="number" min="1" :max="queue.draft.total" required /></label>
            <label class="text-sm">结束页<input v-model.number="queue.draft.end" class="translation-input mt-2" type="number" :min="queue.draft.start" :max="queue.draft.total" required /></label>
          </div>
          <p class="translation-muted mt-3">共 {{ queue.draft.total }} 页 · 本次 {{ Math.max(0, queue.draft.end - queue.draft.start + 1) }} 页。识别文字会发送到所选翻译服务并消耗其额度。</p>
          <p v-if="queue.draft.end - queue.draft.start >= 500" class="translation-muted mt-2">缓存最多保存最近 500 份页面译文；重读较早页面可能再次消耗翻译额度。</p>
          <div class="translation-row justify-end mt-4"><button type="button" class="comic-btn" @click="queue.draft = null">取消新任务</button><button class="comic-btn comic-btn--accent" type="submit">开始后台翻译</button></div>
        </form>
        <p v-if="queue.error" class="translation-error mt-4" role="alert">{{ queue.error }}</p>
        <div v-if="!queue.jobs.length" class="translation-empty py-10"><Icon name="languages" :size="28" /><p class="mt-3">还没有翻译任务</p><p class="translation-muted mt-2">打开漫画，在译文侧栏选择“批量翻译”创建任务。</p></div>
        <ol v-else class="mt-4 space-y-4">
          <li v-for="job in queue.jobs" :key="job.id" class="border border-[color:var(--line)] p-4">
            <div class="flex items-start justify-between gap-3"><h3 class="min-w-0 break-words font-semibold">{{ job.title }}</h3><span class="shrink-0 text-sm">{{ labels[job.status] }}</span></div>
            <p class="translation-muted mt-2">第 {{ job.start }}–{{ job.end }} 页 · {{ job.config.sourceLanguage }} → {{ job.config.targetLanguage }}</p>
            <progress class="translation-job-progress mt-3 h-2 w-full" :value="job.done.length + Object.keys(job.failed).length" :max="job.end - job.start + 1" :aria-label="`${job.title} 翻译进度`" />
            <p class="text-sm mt-2" role="status">完成 {{ job.done.length }} / {{ job.end - job.start + 1 }} 页<span v-if="Object.keys(job.failed).length"> · 失败 {{ Object.keys(job.failed).length }} 页</span><span v-if="job.current !== null"> · 第 {{ job.current + 1 }} 页 {{ job.phase }}</span></p>
            <p v-if="job.error" class="translation-error mt-2" role="alert">{{ job.error }}</p>
            <details v-if="Object.keys(job.failed).length" class="translation-original mt-3"><summary>查看失败页面</summary><p v-for="(message, page) in job.failed" :key="page" class="translation-muted mt-2">第 {{ Number(page) + 1 }} 页：{{ message }}</p></details>
            <div class="translation-row flex-wrap mt-3">
              <button v-if="job.status === 'queued' || job.status === 'running'" class="comic-btn" @click="queue.pause(job.id)">暂停</button>
              <button v-if="job.status === 'paused'" class="comic-btn comic-btn--accent" @click="queue.resume(job.id)">继续</button>
              <button v-if="(job.status === 'paused' || job.status === 'failed') && Object.keys(job.failed).length" class="comic-btn" @click="queue.resume(job.id, true)">重试失败页</button>
              <button v-if="['queued', 'running', 'paused'].includes(job.status)" class="comic-btn comic-btn--ghost" @click="queue.cancel(job.id)">取消任务</button>
              <button v-else class="comic-btn comic-btn--ghost" @click="queue.remove(job.id)">移除记录</button>
            </div>
          </li>
        </ol>
      </section>
    </div>
  </Transition>
  <TranslationSettingsDialog v-model="settingsOpen" :source-language="queue.draft?.sourceLanguage || queue.jobs.find(job => job.status === 'paused')?.config.sourceLanguage || 'ja'" />
</template>
