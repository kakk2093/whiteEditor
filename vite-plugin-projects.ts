import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'
import { agentDocs } from './tools/agentDocs'

// Dev-only API the editor uses to keep game projects as folders on disk.
// A project is <dir>/<name>/ with scenes/, materials/, prefabs/ (*.json), scripts/*.ts and assets/.
//   GET    /__api/projects                       -> ["demo", ...]
//   POST   /__api/projects/demo                  -> creates the project folder
//   GET    /__api/projects/demo/scenes           -> ["main", ...]
//   GET    /__api/projects/demo/scenes/main      -> scenes/main.json
//   PUT    /__api/projects/demo/scenes/main      -> writes scenes/main.json
//   DELETE /__api/projects/demo/scenes/main      -> removes scenes/main.json
//   ...and the same for the other JSON asset folders: materials, prefabs
//   GET    /__api/projects/demo/scripts          -> ["/projects/demo/scripts/models.ts", ...]
// Script changes are sent to the editor as the "white:scripts-changed" event instead of a page reload.
// JSON assets changed by anything but this API (VS Code, an AI agent) are sent as "white:asset-changed".

const NAME = /^[\w-]+$/

// Folders whose files are JSON assets addressed by name
const JSON_SECTIONS = ['scenes', 'materials', 'prefabs']

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

export function projectsPlugin(dir = 'projects'): Plugin {
  let root = ''

  // "<project>" if the file is a script of some project
  const scriptProject = (file: string) => {
    const [project, folder, ...rest] = toPosix(path.relative(root, file)).split('/')
    return folder === 'scripts' && rest.length > 0 && NAME.test(project) ? project : null
  }

  return {
    name: 'projects',
    apply: 'serve',

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
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, notifyAsset)

      listNames(root, '').then((projects) =>
        Promise.all(projects.map((project) => writeDocs(path.join(root, project), project)))
      ).catch((e) => server.config.logger.error(String(e)))

      const handle = async (method: string, segments: string[], readBody: () => Promise<string>): Promise<unknown> => {
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
          const pathname = (req.url ?? '/').split('?')[0]
          const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent)
          const readBody = async () => {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            return Buffer.concat(chunks).toString('utf-8')
          }
          send(200, await handle(req.method ?? 'GET', segments, readBody))
        } catch (e) {
          send(e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) })
        }
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
