import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { projectsPlugin } from './vite-plugin-projects'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), projectsPlugin()],
  resolve: {
    alias: {
      // What project scripts import; the same module instance the editor uses
      'white-engine': fileURLToPath(new URL('./src/engine/index.ts', import.meta.url)),
    },
  },
})
