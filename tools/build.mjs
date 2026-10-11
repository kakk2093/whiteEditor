// Builds a project into static files: projects/<project>/build/index.html + game.js
//   npm run build:game -- <project> [scene]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [project, scene] = process.argv.slice(2)
const projectDir = project ? path.join(root, 'projects', project) : ''

if (!project || !fs.existsSync(projectDir)) {
  const known = fs.existsSync(path.join(root, 'projects')) ? fs.readdirSync(path.join(root, 'projects')).join(', ') : ''
  console.error(project ? `Project "${project}" not found.` : 'Usage: npm run build:game -- <project> [scene]')
  console.error(`Projects: ${known || 'none'}`)
  process.exit(2)
}

// Vite loads the TypeScript build code, the same way check.mjs loads the engine
const server = await createServer({ root, server: { middlewareMode: true, ws: false, hmr: false }, appType: 'custom', logLevel: 'error' })
try {
  const { buildGame } = await server.ssrLoadModule('/tools/buildGame.ts')
  const started = Date.now()
  const result = await buildGame(root, projectDir, scene)
  const size = (file) => `${(fs.statSync(path.join(result.outDir, file)).size / 1024).toFixed(0)} KB`
  console.log(`${project}: built scene "${result.scene}" in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  for (const file of result.files) {
    if (fs.statSync(path.join(result.outDir, file)).isFile()) console.log(`  build/${file}  ${size(file)}`)
  }
  console.log(`Open ${path.join(result.outDir, 'index.html')} in a browser.`)
} catch (e) {
  console.error(`${project}: build failed: ${e.message}`)
  process.exitCode = 1
} finally {
  await server.close()
}
