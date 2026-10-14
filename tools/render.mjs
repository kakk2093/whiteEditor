// Draws a scene into a PNG file, the way the game draws it (its camera, its look), without opening the editor:
//   npm run render -- <project> [scene] [--out file.png] [--size 960x540] [--time 2]
//                     [--camera x,y,z --target x,y,z [--fov 60]] [--look Name | --no-look]
//                     [--input "KeyD@0-1.5 Space@1 click:Play@2"] [--state]
// --input plays the scene for --time seconds with these keys and clicks; --state prints where every
// object is after that and what the texts say: a way to check the game itself, not only a picture.
// The picture goes to projects/<project>/renders/<scene>.png unless --out says otherwise.
//
// WebGL needs a browser, so a headless Chrome or Edge is started for a moment (set WHITE_BROWSER to the
// path of another one). A small Vite server gives it the engine, the project scripts and the scene; the
// page draws one picture with the engine's renderStill() and sends it back.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { findBrowser, openPage } from './browser.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = 'Usage: npm run render -- <project> [scene] [--out file.png] [--size 960x540] [--time seconds]\n'
  + '       [--camera x,y,z --target x,y,z [--fov degrees]] [--look Name | --no-look]\n'
  + '       [--input "KeyD@0-1.5 Space@1 click:Name@2 mouse:0.5,-0.2@1"] [--state]'

const fail = (message, code = 2) => {
  console.error(message)
  process.exit(code)
}

// ---------- arguments ----------

const names = []
const flags = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--no-look') flags.look = ''
  else if (arg === '--state') flags.state = true
  else if (arg.startsWith('--')) {
    if (argv[i + 1] === undefined) fail(`${arg} needs a value\n${USAGE}`)
    flags[arg.slice(2)] = argv[++i]
  } else names.push(arg)
}
const unknown = Object.keys(flags).filter((f) => !['out', 'size', 'time', 'camera', 'target', 'fov', 'look', 'input', 'state'].includes(f))
if (unknown.length > 0) fail(`Unknown option --${unknown[0]}\n${USAGE}`)

const [project, sceneArg] = names
const projectDir = project ? path.join(root, 'projects', project) : ''
if (!project || !fs.existsSync(projectDir)) {
  const known = fs.existsSync(path.join(root, 'projects')) ? fs.readdirSync(path.join(root, 'projects')).join(', ') : ''
  fail(`${project ? `Project "${project}" not found.` : USAGE}\nProjects: ${known || 'none'}`)
}

const jsonNames = (section) => {
  const dir = path.join(projectDir, section)
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : []
}
const readJson = (section, name) => JSON.parse(fs.readFileSync(path.join(projectDir, section, `${name}.json`), 'utf-8'))
const readSection = (section) => Object.fromEntries(jsonNames(section).map((name) => [name, readJson(section, name)]))

const scenes = jsonNames('scenes')
const scene = sceneArg ?? (scenes.includes('main') ? 'main' : scenes[0])
if (!scenes.includes(scene)) fail(`Scene "${scene}" not found (scenes: ${scenes.join(', ') || 'none'})`)

const numbers = (text, count, what) => {
  const list = String(text).split(/[,x]/).map(Number)
  if (list.length !== count || list.some(Number.isNaN)) fail(`${what}: expected ${count} numbers, got "${text}"`)
  return list
}
const options = {}
if (flags.size) [options.width, options.height] = numbers(flags.size, 2, '--size')
if (flags.time) [options.time] = numbers(flags.time, 1, '--time')
if (flags.look !== undefined) options.look = flags.look
if (flags.state) options.state = true

