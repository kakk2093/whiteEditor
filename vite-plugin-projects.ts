import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'
import { agentDocs } from './tools/agentDocs'
import { buildGame } from './tools/buildGame'

// Dev-only API the editor uses to keep game projects as folders on disk.
// A project is <dir>/<name>/ with scenes/, materials/, prefabs/ (*.json), scripts/*.ts and assets/.
//   GET    /__api/projects                       -> ["demo", ...]
//   POST   /__api/projects/demo                  -> creates the project folder
//   GET    /__api/projects/demo/scenes           -> ["main", ...]
//   GET    /__api/projects/demo/scenes/main      -> scenes/main.json
//   PUT    /__api/projects/demo/scenes/main      -> writes scenes/main.json
//   POST   /__api/projects/demo/build?scene=main -> builds the game into build/, see tools/buildGame.ts
//   GET    /__game/demo/                         -> the built game
//   DELETE /__api/projects/demo/scenes/main      -> removes scenes/main.json
//   ...and the same for the other JSON asset folders: materials, prefabs, looks
//   GET    /__api/projects/demo/scripts          -> ["/projects/demo/scripts/models.ts", ...]
// Script changes are sent to the editor as the "white:scripts-changed" event instead of a page reload.
// JSON assets changed by anything but this API (VS Code, an AI agent) are sent as "white:asset-changed".

const NAME = /^[\w-]+$/

// Folders whose files are JSON assets addressed by name
// A file an editor may put into assets/
const IMAGE_NAME = /^[\w-]+\.(png|jpe?g|webp)$/i

const JSON_SECTIONS = ['scenes', 'materials', 'prefabs', 'looks']

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "paths": {
      "white-engine": ["../../src/engine/index.ts"]
    }
  },
  "include": ["scripts"]
}
`

const STARTER_SCRIPT = `import * as THREE from "three";
import { defineModel } from "white-engine";

// A model built by code: use it for shapes that are easier to compute than to assemble by hand.
// Every defineModel() exported from a file in scripts/ shows up in the editor's Create menu.

