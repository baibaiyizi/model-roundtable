import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@opencode-ai/sdk'] })],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'import-worker': resolve('src/main/knowledge/import-worker.ts') } } }
  },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve('src/preload/index.ts') } } },
  renderer: { plugins: [react()], root: resolve('src/renderer'), build: { rollupOptions: { input: resolve('src/renderer/index.html') } } }
})
