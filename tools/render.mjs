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
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

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

function findBrowser() {
  const candidates = [
    process.env.WHITE_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
  return candidates.find((file) => file && fs.existsSync(file))
}
const browser = findBrowser()
if (!browser) fail('No Chrome or Edge found. Set WHITE_BROWSER to the path of a Chromium-based browser.', 1)

// ---------- the page ----------

const ENTRY = 'virtual:white-render'
const scriptsDir = path.join(projectDir, 'scripts')
const scripts = fs.existsSync(scriptsDir)
  ? fs.readdirSync(scriptsDir, { recursive: true }).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts')).sort()
  : []

const assetsDir = path.join(projectDir, 'assets')
const images = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
  : []

const sounds = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(mp3|ogg|wav)$/i.test(f)).sort()
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
  `import { Registry, parsePrefab, parseScene, parseSettings, renderStill } from "/src/engine/index.ts"`,
  `const send = (body) => fetch("/__render/done", { method: "POST", body: JSON.stringify(body) })`,
  `window.addEventListener("error", (e) => send({ error: e.message }))`,
  `window.addEventListener("unhandledrejection", (e) => send({ error: String(e.reason?.message ?? e.reason) }))`,
  `const registry = new Registry()`,
  `const problems = []`,
  // What the scripts print while the scene runs
  `const logs = []`,
  `for (const level of ["log", "warn", "error"]) { const real = console[level]; console[level] = (...args) => { logs.push(level + ": " + args.map((a) => (a instanceof Error ? a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")); real(...args) } }`,
  ...scripts.map((file) => {
    const url = `/projects/${project}/scripts/${file.split(path.sep).join('/')}`
    return `try { registry.registerExports(await import(${JSON.stringify(url)})) } catch (e) { problems.push(${JSON.stringify(`scripts/${file}: `)} + e.message) }`
  }),
  `registry.setTextures(${JSON.stringify(`/projects/${project}/assets/`)}, ${JSON.stringify(images)})`,
  `registry.setSounds(${JSON.stringify(`/projects/${project}/assets/`)}, ${JSON.stringify(sounds)})`,
  `registry.setFonts(${JSON.stringify(`/projects/${project}/assets/`)}, ${JSON.stringify(fonts)})`,
  `registry.setSettings(parseSettings(${JSON.stringify(settings)}))`,
  `registry.setScenes(${JSON.stringify(sceneNames)})`,
  `for (const [name, data] of Object.entries(${JSON.stringify(readSection('materials'))})) registry.setMaterial(name, data)`,
  `for (const [name, data] of Object.entries(${JSON.stringify(readSection('prefabs'))})) registry.setPrefab(name, parsePrefab(data).root)`,
  `for (const [name, data] of Object.entries(${JSON.stringify(readSection('looks'))})) registry.setLook(name, data)`,
  // A single picture cannot wait for a late image or font, so they are loaded first
  `await registry.preloadTextures()`,
  `const still = renderStill(registry, parseScene(${JSON.stringify(readJson('scenes', scene))}), ${JSON.stringify(options)})`,
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

let child
let profile
let timeout
try {
  await server.listen()
  const { port } = server.httpServer.address()

  // A profile of its own, so that it is a separate browser and not a tab of the one the user has open
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'white-render-'))
  child = spawn(browser, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    `--window-size=${options.width ?? 960},${options.height ?? 540}`,
    `http://127.0.0.1:${port}/__render.html`,
  ], { stdio: 'ignore' })

  const started = Date.now()
  const result = await Promise.race([
    finished,
    new Promise((resolve) => child.once('exit', (code) => resolve({ error: `the browser closed before the picture was ready (exit code ${code})` }))),
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
    for (const line of result.logs ?? []) console.log(`  ${line}`)
    if (result.state) {
      for (const e of result.state.entities) {
        console.log(`  state: ${e.name}  [${e.position.join(', ')}]${e.active ? '' : '  inactive'}${e.text !== undefined ? `  text ${JSON.stringify(e.text)}` : ''}`)
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
  child?.kill()
  await server.close()
  // The browser lets go of its files a moment after it is killed
  if (profile) setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 500)
}