export const stairs = defineModel({
    name: "stairs",
    label: "Stairs",
    params: {
        steps: { type: "number", default: 5, min: 1, step: 1 },
        width: { type: "number", default: 1.2, min: 0.1, step: 0.1 },
        stepHeight: { type: "number", default: 0.18, min: 0.01, step: 0.01 },
        stepDepth: { type: "number", default: 0.3, min: 0.01, step: 0.01 },
        color: { type: "color", default: "#9a9a9a" },
    },
    create: (p) => {
        const group = new THREE.Group();
        const material = new THREE.MeshStandardMaterial({ color: p.color });
        for (let i = 0; i < p.steps; i++) {
            const height = p.stepHeight * (i + 1);
            const step = new THREE.Mesh(new THREE.BoxGeometry(p.width, height, p.stepDepth), material);
            step.position.set(0, height / 2, -p.stepDepth * i);
            step.castShadow = step.receiveShadow = true;
            group.add(step);
        }
        return group;
    },
});
`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const toPosix = (p: string) => p.split(path.sep).join('/')

// Pretty JSON with arrays of plain values kept on one line: [0, 1.5, 0]
export function formatJson(data: unknown) {
  return JSON.stringify(data, null, 2).replace(
    /\[\n\s+([^[\]{}]+?)\n\s+\]/g,
    (_, inner: string) => `[${inner.split(/,\n\s+/).join(', ')}]`
  ) + '\n'
}

// AGENTS.md describes the file formats for AI agents; it follows the editor version, so it is rewritten.
// CLAUDE.md is the user's own file and is only created once.
async function writeDocs(projectDir: string, project: string) {
  const docs = agentDocs(project)
  const file = path.join(projectDir, 'AGENTS.md')
  if ((await fs.readFile(file, 'utf-8').catch(() => null)) !== docs) await fs.writeFile(file, docs)

  const claude = path.join(projectDir, 'CLAUDE.md')
  if (!(await fs.stat(claude).catch(() => null))) await fs.writeFile(claude, '@AGENTS.md\n')
}

async function listNames(dir: string, ext: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => (ext ? e.isFile() && e.name.endsWith(ext) : e.isDirectory()))
    .map((e) => e.name.slice(0, e.name.length - ext.length))
}

// The image files of a project's assets/ folder (with subfolders), which materials use as textures
export async function listImages(assetsDir: string) {
  const files = await fs.readdir(assetsDir, { recursive: true }).catch(() => [] as string[])
  return files.map(toPosix).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
}

// Opens the file manager of the system with the file selected (or, for a folder, inside it)
function revealInFileManager(target: string, isFile: boolean) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', isFile ? [`/select,${target}`] : [target]]
    : process.platform === 'darwin'
      ? ['open', isFile ? ['-R', target] : [target]]
      // No common way to select a file there: its folder is opened
      : ['xdg-open', [isFile ? path.dirname(target) : target]]
  spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
}

export function projectsPlugin(dir = 'projects'): Plugin {
  let root = ''

  // "<project>" if the file is a script of some project
  const scriptProject = (file: string) => {
    const [project, folder, ...rest] = toPosix(path.relative(root, file)).split('/')
    // A file of assets/ counts too: the editor loads the project again and so sees a new or changed texture
    return (folder === 'scripts' || folder === 'assets') && rest.length > 0 && NAME.test(project) ? project : null
  }

  return {
    name: 'projects',
    apply: 'serve',

    // A finished build must not look like a source change to the dev server (an .html there reloads the editor)
    // The same for the pictures of `npm run render`
    config: () => ({ server: { watch: { ignored: [`**/${dir}/*/build/**`, `**/${dir}/*/renders/**`] } } }),

    configureServer(server) {
      root = path.resolve(server.config.root, dir)

      // Files this API has just written; their watcher events are the editor's own saves, not external edits
      const ownWrites = new Map<string, number>()
      const markOwn = (file: string) => ownWrites.set(path.normalize(file), Date.now())

      const notify = (file: string) => {
        const project = scriptProject(file)
        if (project) server.ws.send({ type: 'custom', event: 'white:scripts-changed', data: { project } })
      }
      const notifyAsset = (file: string) => {
        const [project, section, name, ...rest] = toPosix(path.relative(root, file)).split('/')
        if (rest.length > 0 || !JSON_SECTIONS.includes(section) || !name?.endsWith('.json')) return
        if (Date.now() - (ownWrites.get(path.normalize(file)) ?? 0) < 2000) return
        server.ws.send({
          type: 'custom',
          event: 'white:asset-changed',
          data: { project, section, name: name.slice(0, -5) },
        })
      }
      server.watcher.on('add', notify)
      server.watcher.on('unlink', notify)
      // A script that changed is reloaded by Vite itself; an image is not a module, so it is told here
      server.watcher.on('change', (file) => {
        if (toPosix(path.relative(root, file)).split('/')[1] === 'assets') notify(file)
      })
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, notifyAsset)
      // folders.json (the layout of the Project panel) edited by hand
      const notifyFolders = (file: string) => {
        const [project, name, ...rest] = toPosix(path.relative(root, file)).split('/')
        if (rest.length > 0 || name !== 'folders.json') return
        if (Date.now() - (ownWrites.get(path.normalize(file)) ?? 0) < 2000) return
        server.ws.send({ type: 'custom', event: 'white:folders-changed', data: { project } })
      }
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, notifyFolders)
      // project.json (the settings: collision layers) edited by hand: the editor loads the project again
      const notifySettings = (file: string) => {
        const [project, name, ...rest] = toPosix(path.relative(root, file)).split('/')
        if (rest.length > 0 || name !== 'project.json') return
        if (Date.now() - (ownWrites.get(path.normalize(file)) ?? 0) < 2000) return
        server.ws.send({ type: 'custom', event: 'white:scripts-changed', data: { project } })
      }
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, notifySettings)

      listNames(root, '').then((projects) =>
        Promise.all(projects.map((project) => writeDocs(path.join(root, project), project)))
      ).catch((e) => server.config.logger.error(String(e)))

      const handle = async (
        method: string,
        segments: string[],
        query: URLSearchParams,
        readBody: () => Promise<string>
      ): Promise<unknown> => {
        if (segments.some((s) => !NAME.test(s))) throw new HttpError(400, 'Bad name')
        const [project, section, item, ...extra] = segments
        if (extra.length > 0) throw new HttpError(404, 'Not found')

        if (!project) return listNames(root, '')

        const projectDir = path.join(root, project)
        const exists = await fs.stat(projectDir).then((s) => s.isDirectory(), () => false)

        if (!section) {
          if (method !== 'POST') throw new HttpError(405, 'Method not allowed')
          if (exists) throw new HttpError(409, `Project "${project}" already exists`)
          for (const sub of [...JSON_SECTIONS, 'scripts', 'assets']) {
            await fs.mkdir(path.join(projectDir, sub), { recursive: true })
          }
          await fs.writeFile(path.join(projectDir, 'tsconfig.json'), TSCONFIG)
          await fs.writeFile(path.join(projectDir, 'scripts', 'models.ts'), STARTER_SCRIPT)
          await writeDocs(projectDir, project)
          return { ok: true }
        }

        if (!exists) throw new HttpError(404, `Project "${project}" not found`)

        if (section === 'scripts' && !item) {
          const scriptsDir = path.join(projectDir, 'scripts')
          const files = await fs.readdir(scriptsDir, { recursive: true }).catch(() => [] as string[])
          return files
            .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
            .map((f) => `/${toPosix(path.relative(server.config.root, path.join(scriptsDir, f)))}`)
            .sort()
        }

        // GET /__api/projects/demo/assets -> the images of assets/, as materials name them: ["bricks.png", "walls/stone.png"]
        if (section === 'assets' && !item) return listImages(path.join(projectDir, 'assets'))

        // POST /__api/projects/demo/build?scene=main -> builds the game into <project>/build
        if (section === 'build' && !item) {
          if (method !== 'POST') throw new HttpError(405, 'Method not allowed')
          const scene = query.get('scene')
          if (scene && !NAME.test(scene)) throw new HttpError(400, 'Bad name')
          const result = await buildGame(server.config.root, projectDir, scene ?? undefined)
          return { scene: result.scene, files: result.files, url: `/__game/${project}/` }
        }

        // POST /__api/projects/demo/reveal?path=materials/Wood.json -> the file manager of the system opens on that
        // file. Without a path, or if there is no such file, on the nearest folder that exists.
        if (section === 'reveal' && !item) {
          if (method !== 'POST') throw new HttpError(405, 'Method not allowed')
          let target = path.resolve(projectDir, query.get('path') ?? '')
          if (target !== projectDir && !target.startsWith(projectDir + path.sep)) throw new HttpError(400, 'The path leads out of the project')
          let stat = await fs.stat(target).catch(() => null)
          while (!stat && target !== projectDir) {
            target = path.dirname(target)
            stat = await fs.stat(target).catch(() => null)
          }
          revealInFileManager(target, stat?.isFile() ?? false)
          return { ok: true, path: toPosix(path.relative(projectDir, target)) }
        }

        // GET / PUT /__api/projects/demo/folders -> folders.json: which asset lies in which folder of the Project panel
        if (section === 'folders' && !item) {
          const file = path.join(projectDir, 'folders.json')
          if (method === 'PUT') {
            const data: unknown = JSON.parse(await readBody())
            markOwn(file)
            await fs.writeFile(file, formatJson(data))
            return { ok: true }
          }
          const text = await fs.readFile(file, 'utf-8').catch(() => null)
          return text === null ? {} : JSON.parse(text)
        }

        // GET / PUT /__api/projects/demo/settings -> project.json: the settings of the project (collision layers)
        if (section === 'settings' && !item) {
          const file = path.join(projectDir, 'project.json')
          if (method === 'PUT') {
            const data: unknown = JSON.parse(await readBody())
            markOwn(file)
            await fs.writeFile(file, formatJson(data))
            return { ok: true }
          }
          const text = await fs.readFile(file, 'utf-8').catch(() => null)
          return text === null ? {} : JSON.parse(text)
        }

        if (JSON_SECTIONS.includes(section)) {
          const sectionDir = path.join(projectDir, section)
          if (!item) return listNames(sectionDir, '.json')

          const file = path.join(sectionDir, `${item}.json`)
          if (method === 'PUT') {
            const data: unknown = JSON.parse(await readBody())
            await fs.mkdir(sectionDir, { recursive: true })
            markOwn(file)
            await fs.writeFile(file, formatJson(data))
            return { ok: true }
          }
          if (method === 'DELETE') {
            markOwn(file)
            await fs.rm(file, { force: true })
            return { ok: true }
          }
          const text = await fs.readFile(file, 'utf-8').catch(() => null)
          if (text === null) throw new HttpError(404, `"${item}" not found in ${section}`)
          return JSON.parse(text)
        }

        throw new HttpError(404, 'Not found')
      }

      server.middlewares.use('/__api/projects', async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }

        try {
          const [pathname, search = ''] = (req.url ?? '/').split('?')
          const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent)

          // PUT / DELETE /__api/projects/demo/assets/bricks.png -> an image of assets/ is written (the body
          // is the file itself) or removed. The watcher then tells the editors that the project changed.
          if (segments.length === 3 && segments[1] === 'assets' && req.method !== 'GET') {
            const [project, , file] = segments
            if (!NAME.test(project) || !IMAGE_NAME.test(file)) throw new HttpError(400, 'An image name can have only Latin letters, digits, _ and -, and ends in .png, .jpg or .webp')
            const assetsDir = path.join(root, project, 'assets')
            if (!(await fs.stat(path.join(root, project)).then((s) => s.isDirectory(), () => false))) throw new HttpError(404, `Project "${project}" not found`)
            if (req.method === 'DELETE') {
              await fs.rm(path.join(assetsDir, file), { force: true })
            } else if (req.method === 'PUT') {
              const chunks: Buffer[] = []
              for await (const chunk of req) chunks.push(chunk as Buffer)
              await fs.mkdir(assetsDir, { recursive: true })
              await fs.writeFile(path.join(assetsDir, file), Buffer.concat(chunks))
            } else {
              throw new HttpError(405, 'Method not allowed')
            }
            return send(200, { ok: true })
          }

          const readBody = async () => {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            return Buffer.concat(chunks).toString('utf-8')
          }
          send(200, await handle(req.method ?? 'GET', segments, new URLSearchParams(search), readBody))
        } catch (e) {
          send(e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      // /__game/demo/ -> the built game of the project, served as it is (Vite would treat it as source)
      server.middlewares.use('/__game', async (req, res, next) => {
        const pathname = decodeURIComponent((req.url ?? '/').split('?')[0])
        const [project, ...rest] = pathname.split('/').filter(Boolean)
        if (!project || !NAME.test(project) || rest.includes('..')) return next()
        // Without the slash the page's "./game.js" would point one folder up
        if (rest.length === 0 && !pathname.endsWith('/')) {
          res.statusCode = 302
          res.setHeader('Location', `/__game/${project}/`)
          return res.end()
        }

        const file = path.join(root, project, 'build', ...(rest.length > 0 ? rest : ['index.html']))
        const body = await fs.readFile(file).catch(() => null)
        if (!body) {
          res.statusCode = 404
          return res.end(`Not found. Build the game first: npm run build:game -- ${project}`)
        }
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      })
    },

    // The editor re-imports project scripts itself, so a script edit must not reload the page
    handleHotUpdate(ctx) {
      const project = scriptProject(ctx.file)
      if (!project) return

      const seen = new Set<(typeof ctx.modules)[number]>()
      for (const mod of ctx.modules) {
        ctx.server.moduleGraph.invalidateModule(mod, seen, ctx.timestamp, true)
      }
      ctx.server.ws.send({ type: 'custom', event: 'white:scripts-changed', data: { project } })
      return []
    },
  }
}
