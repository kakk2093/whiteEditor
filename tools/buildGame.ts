import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'vite'

// Builds a project into a folder of static files: <project>/build/index.html + game.js (+ assets/).
// The game is the engine's runGame() with the project's scripts, materials, prefabs and one scene inside,
// so it runs the same code as Play in the editor. It is one classic script, so index.html also opens
// straight from the disk, without a server.

export interface BuildResult {
  outDir: string
  // The scene the game starts with
  scene: string
  files: string[]
}

const ENTRY = 'virtual:white-game'

const jsonNames = async (dir: string) =>
  (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()

const readJson = async (dir: string, name: string) => JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), 'utf-8'))

const page = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
#game { width: 100%; height: 100%; }
canvas { display: block; }
</style>
</head>
<body>
<div id="game"></div>
<script src="./game.js"></script>
</body>
</html>
`

// `root` is the editor folder (where src/engine and node_modules are), `projectDir` the project inside it.
// `scene` defaults to "main", or to the first scene if there is no "main".
export async function buildGame(root: string, projectDir: string, scene?: string): Promise<BuildResult> {
  const project = path.basename(projectDir)
  const scenes = await jsonNames(path.join(projectDir, 'scenes'))
  if (scenes.length === 0) throw new Error(`Project "${project}" has no scenes`)
  const start = scene ?? (scenes.includes('main') ? 'main' : scenes[0])
  if (!scenes.includes(start)) throw new Error(`Scene "${start}" not found (scenes: ${scenes.join(', ')})`)

  // Imported by a path from the root, the way the editor and the check command load them
  const fromRoot = (file: string) => JSON.stringify(`/${path.relative(root, file).split(path.sep).join('/')}`)

  const scriptsDir = path.join(projectDir, 'scripts')
  const scripts = (await fs.readdir(scriptsDir, { recursive: true }).catch(() => [] as string[]))
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
    .sort()

  const section = async (name: string) => {
    const dir = path.join(projectDir, name)
    const entries = await Promise.all((await jsonNames(dir)).map(async (n) => [n, await readJson(dir, n)] as const))
    return JSON.stringify(Object.fromEntries(entries))
  }

  const code = [
    `import { Registry, parsePrefab, parseScene, runGame } from ${fromRoot(path.join(root, 'src/engine/index.ts'))}`,
    ...scripts.map((file, i) => `import * as script${i} from ${fromRoot(path.join(scriptsDir, file))}`),
    `const registry = new Registry()`,
    ...scripts.map((_, i) => `registry.registerExports(script${i})`),
    `for (const [name, data] of Object.entries(${await section('materials')})) registry.setMaterial(name, data)`,
    `for (const [name, data] of Object.entries(${await section('prefabs')})) registry.setPrefab(name, parsePrefab(data).root)`,
    `for (const [name, data] of Object.entries(${await section('looks')})) registry.setLook(name, data)`,
    `const scene = parseScene(${JSON.stringify(await readJson(path.join(projectDir, 'scenes'), start))})`,
    `runGame(document.getElementById('game'), registry, scene)`,
  ].join('\n')

  const outDir = path.join(projectDir, 'build')
  await build({
    root,
    configFile: false,
    // The editor's own public/ files are not part of a game
    publicDir: false,
    logLevel: 'warn',
    resolve: { alias: { 'white-engine': path.join(root, 'src/engine/index.ts') } },
    plugins: [
      {
        name: 'white-game-entry',
        resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : null),
        load: (id) => (id === `\0${ENTRY}` ? code : null),
      },
    ],
    build: {
      outDir,
      emptyOutDir: true,
      // three.js alone is bigger than the default warning limit
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        input: ENTRY,
        output: { format: 'iife', entryFileNames: 'game.js', inlineDynamicImports: true },
      },
    },
  })

  await fs.writeFile(path.join(outDir, 'index.html'), page(project))

  // Files the scripts load at run time
  const assetsDir = path.join(projectDir, 'assets')
  if ((await fs.readdir(assetsDir).catch(() => [])).length > 0) {
    await fs.cp(assetsDir, path.join(outDir, 'assets'), { recursive: true })
  }

  const files = (await fs.readdir(outDir, { recursive: true })).map((f) => f.split(path.sep).join('/')).sort()
  return { outDir, scene: start, files }
}
