import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  publicDir: 'public_root',
  resolve: { alias: { '/favicon.svg': fileURLToPath(new URL('./public_root/favicon.svg', import.meta.url)) } },
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
})
