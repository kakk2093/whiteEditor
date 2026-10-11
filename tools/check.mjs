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

  // What self.loadScene() and the params of kind "scene" can name
  registry.setScenes(jsonNames('scenes'))

  // project.json: the collision layers the colliders name, the tags, the start scene
  const settingsFile = path.join(projectDir, 'project.json')
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
      for (const problem of engine.validateSettings(settings, jsonNames('scenes'))) problems.push(`project.json: ${problem}`)
      registry.setSettings(engine.parseSettings(settings))
    } catch (e) {
      problems.push(`project.json: ${e.message}`)
    }
  }

  // Materials name their textures: the images of assets/
  const assetsDir = path.join(projectDir, 'assets')
  const images = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    : []
  registry.setTextures('', images)

  for (const name of jsonNames('materials')) {
    try {
      const material = readJson('materials', name)
      registry.setMaterial(name, material)
      for (const problem of engine.validateMaterial(material, registry)) problems.push(`materials/${name}.json: ${problem}`)
    } catch (e) {
      problems.push(`materials/${name}.json: ${e.message}`)
    }
  }

  // Looks can extend each other, so register all of them before validating any
  const looks = new Map()
  for (const name of jsonNames('looks')) {
    try {
      looks.set(name, readJson('looks', name))
      registry.setLook(name, looks.get(name))
    } catch (e) {
      problems.push(`looks/${name}.json: ${e.message}`)
    }
  }
  for (const [name, look] of looks) {
    for (const problem of engine.validateLook(name, look, registry)) problems.push(`looks/${name}.json: ${problem}`)
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

  // folders.json: the layout of the Project panel. A name that is not in the project is not a problem (the
  // editor skips it), a wrong shape is.
  const foldersFile = path.join(projectDir, 'folders.json')
  if (fs.existsSync(foldersFile)) {
    try {
      const folders = JSON.parse(fs.readFileSync(foldersFile, 'utf-8'))
      const sections = ['scenes', 'materials', 'prefabs', 'looks', 'textures']
      if (!folders || typeof folders !== 'object' || Array.isArray(folders)) throw new Error('must be an object')
      for (const [section, tree] of Object.entries(folders)) {
        if (!sections.includes(section)) {
          problems.push(`folders.json: unknown section "${section}" (sections: ${sections.join(', ')})`)
          continue
        }
        if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
          problems.push(`folders.json: ${section} must be an object: { "<folder>": ["<name>", ...] }`)
          continue
        }
        const seen = new Map()
        for (const [folder, names] of Object.entries(tree)) {
          if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
            problems.push(`folders.json: ${section}.${folder} must be a list of names`)
            continue
          }
          for (const name of names) {
            if (seen.has(name)) problems.push(`folders.json: ${section}: "${name}" is in two folders, ${seen.get(name)} and ${folder}`)
            else seen.set(name, folder)
          }
        }
      }
    } catch (e) {
      problems.push(`folders.json: ${e.message}`)
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
  console.log(`${project}: OK (${count('scenes')}, ${count('materials')}, ${count('prefabs')}, ${count('looks')})`)
} else {
  for (const problem of problems) console.error(problem)
  console.error(`\n${project}: ${problems.length} problem(s)`)
  process.exit(1)
}