// --input: what the player does, items separated by spaces, each "<what>@<when>":
//   KeyD@0-1.5      the key is held from 0 to 1.5 s      Space@1     pressed at 1 s for a moment
//   click:Play@2    a click on the object named Play     click:0.5,-0.2@2   on a point of the screen (-1..1)
//   mouse:0.5,0@1   the mouse goes there                 Mouse2@1-2  the right button is held
//   type:Ann\n@1    typed into the Input Field that was clicked ("_" is a space, "\n" Enter, "\b" Backspace)
if (flags.input) {
  const TAP = 0.1
  options.inputs = []
  let last = 0
  for (const item of String(flags.input).trim().split(/\s+/)) {
    const [what, when] = item.split('@')
    const [from, to] = (when ?? '').split('-').map(Number)
    if (!what || when === undefined || Number.isNaN(from) || (to !== undefined && Number.isNaN(to))) {
      fail(`--input: "${item}" is not "<key>@<seconds>", "<key>@<from>-<to>", "click:<name or x,y>@<seconds>" or "mouse:<x,y>@<seconds>"`)
    }
    const until = to ?? from + TAP
    last = Math.max(last, until)
    const place = (text) => (/^-?[\d.]+,-?[\d.]+$/.test(text) ? text.split(',').map(Number) : text)
    if (what.startsWith('click:')) {
      options.inputs.push({ at: from, mouse: place(what.slice(6)), key: 'Mouse0', down: true }, { at: until, key: 'Mouse0', down: false })
    } else if (what.startsWith('type:')) {
      // Spaces cannot be written here: "_" stands for one; Enter ends the line with "type:Ann\n"
      options.inputs.push({ at: from, type: what.slice(5).replace(/_/g, ' ').replace(/\\n/g, '\n').replace(/\\b/g, '\b') })
    } else if (what.startsWith('mouse:')) {
      options.inputs.push({ at: from, mouse: place(what.slice(6)) })
    } else {
      options.inputs.push({ at: from, key: what, down: true }, { at: until, key: what, down: false })
    }
  }
  // Long enough for everything asked, and a moment more for the game to answer the last of it
  if (!flags.time) options.time = Math.ceil((last + 0.2) * 10) / 10
}
if (flags.camera || flags.target) {
  options.camera = {
    position: numbers(flags.camera ?? '5,4,5', 3, '--camera'),
    target: numbers(flags.target ?? '0,0,0', 3, '--target'),
    ...(flags.fov ? { fov: numbers(flags.fov, 1, '--fov')[0] } : {}),
  }
}
const out = path.resolve(flags.out ?? path.join(projectDir, 'renders', `${scene}.png`))

// ---------- the browser ----------

const browser = findBrowser()
if (!browser) fail('No Chrome or Edge found. Set WHITE_BROWSER to the path of a Chromium-based browser.', 1)

// ---------- the page ----------

const ENTRY = 'virtual:white-render'
// The scripts and the looks of the project "shared" are every project's; its own replace them by name
const SHARED = 'shared'
const sharedDir = path.join(path.dirname(projectDir), SHARED)
const shared = project !== SHARED && fs.existsSync(sharedDir)
const scriptsIn = (dir, owner) => {
  const scriptsDir = path.join(dir, 'scripts')
  const files = fs.existsSync(scriptsDir)
    ? fs.readdirSync(scriptsDir, { recursive: true }).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts')).sort()
    : []
  return files.map((file) => ({ file, url: `/projects/${owner}/scripts/${file.split(path.sep).join('/')}` }))
}
const scripts = [...(shared ? scriptsIn(sharedDir, SHARED) : []), ...scriptsIn(projectDir, project)]
const sharedLooks = {}
if (shared && fs.existsSync(path.join(sharedDir, 'looks'))) {
  for (const file of fs.readdirSync(path.join(sharedDir, 'looks')).filter((f) => f.endsWith('.json'))) {
    sharedLooks[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(sharedDir, 'looks', file), 'utf-8'))
  }
}

const assetsDir = path.join(projectDir, 'assets')
const images = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
  : []

const sounds = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(mp3|ogg|wav)$/i.test(f)).sort()
  : []

const models = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(glb|gltf)$/i.test(f)).sort()
  : []

const fonts = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f)).sort()
  : []

// The scenes a param of kind "scene" can name
const scenesDir = path.join(projectDir, 'scenes')
const sceneNames = fs.existsSync(scenesDir) ? fs.readdirSync(scenesDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []

// project.json: the collision layers
const settingsFile = path.join(projectDir, 'project.json')
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) : {}

