import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'

const app = createApp(App)

// 兜底日志: 组件树外的错误(事件处理器 / 异步回调 / watcher)不会走 ErrorBoundary,
// 若不拦截会被 Vue 静默吞掉, 便于排查起见统一记录到控制台。
app.config.errorHandler = (err, _instance, info) => {
  console.error('[MangaReader] 全局错误:', err, info)
}
app.config.warnHandler = (msg, _instance, trace) => {
  console.warn('[MangaReader] 警告:', msg, trace)
}

app.use(createPinia()).mount('#app')
