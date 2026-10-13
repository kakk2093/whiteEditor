// The checks of the tool itself, without a project of the user:
//   npm run test [-- --engine | --editor]
// 1. The engine (tools/selfTest.ts), in Node: prefabs inside prefabs. `npm run check -- <project>` runs these too.
// 2. The editor (src/editor/test/editorTest.ts), in a browser without a window: the real editor page on a
//    project written for the run, driven through its store and actions. Needs Chrome or Edge.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { findBrowser, openPage } from './browser.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const only = process.argv.includes('--engine') ? 'engine' : process.argv.includes('--editor') ? 'editor' : ''

let failed = false
const report = (what, failures, note = '') => {
  if (failures.length === 0) return console.log(`${what}: OK${note}`)
  failed = true
  for (const failure of failures) console.error(`${what}: ${failure}`)
  console.error(`${what}: ${failures.length} check(s) failed\n`)
}

// ---------- the engine ----------

// Vite loads the engine the same way the editor does (TypeScript)
const node = await createServer({ root, server: { middlewareMode: true, ws: false, hmr: false }, appType: 'custom', logLevel: 'error' })
let prefabs
try {
  const tests = await node.ssrLoadModule('/tools/selfTest.ts')
  prefabs = tests.PREFABS
  if (only !== 'editor') report('engine', tests.selfTest())
} finally {
  await node.close()
}

// ---------- the editor ----------

// The project of the run: inside the folder of the editor, like every project (one copy of three.js), but
// not among the real ones, and where neither git nor a running dev server looks
const PROJECTS = 'node_modules/.white-test/projects'
const DRIVER = '/src/editor/test/editorTest.ts'

const SCENE = {
  version: 3,
  entities: [
    { id: 'cam', name: 'Camera', position: [0, 2, 6], components: [{ type: 'camera' }] },
    {
      id: 'box',
      name: 'Box',
      position: [1, 0, 0],
      components: [{ type: 'mesh', shape: 'box', material: 'Red' }, { type: 'script', script: 'turn', params: { speed: 90 } }],
    },
    { id: 'hold', name: 'Holder', position: [0, 0, 5], rotation: [0, 90, 0], children: [{ id: 'kid', name: 'Kid', position: [1, 0, 0] }] },
    { id: 'd', name: 'Desk', prefab: 'Desk', position: [-3, 0, 0] },
    { id: 'r', name: 'Room', prefab: 'Room', position: [10, 0, 0] },
  ],
}

const SCRIPT = `import * as THREE from "three";
import { defineAnimator, defineBehavior, defineClip, defineEffect } from "white-engine";

// Does not compile: the editor must say so in its Console, in a few words
export const broken = defineEffect({
    name: "broken",
    shader: "vec4 effect(vec2 uv, vec4 color) { return color * nothing; }",
});

export const slide = defineClip({ name: "Slide", tracks: [{ property: "position.x", keys: [{ time: 0, value: 0 }, { time: 1, value: 2 }] }] });

// For the model file of the project (robot.glb with its clips "Wave" and "Walk")
export const bot = defineAnimator({
    name: "bot",
    params: { walking: { type: "boolean", default: false } },
    start: "Wave",
    states: { Wave: { clip: "Wave" }, Walk: { clip: "Walk" } },
    transitions: [{ from: "Wave", to: "Walk", when: (p) => p.walking, fade: 0.1 }, { from: "Walk", to: "Wave", when: (p) => !p.walking }],
});

export const turn = defineBehavior({
    name: "turn",
    params: { speed: { type: "number", default: 90 } },
    update: (self, dt) => {
        self.object.rotation.y += THREE.MathUtils.degToRad(self.params.speed) * dt;
    },
});
`

function writeProject() {
  const dir = path.join(root, PROJECTS, 't')
  fs.rmSync(path.join(root, PROJECTS), { recursive: true, force: true })
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  write('scenes/main.json', SCENE)
  write('materials/Red.json', { color: '#ff0000' })
  for (const [name, prefab] of Object.entries(prefabs)) write(`prefabs/${name}.json`, prefab)
  write('scripts/turn.ts', SCRIPT)
  write('looks/Broken.json', { effects: [{ effect: 'broken' }] })
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  // A model file with two clips, made by code for the project "shared"
  fs.copyFileSync(path.join(root, 'projects/shared/assets/robot.glb'), path.join(dir, 'assets/robot.glb'))
}

async function editorTest() {
  const browser = findBrowser()
  if (!browser) return { failures: ['no Chrome or Edge found; set WHITE_BROWSER to the path of a Chromium-based browser'] }

  writeProject()
  process.env.WHITE_PROJECTS = PROJECTS
  let finish
  const finished = new Promise((resolve) => { finish = resolve })
  // The editor as `npm run dev` serves it (vite.config.ts), on a port of its own
  const server = await createServer({
    root,
    logLevel: 'error',
    // Its own cache: a dev server of the editor may be running next to it
    cacheDir: path.join(root, 'node_modules/.vite-test'),
    server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, ws: false, watch: null },
    plugins: [{
      name: 'white-test',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          // The page of the editor with the checks added to it
          if (req.url === '/__test.html') {
            const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
              .replace('</body>', `<script type="module" src="${DRIVER}"></script></body>`)
            res.setHeader('Content-Type', 'text/html')
            return res.end(await vite.transformIndexHtml('/index.html', html))
          }
          if (req.url === '/__test/done' && req.method === 'POST') {
            const chunks = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
              res.end('ok')
              finish(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
            })
            return
          }
          next()
        })
      },
    }],
  })

  let page
  let timeout
  try {
    await server.listen()
    const { port } = server.httpServer.address()
    page = openPage(browser, `http://127.0.0.1:${port}/__test.html`, { width: 1280, height: 800 })
    return await Promise.race([
      finished,
      page.exited.then((code) => ({ failures: [`the browser closed before the checks were done (exit code ${code})`] })),
      new Promise((resolve) => { timeout = setTimeout(() => resolve({ failures: ['no answer from the editor page after 120 seconds'] }), 120000) }),
    ])
  } catch (e) {
    return { failures: [e.message] }
  } finally {
    clearTimeout(timeout)
    page?.close()
    await server.close()
    fs.rmSync(path.join(root, 'node_modules/.white-test'), { recursive: true, force: true })
  }
}

if (only !== 'engine') {
  const started = Date.now()
  const result = await editorTest()
  report('editor', result.failures, result.checks ? ` (${result.checks} checks, ${((Date.now() - started) / 1000).toFixed(1)} s)` : '')
}

process.exit(failed ? 1 : 0)