// The same assembly as a built game (tools/buildGame.ts), ending in one picture instead of a running game
const entryCode = () => [
  `import { Registry, parsePrefab, parseScene, parseSettings, parseTerrain, renderStill } from "/src/engine/index.ts"`,
  `const send = (body) => fetch("/__render/done", { method: "POST", body: JSON.stringify(body) })`,
  `window.addEventListener("error", (e) => send({ error: e.message }))`,
  `window.addEventListener("unhandledrejection", (e) => send({ error: String(e.reason?.message ?? e.reason) }))`,
  `const registry = new Registry()`,
  `const problems = []`,
  // What the scripts print while the scene runs
  `const logs = []`,
  `for (const level of ["log", "warn", "error"]) { const real = console[level]; console[level] = (...args) => { logs.push(level + ": " + args.map((a) => (a instanceof Error ? a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")); real(...args) } }`,
  ...scripts.map(({ file, url }) =>
    `try { registry.registerExports(await import(${JSON.stringify(url)})) } catch (e) { problems.push(${JSON.stringify(`scripts/${file}: `)} + e.message) }`
  ),
  `for (const [name, data] of Object.entries(${JSON.stringify(sharedLooks)})) registry.setSharedLook(name, data)`,
  `registry.setTextures(${JSON.stringify(`/projects/${project}/assets/`)}, ${JSON.stringify(images)})`,
  `registry.setSounds(${JSON.stringify(`/projects/${project}/assets/`)}, ${JSON.stringify(sounds)})`,
  `registry.setFonts(${JSON.stringify(`/projects/${project}/assets/`)}, ${JSON.stringify(fonts)})`,
  `registry.setModelFiles(${JSON.stringify(`/projects/${project}/assets/`)}, ${JSON.stringify(models)})`,
  `registry.setSettings(parseSettings(${JSON.stringify(settings)}))`,
  `registry.setScenes(${JSON.stringify(sceneNames)})`,
  `for (const [name, data] of Object.entries(${JSON.stringify(readSection('materials'))})) registry.setMaterial(name, data)`,
  `for (const [name, data] of Object.entries(${JSON.stringify(readSection('prefabs'))})) registry.setPrefab(name, parsePrefab(data).root)`,
  `for (const [name, data] of Object.entries(${JSON.stringify(readSection('looks'))})) registry.setLook(name, data)`,
  `for (const [name, data] of Object.entries(${JSON.stringify(readSection('biomes'))})) registry.setBiome(name, data)`,
  `for (const [name, data] of Object.entries(${JSON.stringify(readSection('terrains'))})) { try { registry.setTerrain(name, parseTerrain(data)) } catch (e) { problems.push("terrains/" + name + ".json: " + e.message) } }`,
  // A single picture cannot wait for a late image or font, so they are loaded first
  `await registry.preloadTextures()`,
  // Every scene of the project, so that self.loadScene() works during the run
  `const scenes = Object.fromEntries(Object.entries(${JSON.stringify(readSection('scenes'))}).map(([name, data]) => { try { return [name, parseScene(data)] } catch { return [name, null] } }).filter(([, data]) => data))`,
  `const still = renderStill(registry, parseScene(${JSON.stringify(readJson('scenes', scene))}), { ...${JSON.stringify(options)}, scenes })`,
  `send({ ...still, logs: logs.slice(0, 200), problems: [...problems, ...still.problems] })`,
].join('\n')

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">import "/@id/__x00__${ENTRY}"</script></body></html>`

let finish
const finished = new Promise((resolve) => { finish = resolve })

const server = await createServer({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'error',
  // Its own cache: a dev server of the editor may be running next to it
  cacheDir: path.join(root, 'node_modules/.vite-render'),
  server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, ws: false, watch: null },
  resolve: { alias: { 'white-engine': path.join(root, 'src/engine/index.ts') } },
  optimizeDeps: { include: ['three', 'cannon-es'] },
  plugins: [
    {
      name: 'white-render',
      resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : null),
      load: (id) => (id === `\0${ENTRY}` ? entryCode() : null),
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url === '/__render.html') {
            res.setHeader('Content-Type', 'text/html')
            return res.end(PAGE)
          }
          if (req.url === '/__render/done' && req.method === 'POST') {
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
    },
  ],
})

let page
let timeout
try {
  await server.listen()
  const { port } = server.httpServer.address()

  page = openPage(browser, `http://127.0.0.1:${port}/__render.html`, { width: options.width, height: options.height })

  const started = Date.now()
  const result = await Promise.race([
    finished,
    page.exited.then((code) => ({ error: `the browser closed before the picture was ready (exit code ${code})` })),
    new Promise((resolve) => { timeout = setTimeout(() => resolve({ error: 'no picture after 60 seconds' }), 60000) }),
  ])

  if (result.error || !result.png) {
    console.error(`${project}: render of "${scene}" failed: ${result.error ?? 'no picture'}`)
    process.exitCode = 1
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, Buffer.from(result.png.split(',')[1], 'base64'))
    const cameras = { scene: 'the camera of the scene', given: 'the camera from --camera', auto: 'an automatic camera (the scene has none)' }
    console.log(`${project}: scene "${scene}" -> ${path.relative(process.cwd(), out)}`)
    console.log(`  ${result.width}x${result.height}, ${cameras[result.camera]}, ${((Date.now() - started) / 1000).toFixed(1)} s`)
    if (options.inputs || options.time) console.log(`  played ${options.time ?? 0} s${options.inputs ? ` with ${options.inputs.length} input events` : ''}`)
    if (result.scene) console.log(`  the run went on to scene "${result.scene}": the picture and the state are of that scene`)
    for (const line of result.logs ?? []) console.log(`  ${line}`)
    if (result.state) {
      for (const e of result.state.entities) {
        console.log(`  state: ${e.name}  [${e.position.join(', ')}]${e.scale ? `  scale [${e.scale.join(', ')}]` : ''}${e.active ? '' : '  inactive'}${e.text !== undefined ? `  text ${JSON.stringify(e.text)}` : ''}${e.value !== undefined ? `  value ${e.value}` : ''}`)
      }
      if (Object.keys(result.state.globals).length > 0) console.log(`  globals: ${JSON.stringify(result.state.globals)}`)
    }
    for (const problem of result.problems) console.log(`  problem: ${problem}`)
    if (result.problems.length > 0) process.exitCode = 1
  }
} catch (e) {
  console.error(`${project}: render failed: ${e.message}`)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  page?.close()
  await server.close()
}
