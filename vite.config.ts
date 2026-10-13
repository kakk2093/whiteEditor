import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { projectsPlugin } from './vite-plugin-projects'

// https://vite.dev/config/
export default defineConfig({
  // WHITE_PROJECTS: another folder of projects, for the checks of the editor (npm run test)
  plugins: [react(), projectsPlugin(process.env.WHITE_PROJECTS)],
  resolve: {
    alias: {
      // What project scripts import; the same module instance the editor uses
      'white-engine': fileURLToPath(new URL('./src/engine/index.ts', import.meta.url)),
    },
  },
})
