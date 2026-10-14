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
// Scenes that could not be played here because something in them needs a browser
const skipped = new Set()

// Vite loads the engine and the project scripts the same way the editor does (TypeScript, "white-engine" alias)
const server = await createServer({ root, server: { middlewareMode: true, ws: false, hmr: false }, appType: 'custom', logLevel: 'error' })
try {
  const engine = await server.ssrLoadModule('/src/engine/index.ts')
  const registry = new engine.Registry()

  // The engine itself first, on its own data (tools/selfTest.ts, also `npm run test`): a broken engine would
  // show below as problems of the project
  if (!process.argv.includes('--no-selftest')) {
    try {
      for (const failure of (await server.ssrLoadModule('/tools/selfTest.ts')).selfTest()) problems.push(`engine self-test: ${failure}`)
    } catch (e) {
      problems.push(`engine self-test: ${e.message}`)
    }
  }

  // The scripts and the looks of the project "shared" are every project's; its own replace them by name
  const sharedDir = path.join(root, 'projects', engine.SHARED_PROJECT)
  const shared = project !== engine.SHARED_PROJECT && fs.existsSync(sharedDir)
  const scriptsIn = (dir) => {
    const scriptsDir = path.join(dir, 'scripts')
    return fs.existsSync(scriptsDir)
      ? fs.readdirSync(scriptsDir, { recursive: true }).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
      : []
  }
  for (const [owner, file] of [...(shared ? scriptsIn(sharedDir).map((f) => [engine.SHARED_PROJECT, f]) : []), ...scriptsIn(projectDir).map((f) => [project, f])]) {
    const url = `/projects/${owner}/scripts/${file.split(path.sep).join('/')}`
    try {
      registry.registerExports(await server.ssrLoadModule(url))
    } catch (e) {
      problems.push(`${owner === project ? '' : `projects/${owner}/`}scripts/${file}: ${e.message}`)
    }
  }
  if (shared) {
    const looksDir = path.join(sharedDir, 'looks')
    for (const file of fs.existsSync(looksDir) ? fs.readdirSync(looksDir).filter((f) => f.endsWith('.json')) : []) {
      try {
        registry.setSharedLook(file.slice(0, -5), JSON.parse(fs.readFileSync(path.join(looksDir, file), 'utf-8')))
      } catch (e) {
        problems.push(`projects/${engine.SHARED_PROJECT}/looks/${file}: ${e.message}`)
      }
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
  // Sound components and params of kind "sound" name the audio files of assets/
  const sounds = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(mp3|ogg|wav)$/i.test(f))
    : []
  registry.setSounds('', sounds)
  // "gltf" components name the model files of assets/
  registry.setModelFiles('', fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(glb|gltf)$/i.test(f))
    : [])
  // Text components name the font files of assets/
  const fonts = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
    : []
  registry.setFonts('', fonts)

  for (const name of jsonNames('materials')) {
    try {
      const material = readJson('materials', name)
      registry.setMaterial(name, material)
      for (const problem of engine.validateMaterial(material, registry)) problems.push(`materials/${name}.json: ${problem}`)
    } catch (e) {
      problems.push(`materials/${name}.json: ${e.message}`)
    }
  }

  // The grids of heights the Terrain components name
  for (const name of jsonNames('terrains')) {
    try {
      const terrain = readJson('terrains', name)
      const found = engine.validateTerrain(terrain)
      for (const problem of found) problems.push(`terrains/${name}.json: ${problem}`)
      if (found.length === 0) registry.setTerrain(name, engine.parseTerrain(terrain))
    } catch (e) {
      problems.push(`terrains/${name}.json: ${e.message}`)
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
  // The biomes: what the generator of the terrains makes a land by
  for (const name of jsonNames('biomes')) {
    try {
      const biome = readJson('biomes', name)
      registry.setBiome(name, biome)
      for (const problem of engine.validateBiome(biome, { prefabs: registry.prefabNames(), generators: registry.assetNames('generator'), looks: registry.lookNames() })) problems.push(`biomes/${name}.json: ${problem}`)
    } catch (e) {
      problems.push(`biomes/${name}.json: ${e.message}`)
    }
  }
  // The props of the terrains are copies of the prefabs, and their generators name the biomes
  for (const name of registry.terrainNames()) {
    const terrain = registry.getTerrain(name)
    for (const problem of engine.validateScatter(terrain.scatter ?? [], registry.prefabNames())) problems.push(`terrains/${name}.json: ${problem}`)
    for (const problem of terrain.generator ? engine.validateGenerator(terrain.generator, { biomes: registry.biomeNames(), generators: registry.assetNames('generator') }) : []) problems.push(`terrains/${name}.json: ${problem}`)
  }
  for (const [name, prefab] of prefabs) {
    for (const problem of engine.validatePrefab(name, prefab, registry)) problems.push(`prefabs/${name}.json: ${problem}`)
  }

  // What the scripts define that can be wrong by itself: the clips and the animators
  for (const problem of engine.validateScripts(registry)) problems.push(`scripts: ${problem}`)

  // What a browser has and this command has not: a scene (or a behavior) that needs it is not a mistake
  const needsBrowser = (message) => /\b(document|window|navigator|HTMLElement|Image|AudioContext|localStorage|requestAnimationFrame) is not defined/.test(message)

  for (const name of jsonNames('scenes')) {
    try {
      const scene = engine.parseScene(readJson('scenes', name))
      const found = engine.validateScene(scene, registry)
      for (const problem of found) problems.push(`scenes/${name}.json: ${problem}`)
      if (found.length > 0 || process.argv.includes('--no-run')) continue

      // The scene is started and played for a second, without a picture: a behavior that throws in start()
      // or update(), a prefab that cannot be spawned and the like show here, not only in the editor
      const thrown = []
      // The runtime also prints what a behavior threw; here it is collected instead
      const { error, warn, log } = console
      console.error = console.warn = console.log = () => {}
      try {
        const game = new engine.Game(registry, scene)
        game.sound.enabled = false
        game.runtime.onError = (message) => thrown.push(message)
        game.resize(960, 540)
        game.start()
        for (let i = 0; i < 60; i++) game.update(1 / 60)
        game.dispose()
      } catch (e) {
        thrown.push(`the scene could not be run: ${e.message}`)
      }
      Object.assign(console, { error, warn, log })
      for (const message of thrown) {
        if (needsBrowser(message)) skipped.add(name)
        else problems.push(`scenes/${name}.json, in a run of 1 s: ${message}`)
      }
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
      const sections = ['scenes', 'materials', 'prefabs', 'looks', 'textures', 'sounds', 'models']
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
  if (skipped.size > 0) console.log(`${project}: not played here, needs a browser (try npm run render): ${[...skipped].join(', ')}`)
  console.log(`${project}: OK (${count('scenes')}, ${count('materials')}, ${count('prefabs')}, ${count('looks')}, ${count('terrains')})`)
} else {
  for (const problem of problems) console.error(problem)
  console.error(`\n${project}: ${problems.length} problem(s)`)
  process.exit(1)
}
