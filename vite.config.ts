import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  // 仅发布实际使用的静态资源与构建前同步的 PDF 解码资源。
  publicDir: 'public_root',
  plugins: [vue()],
  // node-unrar-js(Emscripten) 的浏览器入口走 esm/index.esm.js, 其依赖链(Extractor/ExtractorData/
  // unrar.singleton)不引用 Node 的 Buffer/fs/path; 仅在 `typeof process === 'object'` 守卫下探测
  // Node 环境, 浏览器中该守卫为 false 直接跳过。因此无需 buffer polyfill。
  // (此前 `buffer: 'buffer'` 别名指向并未安装的包, 且 optimizeDeps 强制预打包也解析不到, 属误配, 已移除。)
  define: {
    global: 'globalThis',
  },
  worker: {
    format: 'es',
  },
})
