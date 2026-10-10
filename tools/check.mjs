// Validates a project without a browser: every scene against the engine definitions, then the script types.
//   npm run check -- <project>
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = process.argv[2]
const projectDir = project ? path.join(root, 'projects', project) : ''

if (!project || !fs.existsSync(projectDir)) {
  const known = fs.existsSync(path.join(root, 'projects')) ? fs.readdirSync(path.join(root, 'projects')).join(', ') : ''
  console.error(project ? `Project "${project}" not found.` : 'Usage: npm run check -- <project>')
  console.error(`Projects: ${known || 'none'}`)
  process.exit(2)
}

const jsonNames = (section) => {
  const dir = path.join(projectDir, section)
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []
}
const readJson = (section, name) => JSON.parse(fs.readFileSync(path.join(projectDir, section, `${name}.json`), 'utf-8'))

const problems = []

// Vite loads the engine and the project scripts the same way the editor does (TypeScript, "white-engine" alias)
const server = await createServer({ root, server: { middlewareMode: true, ws: false, hmr: false }, appType: 'custom', logLevel: 'error' })
try {
  const engine = await server.ssrLoadModule('/src/engine/index.ts')
  const registry = new engine.Registry()

  const scriptsDir = path.join(projectDir, 'scripts')
  const scripts = fs.existsSync(scriptsDir)
    ? fs.readdirSync(scriptsDir, { recursive: true }).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
    : []
  for (const file of scripts) {
    const url = `/projects/${project}/scripts/${file.split(path.sep).join('/')}`
    try {
      registry.registerExports(await server.ssrLoadModule(url))
    } catch (e) {
      problems.push(`scripts/${file}: ${e.message}`)
    }
  }

  for (const name of jsonNames('materials')) {
    try {
      registry.setMaterial(name, readJson('materials', name))
    } catch (e) {
      problems.push(`materials/${name}.json: ${e.message}`)
    }
  }

  // Prefabs can contain each other, so register all of them before validating any
  const prefabs = new Map()
  for (const name of jsonNames('prefabs')) {
    try {
      const prefab = engine.parsePrefab(readJson('prefabs', name))
      prefabs.set(name, prefab)
      registry.setPrefab(name, prefab.root)
    } catch (e) {
      problems.push(`prefabs/${name}.json: ${e.message}`)
    }
  }
  for (const [name, prefab] of prefabs) {
    for (const problem of engine.validatePrefab(name, prefab, registry)) problems.push(`prefabs/${name}.json: ${problem}`)
  }

  for (const name of jsonNames('scenes')) {
    try {
      const scene = engine.parseScene(readJson('scenes', name))
      for (const problem of engine.validateScene(scene, registry)) problems.push(`scenes/${name}.json: ${problem}`)
    } catch (e) {
      problems.push(`scenes/${name}.json: ${e.message}`)
    }
  }
} finally {
  await server.close()
}

try {
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(projectDir, 'tsconfig.json')], {
    cwd: root,
    stdio: 'pipe',
  })
} catch (e) {
  for (const line of String(e.stdout ?? e.message).split('\n')) {
    if (line.trim()) problems.push(`types: ${line.trim()}`)
  }
}

if (problems.length === 0) {
  const count = (section) => `${jsonNames(section).length} ${section}`
  console.log(`${project}: OK (${count('scenes')}, ${count('materials')}, ${count('prefabs')})`)
} else {
  for (const problem of problems) console.error(problem)
  console.error(`\n${project}: ${problems.length} problem(s)`)
  process.exit(1)
}
