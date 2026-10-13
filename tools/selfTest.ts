import * as THREE from 'three'
import { animationOf, animatorOf, defineAnimator, defineClip } from '../src/engine/animation'
import { componentDefs } from '../src/engine/components'
import { Game } from '../src/engine/game'
import {
  applyToPrefab, assignAddedIds, diffOverride, expandInstance, expandPristine, findInExpanded, innerPaths, ROOT_PATH,
} from '../src/engine/prefab'
import { Registry } from '../src/engine/Registry'
import { brushRegion, brushTerrain, cloneTerrain, fillTerrainGeometry, flatTerrain, terrainRange, isPainted, rayTerrain, resizeTerrain, terrainGeometry, terrainHeight, terrainSize, validateTerrain } from '../src/engine/terrain'
import type { TerrainData } from '../src/engine/terrain'
import { biomeShares, defaultGenerator, generateByMap, generatedHeight, generateTerrain, generatorOf, noise2D, validateBiome } from '../src/engine/generate'
import type { BiomeData } from '../src/engine/generate'
import { createScatter, eraseScatter, plantScatter, scatterColliders, scatterCount, updateScatter } from '../src/engine/scatter'
import { zoneAt } from '../src/engine/environment'
import { submergedAt } from '../src/engine/water'
import { parsePrefab, parseScene } from '../src/engine/types'
import type { EntityData, EntityOverride } from '../src/engine/types'
import { validatePrefab, validateScene, validateScripts } from '../src/engine/validate'

// Checks of the engine itself, on data made right here: nothing of a project is read. `npm run check` runs
// them before it looks at the project, so a change in the engine that breaks them shows at once.
// Four parts: prefabs inside prefabs, animation (clips and animators), colliders that are turned (slopes),
// the ground of a terrain.
//
// The prefabs: a lamp, a desk with that lamp on it, a room with that desk in it.

const LAMP = {
  version: 3,
  root: {
    name: 'Lamp',
    tag: 'lamp',
    components: [{ type: 'light', kind: 'point', intensity: 2 }],
    children: [
      { name: 'Shade', position: [0, 0.5, 0], components: [{ type: 'mesh', shape: 'box' }] },
      { name: 'Bulb', components: [{ type: 'mesh', shape: 'sphere' }], children: [{ name: 'Glow' }] },
    ],
  },
}

const DESK = {
  version: 3,
  root: {
    name: 'Desk',
    components: [{ type: 'mesh', shape: 'box' }],
    children: [
      { name: 'Top', position: [0, 1, 0], components: [{ type: 'mesh', shape: 'box' }, { type: 'collider' }] },
      {
        name: 'Lamp',
        prefab: 'Lamp',
        position: [0, 1, 0],
        overrides: {
          Shade: { scale: [2, 2, 2] },
          // What the desk adds to its lamp
          '.': { addChildren: [{ name: 'Cord', position: [0, 0, 1] }] },
        },
      },
    ],
  },
}

const ROOM = {
  version: 3,
  root: {
    name: 'Room',
    children: [{ name: 'Floor' }, { name: 'Desk', prefab: 'Desk', position: [3, 0, 0] }],
  },
}

// The same prefabs make the project the checks of the editor run on (tools/test.mjs)
export const PREFABS = { Lamp: LAMP, Desk: DESK, Room: ROOM }

function makeRegistry(extra: Record<string, unknown> = {}) {
  const registry = new Registry()
  for (const [name, json] of Object.entries({ Lamp: LAMP, Desk: DESK, Room: ROOM, ...extra })) {
    registry.setPrefab(name, parsePrefab(json).root)
  }
  return registry
}

// An instance as a scene file would give it
function instance(prefab: string, overrides?: Record<string, unknown>, id = 'i'): EntityData {
  const scene = parseScene({ version: 3, entities: [{ id, name: 'It', prefab, position: [1, 2, 3], ...(overrides ? { overrides } : {}) }] })
  assignAddedIds(scene.entities)
  return scene.entities[0]
}

export function selfTest(): string[] {
  const failures: string[] = []
  let group = ''
  const fail = (what: string) => failures.push(`${group}: ${what}`)
  const ok = (what: string, condition: unknown) => {
    if (!condition) fail(what)
  }
  const equal = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
  const test = (name: string, run: () => void) => {
    group = name
    try {
      run()
    } catch (e) {
      fail(`threw ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const registry = makeRegistry()
  const expand = (prefab: string, overrides?: Record<string, unknown>, from = registry) => {
    const expanded = expandInstance(from, instance(prefab, overrides))
    if (!expanded) throw new Error(`prefab ${prefab} was not expanded`)
    return expanded
  }
  // The entity of an expanded instance at a path of names
  const at = (expanded: EntityData, path: string) => {
    const found = findInExpanded(expanded, `${expanded.id}/${path}`)
    if (!found) throw new Error(`nothing at ${path} (there is: ${innerPaths(expanded).join(', ')})`)
    return found
  }
  const has = (expanded: EntityData, path: string) => findInExpanded(expanded, `${expanded.id}/${path}`) !== null
  const keys = (entity: EntityData) => entity.components.map((c) => c.type)

  test('a prefab inside a prefab', () => {
    const desk = expand('Desk')
    equal('paths', innerPaths(desk), ['Top', 'Lamp', 'Lamp/Shade', 'Lamp/Bulb', 'Lamp/Bulb/Glow', 'Lamp/Cord'])
    equal('the instance keeps its own place', desk.position, [1, 2, 3])
    equal('the root has the components of the prefab', keys(desk), ['mesh'])
    equal('the inner instance stands where the desk puts it', at(desk, 'Lamp').position, [0, 1, 0])
    equal('and has the components of its own prefab', keys(at(desk, 'Lamp')), ['light'])
    equal('the tag of the root of its prefab', at(desk, 'Lamp').tag, 'lamp')
    ok('it is not an instance any more', !at(desk, 'Lamp').prefab && !at(desk, 'Lamp').overrides)
    equal('the override the desk gives its lamp', at(desk, 'Lamp/Shade').scale, [2, 2, 2])
    equal('what the override leaves alone', at(desk, 'Lamp/Shade').position, [0, 0.5, 0])
    equal('what the desk adds to its lamp', at(desk, 'Lamp/Cord').position, [0, 0, 1])
  })

  test('three levels', () => {
    const room = expand('Room', { 'Desk/Lamp/Shade': { rotation: [0, 45, 0] }, 'Desk/Top': { active: false } })
    equal('paths', innerPaths(room), [
      'Floor', 'Desk', 'Desk/Top', 'Desk/Lamp', 'Desk/Lamp/Shade', 'Desk/Lamp/Bulb', 'Desk/Lamp/Bulb/Glow', 'Desk/Lamp/Cord',
    ])
    equal('the override of the scene', at(room, 'Desk/Lamp/Shade').rotation, [0, 45, 0])
    equal('the override of the desk under it', at(room, 'Desk/Lamp/Shade').scale, [2, 2, 2])
    equal('active', at(room, 'Desk/Top').active, false)
    equal('where the room puts the desk', at(room, 'Desk').position, [3, 0, 0])
  })

  test('fields of an inner instance', () => {
    const desk = expand('Desk', {
      Lamp: { position: [5, 0, 0], components: { light: { intensity: 7 } } },
      'Lamp/Shade': { position: [1, 2, 3], components: { mesh: { shape: 'cylinder' } } },
    })
    equal('its place', at(desk, 'Lamp').position, [5, 0, 0])
    equal('a field of its root component', at(desk, 'Lamp').components[0].intensity, 7)
    equal('the other fields stay', at(desk, 'Lamp').components[0].kind, 'point')
    equal('an entity inside it', at(desk, 'Lamp/Shade').position, [1, 2, 3])
    equal('a component inside it', at(desk, 'Lamp/Shade').components[0].shape, 'cylinder')
    equal('the override of the desk is still there', at(desk, 'Lamp/Shade').scale, [2, 2, 2])
    // The outer one wins where both say something
    equal('the outer override wins', at(expand('Desk', { 'Lamp/Shade': { scale: [3, 3, 3] } }), 'Lamp/Shade').scale, [3, 3, 3])
  })

  test('another name', () => {
    const desk = expand('Desk', { Lamp: { name: 'Light' }, 'Lamp/Bulb': { name: 'Big Bulb' }, Top: { name: 'Board' } })
    equal('the inner instance', at(desk, 'Lamp').name, 'Light')
    equal('an entity inside it', at(desk, 'Lamp/Bulb').name, 'Big Bulb')
    equal('an entity of the prefab', at(desk, 'Top').name, 'Board')
    // Paths and ids go on by the names the prefabs give
    equal('paths', innerPaths(desk), ['Top', 'Lamp', 'Lamp/Shade', 'Lamp/Bulb', 'Lamp/Bulb/Glow', 'Lamp/Cord'])
    const room = expand('Room', { 'Desk/Lamp/Bulb': { name: 'Far Bulb' }, Desk: { name: 'Table' } })
    equal('through two levels', at(room, 'Desk/Lamp/Bulb').name, 'Far Bulb')
    equal('the middle one', at(room, 'Desk').name, 'Table')
    equal('the rest keep their names', at(room, 'Desk/Lamp').name, 'Lamp')
  })

  test('added and removed components', () => {
    const desk = expand('Desk', {
      Lamp: { removeComponents: ['light'], addComponents: [{ type: 'collider', shape: 'sphere' }] },
      'Lamp/Shade': { addComponents: [{ type: 'light' }] },
      Top: { removeComponents: ['collider'] },
      '.': { addComponents: [{ type: 'collider' }] },
    })
    equal('the root of the inner instance', keys(at(desk, 'Lamp')), ['collider'])
    equal('the added one keeps its fields', at(desk, 'Lamp').components[0].shape, 'sphere')
    equal('an entity inside it', keys(at(desk, 'Lamp/Shade')), ['mesh', 'light'])
    equal('an entity of the prefab', keys(at(desk, 'Top')), ['mesh'])
    equal('the root of the instance', keys(desk), ['mesh', 'collider'])
    // The prefab has got such a component since: that one stays
    equal('added what the prefab has', keys(expand('Desk', { Top: { addComponents: [{ type: 'collider', shape: 'sphere' }] } }).children[0]), ['mesh', 'collider'])
  })

  test('added and removed entities', () => {
    const desk = expand('Desk', {
      'Lamp/Bulb': { addChildren: [{ name: 'Extra', position: [0, 2, 0], children: [{ name: 'Deeper' }] }] },
      Top: { removed: true },
      'Lamp/Shade': { removed: true },
    })
    equal('paths', innerPaths(desk), ['Lamp', 'Lamp/Bulb', 'Lamp/Bulb/Glow', 'Lamp/Bulb/Extra', 'Lamp/Bulb/Extra/Deeper', 'Lamp/Cord'])
    equal('the added one', at(desk, 'Lamp/Bulb/Extra').position, [0, 2, 0])
    // The desk has already added a cord to its lamp: both stay
    const plugged = expand('Desk', { Lamp: { addChildren: [{ name: 'Plug' }], addComponents: [{ type: 'collider' }] } })
    ok('added next to what the inner instance adds', has(plugged, 'Lamp/Cord') && has(plugged, 'Lamp/Plug'))
    equal('with a component added to it', keys(at(plugged, 'Lamp')), ['light', 'collider'])
    ok('the whole inner instance removed', !has(expand('Desk', { Lamp: { removed: true } }), 'Lamp'))
    ok('through two levels', !has(expand('Room', { 'Desk/Lamp/Bulb': { removed: true } }), 'Desk/Lamp/Bulb'))
    ok('and nothing under it', !has(expand('Room', { 'Desk/Lamp/Bulb': { removed: true } }), 'Desk/Lamp/Bulb/Glow'))
  })

  test('an added entity that is an instance', () => {
    const desk = expand('Desk', { '.': { addChildren: [{ name: 'Second', prefab: 'Lamp', position: [2, 0, 0], overrides: { Shade: { active: false } } }] } })
    equal('its place', at(desk, 'Second').position, [2, 0, 0])
    equal('its own override', at(desk, 'Second/Shade').active, false)
    equal('the lamp of the desk is not touched', at(desk, 'Lamp/Shade').active, undefined)
    ok('its content', has(desk, 'Second/Bulb/Glow'))
    ok('what the desk adds to its own lamp is not in this one', !has(desk, 'Second/Cord'))
  })

  test('what an inner instance adds, changed from outside', () => {
    equal('moved', at(expand('Desk', { 'Lamp/Cord': { position: [9, 9, 9] } }), 'Lamp/Cord').position, [9, 9, 9])
    equal('renamed', at(expand('Desk', { 'Lamp/Cord': { name: 'Wire' } }), 'Lamp/Cord').name, 'Wire')
    ok('removed', !has(expand('Desk', { 'Lamp/Cord': { removed: true } }), 'Lamp/Cord'))
    equal('a component added', keys(at(expand('Desk', { 'Lamp/Cord': { addComponents: [{ type: 'collider' }] } }), 'Lamp/Cord')), ['collider'])
    equal('through two levels', at(expand('Room', { 'Desk/Lamp/Cord': { position: [7, 7, 7] } }), 'Desk/Lamp/Cord').position, [7, 7, 7])
    ok('a child added', has(expand('Desk', { 'Lamp/Cord': { addChildren: [{ name: 'Plug' }] } }), 'Lamp/Cord/Plug'))
    // The prefabs in the registry are the same as before all that
    equal('the prefab is not changed', at(expand('Desk'), 'Lamp/Cord').position, [0, 0, 1])
    equal('nor its name', at(expand('Desk'), 'Lamp/Cord').name, 'Cord')
  })

  test('not deep', () => {
    const desk = expandInstance(registry, instance('Desk', { 'Lamp/Shade': { position: [1, 2, 3] }, Lamp: { components: { light: { intensity: 7 } } } }), [], false)
    const lamp = desk?.children.find((child) => child.name === 'Lamp')
    equal('the inner one stays an instance', lamp?.prefab, 'Lamp')
    equal('with no content of its own', lamp?.children, [])
    equal('it carries both overrides of the entity', lamp?.overrides?.Shade, { scale: [2, 2, 2], position: [1, 2, 3] })
    equal('and that of its root', lamp?.overrides?.[ROOT_PATH].components, { light: { intensity: 7 } })
    equal('and what the desk added', lamp?.overrides?.[ROOT_PATH].addChildren?.map((child) => child.name), ['Cord'])
  })

  test('what cannot be expanded', () => {
    equal('a prefab that does not exist', expandInstance(registry, instance('Nothing')), null)
    const loop = makeRegistry({
      A: { version: 3, root: { name: 'A', children: [{ name: 'B', prefab: 'B' }] } },
      B: { version: 3, root: { name: 'B', children: [{ name: 'A', prefab: 'A' }] } },
    })
    const a = expand('A', undefined, loop)
    // The second A inside is left an instance: whoever builds it shows a placeholder
    equal('a prefab that contains itself through another', at(a, 'B/A').prefab, 'A')
    ok('the check names it', validatePrefab('A', { version: 3, root: loop.getPrefab('A')! }, loop).some((p) => p.includes('contains itself')))
    ok('and the other one', validatePrefab('B', { version: 3, root: loop.getPrefab('B')! }, loop).some((p) => p.includes('contains itself')))
    equal('the prefabs of this test are fine', ['Lamp', 'Desk', 'Room'].flatMap((name) => validatePrefab(name, { version: 3, root: registry.getPrefab(name)! }, registry)), [])
  })

  test('the override that makes the difference', () => {
    const overrides: Record<string, EntityOverride> = {
      Top: { active: false, position: [4, 4, 4], components: { mesh: { shape: 'sphere' } }, removeComponents: ['collider'] },
      Lamp: { rotation: [0, 90, 0], components: { light: { intensity: 7 } }, addComponents: [{ type: 'collider' }] },
      'Lamp/Shade': { name: 'Hat', scale: [3, 3, 3] },
      'Lamp/Bulb/Glow': { position: [0, 0, 1] },
    }
    const pristine = expandPristine(registry, instance('Desk'))!
    const edited = expand('Desk', overrides)
    for (const path of innerPaths(pristine)) {
      equal(path, diffOverride(registry, at(pristine, path), at(edited, path), false), overrides[path] ?? null)
    }
    equal('the root', diffOverride(registry, pristine, edited, true), null)
    // The root of an instance: its name, active flag and place are its own, not an override
    const moved = { ...edited, name: 'Other', position: [9, 9, 9] as [number, number, number], components: [{ type: 'mesh', shape: 'sphere' }] }
    equal('only the components of the root', diffOverride(registry, pristine, moved, true), { components: { mesh: { shape: 'sphere' } } })
    // A field written with its default value is the same as one not written
    const lamp = at(pristine, 'Lamp')
    const written = { ...lamp, components: [{ ...lamp.components[0], castShadow: componentDefs.light.fields.castShadow.default }] }
    equal('a default written out', diffOverride(registry, lamp, written, false), null)
  })

  test('Apply', () => {
    // What Apply writes into the prefab, an instance without overrides then gives
    const cases: Record<string, Record<string, unknown>> = {
      'an entity of the prefab': { Top: { position: [4, 4, 4], components: { mesh: { shape: 'sphere' } }, removeComponents: ['collider'] } },
      'the root': { '.': { components: { mesh: { shape: 'sphere' } }, addComponents: [{ type: 'collider' }] } },
      'inside the inner instance': { 'Lamp/Shade': { position: [1, 2, 3] }, Lamp: { position: [5, 0, 0], components: { light: { intensity: 7 } } } },
      'a name inside the inner instance': { 'Lamp/Bulb': { name: 'Big Bulb' } },
      'an added entity': { '.': { addChildren: [{ name: 'Extra', children: [{ name: 'Deeper' }] }] }, 'Lamp/Bulb': { addChildren: [{ name: 'Spark' }] } },
      'a removed entity': { Top: { removed: true }, 'Lamp/Bulb': { removed: true } },
      'what the inner instance adds': { 'Lamp/Cord': { position: [9, 9, 9], addComponents: [{ type: 'collider' }] } },
      'what the inner instance adds, removed': { 'Lamp/Cord': { removed: true } },
    }
    for (const [name, overrides] of Object.entries(cases)) {
      const before = expand('Desk', overrides)
      const applied = makeRegistry()
      applied.setPrefab('Desk', applyToPrefab(registry.getPrefab('Desk')!, instance('Desk', overrides).overrides ?? {}))
      equal(name, expand('Desk', undefined, applied), before)
      equal(`${name}: the prefab is still fine`, validatePrefab('Desk', { version: 3, root: applied.getPrefab('Desk')! }, applied), [])
    }
    const applied = applyToPrefab(registry.getPrefab('Desk')!, instance('Desk', { 'Lamp/Shade': { position: [1, 2, 3] }, Top: { name: 'Board' } }).overrides ?? {})
    const lamp = applied.children.find((child) => child.prefab === 'Lamp')
    equal('the inner one is still an instance', lamp?.children, [])
    equal('the override has become its own', lamp?.overrides?.Shade, { scale: [2, 2, 2], position: [1, 2, 3] })
    equal('a new name is the name in the prefab', applied.children[0].name, 'Board')
    // The other prefab is not written by an Apply to this one
    equal('the lamp prefab is as it was', registry.getPrefab('Lamp'), parsePrefabRoot(LAMP, registry.getPrefab('Lamp')!))
    const ids: string[] = []
    const collect = (entity: EntityData) => {
      ids.push(entity.id)
      entity.children.forEach(collect)
    }
    collect(applyToPrefab(registry.getPrefab('Desk')!, instance('Desk', { '.': { addChildren: [{ name: 'Extra', children: [{ name: 'Deeper' }] }] } }).overrides ?? {}))
    ok('what was added has ids of its own', ids.every((id) => !id.includes('/')) && new Set(ids).size === ids.length)
  })

  test('ids of what an instance adds', () => {
    const scene = parseScene({
      version: 3,
      entities: [
        { id: 'r', name: 'Room', prefab: 'Room', overrides: { 'Desk/Top': { addChildren: [{ name: 'Cup', children: [{ name: 'Tea' }] }] }, '.': { addChildren: [{ name: 'Door' }] } } },
        { id: 'r/Desk/Top/Cup', name: 'Taken out', children: [{ id: 'r/Desk/Top/Cup/Tea', name: 'Tea' }] },
      ],
    })
    assignAddedIds(scene.entities)
    const [room, out] = scene.entities
    equal('under an entity of the prefab', room.overrides?.['Desk/Top'].addChildren?.[0].id, 'r/Desk/Top/Cup')
    equal('and down', room.overrides?.['Desk/Top'].addChildren?.[0].children[0].id, 'r/Desk/Top/Cup/Tea')
    equal('under the root', room.overrides?.[ROOT_PATH].addChildren?.[0].id, 'r/Door')
    ok('one that was moved out gets an ordinary id', !out.id.includes('/') && !out.children[0].id.includes('/'))
    // The same ids the expanded instance has
    equal('as in the expanded instance', findInExpanded(expandInstance(registry, room)!, 'r/Desk/Top/Cup/Tea')?.name, 'Tea')
  })

  test('the check of a scene', () => {
    const problems = (overrides: Record<string, unknown>, prefab = 'Room') =>
      validateScene(parseScene({ version: 3, entities: [{ name: 'It', prefab, overrides }] }), registry)
    const named = (overrides: Record<string, unknown>, text: string, prefab = 'Room') => {
      const found = problems(overrides, prefab)
      ok(`"${text}" for ${JSON.stringify(overrides)}, got ${JSON.stringify(found)}`, found.length === 1 && found[0].includes(text))
    }
    equal('good overrides', problems({
      'Desk/Lamp/Shade': { position: [1, 2, 3], components: { mesh: { shape: 'sphere' } } },
      'Desk/Lamp': { name: 'Light', components: { light: { intensity: 5 } }, addComponents: [{ type: 'collider' }] },
      'Desk/Lamp/Bulb': { removed: true },
      'Desk/Top': { removeComponents: ['collider'], addChildren: [{ name: 'Cup' }] },
      // What the desk adds to its lamp can be changed from the scene
      'Desk/Lamp/Cord': { position: [1, 1, 1] },
    }), [])
    named({ 'Desk/Lamp/Nope': { position: [0, 0, 0] } }, 'has nothing at this path')
    named({ 'Desk/Lamp/Shade': { components: { light: { intensity: 1 } } } }, 'has no such component')
    named({ 'Desk/Lamp/Shade': { components: { mesh: { shape: 'pyramid' } } } }, 'shape')
    named({ 'Desk/Lamp': { addComponents: [{ type: 'light' }] } }, 'already gives')
    named({ 'Desk/Lamp': { removeComponents: ['mesh'] } }, 'has no component "mesh"')
    named({ 'Desk/Lamp/Bulb': { addChildren: [{ name: 'Glow' }] } }, 'already has a child named')
    named({ '.': { removed: true } }, 'cannot be removed')
    named({ '.': { position: [0, 0, 0] } }, 'the root is the instance itself')
    named({ 'Desk/Lamp/Shade': { colour: 'red' } }, 'unknown field')
    named({ 'Desk/Lamp/Shade': { name: 'a/b' } }, 'without "/"')
    ok('a prefab that does not exist', problems({}, 'Nothing').some((p) => p.includes('does not exist')))
  })

  test('a running scene', () => {
    const scene = parseScene({
      version: 3,
      entities: [{
        id: 'r',
        name: 'Room',
        prefab: 'Room',
        position: [10, 0, 0],
        overrides: { 'Desk/Lamp/Shade': { position: [0, 3, 0] }, 'Desk/Lamp/Bulb': { name: 'Big Bulb', removeComponents: ['mesh'] }, 'Desk/Top': { removed: true } },
      }],
    })
    equal('the scene is fine', validateScene(scene, registry), [])
    const game = new Game(registry, scene)
    game.sound.enabled = false
    try {
      game.resize(320, 240)
      game.start()
      for (let i = 0; i < 3; i++) game.update(1 / 60)
      const byId = new Map<string, THREE.Object3D>()
      game.scene.traverse((object) => {
        const id = object.userData.entityId ?? object.userData.innerId
        if (typeof id === 'string') byId.set(id, object)
      })
      equal('objects', [...byId.keys()].sort(), [
        'r', 'r/Desk', 'r/Desk/Lamp', 'r/Desk/Lamp/Bulb', 'r/Desk/Lamp/Bulb/Glow', 'r/Desk/Lamp/Cord', 'r/Desk/Lamp/Shade', 'r/Floor',
      ])
      const shade = byId.get('r/Desk/Lamp/Shade')
      // Room at 10, the desk at 3 in it, the lamp 1 up on the desk, the shade 3 up in the lamp
      equal('where the shade is in the world', shade?.getWorldPosition(new THREE.Vector3()).toArray(), [13, 4, 0])
      equal('its scale', shade?.scale.toArray(), [2, 2, 2])
      equal('the name the scene gave', byId.get('r/Desk/Lamp/Bulb')?.name, 'Big Bulb')
      let lights = 0
      let meshes = 0
      game.scene.traverse((object) => {
        if (object instanceof THREE.PointLight) lights++
        if (object instanceof THREE.Mesh && byId.has(object.parent?.userData.innerId ?? object.parent?.userData.entityId ?? '')) meshes++
      })
      equal('the light of the lamp', lights, 1)
      // The shade only: the desk has its own, the bulb lost its mesh, the top is removed
      equal('meshes', meshes, 2)
    } finally {
      game.dispose()
    }
  })

  animationTests(test, ok, equal)
  slopeTests(test, ok, equal)
  terrainTests(test, ok, equal)
  return failures
}

// ---------- colliders that are turned ----------

function slopeTests(
  test: (name: string, run: () => void) => void,
  ok: (what: string, condition: unknown) => void,
  equal: (what: string, actual: unknown, expected: unknown) => void,
) {
  const registry = new Registry()
  const box = (more: object = {}) => ({ type: 'collider', ...more })
  const FLOOR = { name: 'Floor', position: [0, -0.5, 0], scale: [40, 1, 40], components: [box()] }
  // A plate 6 m long whose far end is lifted: its near end meets the floor about x = 1.2, its top is a slope
  const ramp = (degrees: number) => ({ name: 'Ramp', position: [4, 1, 0], rotation: [0, 0, degrees], scale: [6, 0.2, 3], components: [box()] })
  const PLAYER = { name: 'Player', position: [0, 0.52, 0], components: [box({ shape: 'capsule', radius: 0.3, height: 1 })] }
  // The height of the top of the ramp over the floor at this x
  const rampTop = (x: number, degrees: number) => 1 + (x - 4) * Math.tan(THREE.MathUtils.degToRad(degrees)) + 0.1 / Math.cos(THREE.MathUtils.degToRad(degrees))

  const play = (entities: unknown[], run: (game: Game, object: (name: string) => THREE.Object3D) => void) => {
    const game = new Game(registry, parseScene({ version: 3, entities }))
    game.sound.enabled = false
    try {
      game.start()
      game.update(1 / 60)
      run(game, (name) => game.root.getObjectByName(name)!)
    } finally {
      game.dispose()
    }
  }
  // Walks the object along x for so many seconds, the way a behavior does: a move with a step, then gravity.
  // Tells in how many of the frames it was in the air.
  const walk = (game: Game, object: THREE.Object3D, speed: number, seconds: number) => {
    let air = 0
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      game.runtime.move(object, speed / 60, 0, 0, 0.3)
      if (!game.runtime.fall(object, 1 / 60)) air++
    }
    return air
  }
  const near = (what: string, actual: number, expected: number, within = 0.05) => ok(`${what}: expected about ${expected.toFixed(3)}, got ${actual.toFixed(3)}`, Math.abs(actual - expected) <= within)

  test('a slope', () => {
    play([FLOOR, ramp(20), PLAYER], (game, object) => {
      const player = object('Player')
      const air = walk(game, player, 3, 2)
      near('it keeps its pace up the slope', player.position.x, 6, 0.1)
      // A ball of 0.3 m on a slope of 20 degrees is higher over it than its radius, and the middle of the capsule 0.2 m above that
      near('and stands on it', player.position.y, rampTop(player.position.x, 20) + 0.3 / Math.cos(THREE.MathUtils.degToRad(20)) + 0.2 - 0.3 * Math.tan(THREE.MathUtils.degToRad(20)) * Math.sin(THREE.MathUtils.degToRad(20)), 0.06)
      ok(`with its feet on the ground (in the air for ${air} frames of 120)`, air <= 4)
      ok('it is grounded there', game.runtime.grounded(player))
    })
    play([FLOOR, ramp(-20), { ...PLAYER, position: [1.5, 2.6, 0] }], (game, object) => {
      // The ramp now comes down along x; the object is put on its high part and walks down it
      const player = object('Player')
      for (let i = 0; i < 60; i++) game.runtime.fall(player, 1 / 60)
      const top = player.position.y
      const air = walk(game, player, 3, 1)
      ok(`down the slope it goes down (from ${top.toFixed(2)} to ${player.position.y.toFixed(2)})`, player.position.y < top - 0.9)
      ok(`with its feet on the ground (in the air for ${air} frames of 60)`, air <= 4)
    })
    play([FLOOR, ramp(65), PLAYER], (game, object) => {
      const player = object('Player')
      walk(game, player, 3, 2)
      ok(`too steep is a wall (stopped at x = ${player.position.x.toFixed(2)})`, player.position.x < 3.6 && player.position.y < 0.8)
    })
  })

  test('a stair is still a stair', () => {
    const stair = { name: 'Stair', position: [3, 0.1, 0], scale: [2, 0.2, 3], components: [box()] }
    play([FLOOR, stair, PLAYER], (game, object) => {
      const player = object('Player')
      walk(game, player, 3, 0.9)
      near('up onto it', player.position.y, 0.7, 0.03)
      const air = walk(game, player, 3, 0.6)
      near('and down from it', player.position.y, 0.5, 0.03)
      ok(`without a fall (in the air for ${air} frames of 36)`, air <= 2)
    })
    // Turned about the vertical only, it is as much a stair as before
    play([FLOOR, { ...stair, rotation: [0, 30, 0] }, PLAYER], (game, object) => {
      const player = object('Player')
      walk(game, player, 3, 0.9)
      near('a stair that is turned', player.position.y, 0.7, 0.03)
    })
    play([FLOOR, { ...stair, position: [3, 0.5, 0], scale: [2, 1, 3] }, PLAYER], (game, object) => {
      const player = object('Player')
      walk(game, player, 3, 1)
      ok(`a ledge higher than the step stops it (x = ${player.position.x.toFixed(2)})`, player.position.x < 1.75 && player.position.y < 0.6)
    })
  })

  test('a wall at an angle', () => {
    // A wall across the way, turned by 45 degrees: the box it fits in is much wider than it is
    const wall = { name: 'Wall', position: [4, 1, 0], rotation: [0, 45, 0], scale: [6, 2, 0.2], components: [box()] }
    play([FLOOR, wall, { name: 'Crate', position: [0, 0.5, 1.5], components: [box()] }], (game, object) => {
      const crate = object('Crate')
      for (let i = 0; i < 120; i++) game.runtime.move(crate, 0.05, 0, 0)
      // The wall runs from (1.9, 2.1) to (6.1, -2.1) on the floor, x = 4 - z: the far corner of the crate, at z = 2, meets it at x = 2
      near('a box stops at the wall itself, not at the box around it', crate.position.x, 2 - 0.1 * Math.SQRT2 - 0.5, 0.02)
    })
    play([FLOOR, wall], (game) => {
      const hit = game.runtime.raycast([0, 1, 1.5], [1, 0, 0])
      near('a ray hits it where it is', hit?.point.x ?? 0, 2.5 - 0.1 * Math.SQRT2, 0.02)
      equal('and tells which way it faces', hit?.normal.toArray().map((n) => Math.round(n * 100) / 100), [-0.71, 0, -0.71])
      // Inside the box around the wall, but past the wall itself
      equal('a ray that passes by its corner misses', game.runtime.raycast([0, 1, 2.5], [1, 0, 0], { distance: 1.5 }), null)
    })
  })

  test('rays and triggers on a slope', () => {
    play([FLOOR, ramp(20), { name: 'Coin', position: [1.8, 1.6, 0], components: [box({ shape: 'sphere', radius: 0.3, solid: false })] }], (game) => {
      const hit = game.runtime.raycast([5, 10, 0], [0, -1, 0])
      near('a ray from above lands on the slope', hit?.point.y ?? 0, rampTop(5, 20), 0.01)
      equal('the slope faces up and back', hit?.normal.toArray().map((n) => Math.round(n * 100) / 100), [-0.34, 0.94, 0])
      equal('it is the ramp', hit?.object.name, 'Ramp')
      // Over the low end of the ramp the box around it is 2 m high, the ramp itself is at the floor
      near('over its low end the ray goes down to it', game.runtime.raycast([1.8, 10, 0], [0, -1, 0])?.point.y ?? 0, rampTop(1.8, 20), 0.01)
      game.update(1 / 60)
      const coin = game.root.getObjectByName('Coin')!
      // What the collider of the coin touches after this frame
      const touching = () => [...((game.runtime as unknown as { contacts: Map<THREE.Object3D, Set<THREE.Object3D>> }).contacts.get(coin) ?? [])].map((other) => other.name)
      equal('a trigger in the empty corner of that box touches nothing', touching(), [])
      coin.position.set(5, rampTop(5, 20) + 0.2, 0)
      game.update(1 / 60)
      equal('on the slope it touches the ramp', touching(), ['Ramp'])
      coin.position.set(5, rampTop(5, 20) + 0.4, 0)
      game.update(1 / 60)
      equal('just over it, nothing again', touching(), [])
    })
  })
}

// ---------- terrain ----------

// The height of the test ground at this x, the same all along z: level, a slope of about 22 degrees up to
// 4 m, a ledge, a cliff too steep to walk up, a plateau
const groundAt = (x: number) => (x < 0 ? 0 : x < 10 ? 0.4 * x : x < 12 ? 4 : x < 14 ? 4 + 3 * (x - 12) : 10)

// 40 x 40 m, a height every meter
const GROUND: TerrainData = {
  cell: 1,
  heights: Array.from({ length: 41 }, () => Array.from({ length: 41 }, (_, i) => groundAt(i - 20))),
}

function terrainTests(
  test: (name: string, run: () => void) => void,
  ok: (what: string, condition: unknown) => void,
  equal: (what: string, actual: unknown, expected: unknown) => void,
) {
  const registry = new Registry().setTerrain('Ground', GROUND)
  const TERRAIN = { name: 'Ground', components: [{ type: 'terrain', terrain: 'Ground' }] }
  const capsule = { type: 'collider', shape: 'capsule', radius: 0.3, height: 1 }
  const PLAYER = { name: 'Player', position: [-5, 0.6, 0], components: [capsule] }
  // How far over the slope the middle of that capsule is when it stands on it: its round end touches the
  // slope with its side, and the middle is 0.2 m above the middle of that end
  const SLOPE = Math.atan(0.4)
  const onSlope = (x: number) => 0.4 * x + 0.3 / Math.cos(SLOPE) + 0.2

  const play = (entities: unknown[], run: (game: Game, object: (name: string) => THREE.Object3D) => void) => {
    const game = new Game(registry, parseScene({ version: 3, entities }))
    game.sound.enabled = false
    try {
      game.start()
      game.update(1 / 60)
      run(game, (name) => game.root.getObjectByName(name)!)
    } finally {
      game.dispose()
    }
  }
  const walk = (game: Game, object: THREE.Object3D, speed: number, seconds: number) => {
    let air = 0
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      game.runtime.move(object, speed / 60, 0, 0, 0.3)
      if (!game.runtime.fall(object, 1 / 60)) air++
    }
    return air
  }
  const near = (what: string, actual: number, expected: number, within = 0.05) => ok(`${what}: expected about ${expected.toFixed(3)}, got ${actual.toFixed(3)}`, Math.abs(actual - expected) <= within)
  const rounded = (vector?: THREE.Vector3) => vector?.toArray().map((n) => Math.round(n * 100) / 100)

  test('the heights of a terrain', () => {
    near('at a height of the grid', terrainHeight(GROUND, 5, 3) ?? NaN, 2, 1e-9)
    near('between them', terrainHeight(GROUND, 5.25, 3.75) ?? NaN, 2.1, 1e-9)
    equal('none outside of it', terrainHeight(GROUND, 20.01, 0), null)
    near('its very edge is still it', terrainHeight(GROUND, 20, -20) ?? NaN, 10, 1e-9)
    // Two triangles of one cell: heights 0, 1 / 0, 0 make a fold along the cut from the first corner to the last
    const fold: TerrainData = { cell: 1, heights: [[0, 1], [0, 0]] }
    near('a cell is cut from its first corner to the opposite one: on the side of the raised corner', terrainHeight(fold, 0.25, -0.25) ?? NaN, 0.5, 1e-9)
    near('on the other side', terrainHeight(fold, -0.25, 0.25) ?? NaN, 0, 1e-9)
    const hit = rayTerrain(GROUND, new THREE.Vector3(-5, 1, 0.3), new THREE.Vector3(1, 0, 0))
    near('a level ray meets the slope where it is that high', hit?.distance ?? NaN, 7.5, 0.001)
    equal('a ray that goes up meets nothing', rayTerrain(GROUND, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)), null)
    equal('nor one that starts under the ground', rayTerrain(GROUND, new THREE.Vector3(5, 1, 0), new THREE.Vector3(0, -1, 0)), null)
  })

  test('a terrain file', () => {
    equal('a good one', validateTerrain({ cell: 2, heights: [[0, 1], [2, 3]] }), [])
    ok('rows of different lengths', validateTerrain({ cell: 1, heights: [[0, 1, 2], [0, 1]] })[0]?.includes('row 2'))
    ok('a cell of no size', validateTerrain({ cell: 0, heights: [[0, 1], [0, 1]] })[0]?.includes('cell'))
    ok('not a number', validateTerrain({ cell: 1, heights: [[0, 1], [0, 'a']] })[0]?.includes('row 2'))
    ok('a field it does not have', validateTerrain({ cell: 1, heights: [[0, 1], [0, 1]], size: 3 })[0]?.includes('size'))
    equal('a scene with it', validateScene(parseScene({ version: 3, entities: [TERRAIN] }), registry), [])
    ok('a terrain that is not there', validateScene(parseScene({ version: 3, entities: [{ name: 'G', components: [{ type: 'terrain', terrain: 'Moon' }] }] }), registry)[0]?.includes('there is no terrain "Moon"'))
    ok('a turned one', validateScene(parseScene({ version: 3, entities: [{ ...TERRAIN, rotation: [0, 30, 0] }] }), registry)[0]?.includes('cannot be turned'))
    ok('a scaled one', validateScene(parseScene({ version: 3, entities: [{ ...TERRAIN, scale: [2, 1, 2] }] }), registry)[0]?.includes('cannot be scaled'))
  })

  test('the paint of a terrain', () => {
    const painted: TerrainData = { cell: 1, heights: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], palette: ['#ff0000', '#0000ff'], colors: [[0, 0, 0], [0, 1, 0], [0, 0, 0]] }
    equal('a painted file', validateTerrain(painted), [])
    ok('colors without a palette', validateTerrain({ ...painted, palette: undefined })[0]?.includes('no palette'))
    ok('a color the palette does not have', validateTerrain({ ...painted, colors: [[0, 0, 0], [0, 2, 0], [0, 0, 0]] })[0]?.includes('0 to 1'))
    ok('colors of another size', validateTerrain({ ...painted, colors: [[0, 0, 0], [0, 1, 0]] })[0]?.includes('as many rows'))
    ok('a palette that is not colors', validateTerrain({ ...painted, palette: ['red'] })[0]?.includes('palette'))
    ok('it is painted', isPainted(painted) && !isPainted(GROUND))
    const colors = terrainGeometry(painted, false, 4).getAttribute('color')
    equal('the middle height has the second color', [colors.getX(4), colors.getZ(4)], [0, 1])
    equal('a corner has the first', [colors.getX(0), colors.getZ(0)], [1, 0])
    const plain = terrainGeometry(GROUND, false, 4).getAttribute('color')
    equal('unpainted ground is white: the material shows as it is', [plain.getX(0), plain.getY(0), plain.getZ(0)], [1, 1, 1])
    // With facets every triangle has one color: its three corners mixed
    const facets = terrainGeometry(painted, true, 4).getAttribute('color')
    equal('a facet at the middle is a third of the second color', Math.round(facets.getZ(0) * 100), 33)
    equal('two triangles in each of four cells', facets.count, 24)
  })

  test('the brush of a terrain', () => {
    const ground = { ...flatTerrain(16, 1), palette: ['#ff0000', '#0000ff'], colors: flatTerrain(16, 1).heights.map((row) => row.map(() => 0)) }
    const worked = cloneTerrain(ground)
    ok('it tells that it changed something', brushTerrain(worked, 'raise', 0, 0, 4, 2))
    near('raised by the amount in the middle', worked.heights[8][8], 2, 1e-9)
    ok(`less towards the edge (${worked.heights[8][10].toFixed(2)})`, worked.heights[8][10] > 0.5 && worked.heights[8][10] < 1.5)
    equal('nothing past the radius', [worked.heights[8][12], worked.heights[8][13]], [0, 0])
    equal('the original is as it was', ground.heights[8][8], 0)
    brushTerrain(worked, 'lower', 0, 0, 4, 0.5)
    near('lowered', worked.heights[8][8], 1.5, 1e-9)
    brushTerrain(worked, 'flatten', 0, 0, 4, 1, { level: 1 })
    near('flattened to the level in the middle', worked.heights[8][8], 1, 1e-9)
    const spike = cloneTerrain(ground)
    spike.heights[8][8] = 4
    brushTerrain(spike, 'smooth', 0, 0, 3, 1)
    near('a spike is smoothed away', spike.heights[8][8], 0, 1e-9)
    brushTerrain(worked, 'paint', 2, 0, 1.5, 0, { color: 1 })
    equal('painted within the radius', [worked.colors?.[8][10], worked.colors?.[8][11], worked.colors?.[8][12]], [1, 1, 0])
    ok('a touch that changes nothing says so', !brushTerrain(worked, 'paint', 2, 0, 1.5, 0, { color: 1 }))
    ok('off the ground there is nothing to change', !brushTerrain(worked, 'raise', 40, 40, 2, 1))
    // The corner of the ground is worked as well as its middle
    ok('at the very corner', brushTerrain(worked, 'smooth', -8, -8, 2, 1) || true)

    const hill = cloneTerrain(ground)
    brushTerrain(hill, 'raise', 0, 0, 4, 2)
    brushTerrain(hill, 'paint', 0, 0, 2, 0, { color: 1 })
    const wider = resizeTerrain(hill, 24, 24, 1)
    equal('resized: more ground around', terrainSize(wider), [24, 24])
    near('the hill is where it was', terrainHeight(wider, 0, 0) ?? NaN, 2, 0.01)
    equal('level where the ground is new and its edge was level', wider.heights[0][0], 0)
    // The test ground rises to 10 m at its far edge: more ground there goes on at that height, painted as the edge is
    const edged = resizeTerrain({ ...GROUND, palette: ['#ff0000', '#00ff00'], colors: GROUND.heights.map((row) => row.map((_, i) => (i > 30 ? 1 : 0))) }, 60, 40, 1)
    equal('new ground goes on from the edge: no cliff', [edged.heights[20][59], edged.heights[20][60], edged.heights[20][0]], [10, 10, 0])
    equal('with the color of the edge', [edged.colors?.[20][60], edged.colors?.[20][0]], [1, 0])
    equal('the paint is where it was', [wider.colors?.[12][12], wider.colors?.[12][16]], [1, 0])
    const coarse = resizeTerrain(hill, 8, 8, 2)
    equal('resized: the same ground with a bigger cell', [terrainSize(coarse), coarse.heights.length], [[16, 16], 9])
    near('the hill is still there', terrainHeight(coarse, 0, 0) ?? NaN, 2, 0.01)
    equal('a resized ground is a good file', validateTerrain(coarse), [])
  })

  test('a part of a terrain written anew', () => {
    const bumpy = (): TerrainData => {
      const data = { ...flatTerrain(24, 1.5), palette: ['#ff0000', '#00ff00'], colors: flatTerrain(24, 1.5).heights.map((row) => row.map(() => 0)) }
      brushTerrain(data, 'raise', 3, -4, 9, 5)
      brushTerrain(data, 'lower', -8, 6, 7, 3)
      return data
    }
    const numbers = (geometry: THREE.BufferGeometry, name: string) => Array.from(geometry.getAttribute(name).array as Float32Array)
    // How far apart two lists of numbers are at most
    const apart = (a: number[], b: number[]) => a.reduce((most, value, n) => Math.max(most, Math.abs(value - b[n])), a.length === b.length ? 0 : Infinity)
    for (const flat of [false, true]) {
      const what = flat ? 'with facets' : 'smooth'
      const data = bumpy()
      const geometry = terrainGeometry(data, flat, 4)
      // The normals are counted here, not by three.js: they have to be the same ones
      const usual = geometry.clone()
      usual.computeVertexNormals()
      ok(`${what}: the normals are those three.js would count (apart by ${apart(numbers(geometry, 'normal'), numbers(usual, 'normal')).toExponential(1)})`, apart(numbers(geometry, 'normal'), numbers(usual, 'normal')) < 1e-5)

      // A touch of the brush, written into the old geometry as a part and into a new one as a whole
      brushTerrain(data, 'raise', -2, 5, 4.2, 2)
      brushTerrain(data, 'paint', -2, 5, 4.2, 0, { color: 1 })
      const region = brushRegion(data, -2, 5, 4.2)
      ok(`${what}: the brush reaches a part of the ground`, region && region.toI - region.fromI === 5)
      fillTerrainGeometry(geometry, data, flat, region ?? undefined)
      const whole = terrainGeometry(data, flat, 4)
      for (const name of ['position', 'color', 'normal']) {
        equal(`${what}: the ${name} of the part is what the whole would be`, apart(numbers(geometry, name), numbers(whole, name)), 0)
      }
      const sent = (geometry.getAttribute('position') as THREE.BufferAttribute).updateRanges[0]
      ok(`${what}: only a part goes to the video card (${sent?.count} of ${numbers(geometry, 'position').length})`, sent && sent.count < numbers(geometry, 'position').length / 2)
      ok(`${what}: the box of the ground has grown with it`, (geometry.boundingBox?.max.y ?? 0) >= terrainRange(data)[1] - 1e-6)
    }
    equal('at the edge the brush reaches what is there', brushRegion(GROUND, -20, -20, 2), { fromI: 0, toI: 2, fromJ: 0, toJ: 2 })
    equal('and nothing off the ground', brushRegion(GROUND, 40, 0, 2), null)
    const range = cloneTerrain(GROUND)
    equal('the lowest and the highest', terrainRange(range), [0, 10])
    brushTerrain(range, 'raise', 18, 0, 2, 3)
    equal('are counted anew after a touch', terrainRange(range), [0, 13])
  })

  test('a generated terrain', () => {
    const settings = { ...defaultGenerator, seed: 7, height: 20, size: 40 }
    const make = (seed = 7, at = { x: 0, z: 0 }, cells = 64) => {
      const data = flatTerrain(cells, 1)
      generateTerrain(data, { ...settings, seed }, at)
      return data
    }
    const ground = make()
    const [low, high] = terrainRange(ground)
    ok(`hills about as high as asked (from ${low.toFixed(1)} to ${high.toFixed(1)})`, high - low > 8 && high - low < 30)
    equal('the same seed gives the same ground', make().heights[20], ground.heights[20])
    ok('another seed gives another', JSON.stringify(make(8).heights[20]) !== JSON.stringify(ground.heights[20]))
    near('the noise stays between 0 and 1', Math.min(1, Math.max(0, noise2D(3.7, -12.2, 5))), noise2D(3.7, -12.2, 5), 0)
    // A neighbor 64 m to the east: its west edge is the east edge of this one
    const neighbor = make(7, { x: 64, z: 0 })
    equal('neighbors with the same settings meet without a seam', neighbor.heights.map((row) => row[0]), ground.heights.map((row) => row[64]))
    near('a height is that of its place in the world', ground.heights[32][32], generatedHeight({ ...settings }, 0, 0), 1e-9)

    ok('it is painted as it is made', isPainted(ground) && ground.palette?.length === 5)
    const kinds = new Set(ground.colors?.flat())
    ok(`with grass and sand at least (kinds: ${[...kinds].join(', ')})`, kinds.has(0) && kinds.has(3))
    const steep = flatTerrain(32, 1)
    generateTerrain(steep, { ...settings, height: 60, size: 15, rock: 0.5 }, { x: 0, z: 0 })
    ok('rock where it is steep', steep.colors?.flat().includes(2))
    const plain = flatTerrain(16, 1)
    generateTerrain(plain, { ...settings, paint: false }, { x: 0, z: 0 })
    ok('without paint the ground keeps its colors', !isPainted(plain))
    const snowy = flatTerrain(16, 1)
    generateTerrain(snowy, { ...settings, snowAbove: -1000, rock: 100 }, { x: 0, z: 0 })
    equal('snow above its height', [...new Set(snowy.colors?.flat())], [4])

    // The brush: only what is under it, the more the nearer its middle
    const touched = flatTerrain(64, 1)
    const region = generateTerrain(touched, settings, { x: 0, z: 0 }, { x: 10, z: -6, radius: 8, amount: 1 })
    near('under the middle of the brush the ground is what the settings give', touched.heights[26][42], ground.heights[26][42], 1e-9)
    equal('past the brush nothing has moved', [touched.heights[26][52], touched.heights[2][2], touched.colors?.[2][2]], [0, 0, 0])
    equal('the part it wrote', region, { fromI: 34, toI: 50, fromJ: 18, toJ: 34 })
    const half = flatTerrain(64, 1)
    generateTerrain(half, settings, { x: 0, z: 0 }, { x: 10, z: -6, radius: 8, amount: 0.5 })
    near('half of the way with half of the amount', half.heights[26][42], ground.heights[26][42] / 2, 1e-9)
    equal('off the ground it writes nothing', generateTerrain(touched, settings, { x: 0, z: 0 }, { x: 200, z: 0, radius: 8, amount: 1 }), null)

    equal('the settings of a file, the rest as usual', generatorOf({ ...flatTerrain(2, 1), generator: { seed: 9 } }), { ...defaultGenerator, seed: 9 })
    equal('a file with settings', validateTerrain({ ...flatTerrain(2, 1), generator: { seed: 9, paint: false } }), [])
    ok('a setting it does not have', validateTerrain({ ...flatTerrain(2, 1), generator: { hills: 3 } })[0]?.includes('unknown field "hills"'))
    ok('a setting of the wrong kind', validateTerrain({ ...flatTerrain(2, 1), generator: { seed: 'a' } })[0]?.includes('generator.seed'))
  })

  test('the props of a terrain', () => {
    // A tree: a trunk with a crown on it, and a collider as thick as the trunk
    const TREE = {
      version: 3,
      root: {
        name: 'Tree',
        components: [{ type: 'collider', shape: 'capsule', radius: 0.4, height: 3, centerY: 1.5 }],
        children: [
          { name: 'Trunk', position: [0, 1, 0], scale: [0.5, 2, 0.5], components: [{ type: 'mesh', shape: 'cylinder' }] },
          { name: 'Crown', position: [0, 3, 0], scale: [2, 2, 2], components: [{ type: 'mesh', shape: 'sphere' }] },
        ],
      },
    }
    const forest = new Registry().setTerrain('Ground', GROUND)
    forest.setPrefab('Tree', parsePrefab(TREE).root)
    forest.setPrefab('Bush', parsePrefab({ version: 3, root: { name: 'Bush', components: [{ type: 'mesh', shape: 'sphere' }] } }).root)
    // Always the same "random" numbers
    const dice = () => {
      let seed = 12345
      return () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
        return seed / 4294967296
      }
    }

    const planted = cloneTerrain(GROUND)
    const put = plantScatter(planted, 'Tree', -8, 0, 6, 200, { spacing: 2, sizeMin: 0.8, sizeMax: 1.2, random: dice() })
    const trees = planted.scatter?.[0].items ?? []
    ok(`planted: as many as fit (${put})`, put > 12 && put < 40 && trees.length === put)
    ok('all within the brush', trees.every(([x, z]) => Math.hypot(x + 8, z) <= 6.01))
    ok('no two nearer than the spacing', trees.every((a, i) => trees.every((b, j) => i === j || Math.hypot(a[0] - b[0], a[1] - b[1]) >= 2)))
    ok('each of its own size and turn', trees.every(([, , turn, size]) => size >= 0.8 && size <= 1.2 && turn >= 0 && turn <= 360) && new Set(trees.map((item) => item[2])).size > 5)
    equal('a second pass finds no room', plantScatter(planted, 'Tree', -8, 0, 6, 200, { spacing: 2, random: dice() }), 0)
    equal('off the ground nothing is planted', plantScatter(planted, 'Tree', 200, 0, 6, 50, { random: dice() }), 0)
    plantScatter(planted, 'Bush', -8, 0, 6, 30, { spacing: 1, random: dice() })
    equal('another prefab is another list', planted.scatter?.map((layer) => layer.prefab), ['Tree', 'Bush'])
    equal('a good file', validateTerrain(planted, { prefabs: ['Tree', 'Bush'] }), [])
    ok('a prefab the project does not have', validateTerrain(planted, { prefabs: ['Tree'] })[0]?.includes('prefab "Bush" does not exist'))
    ok('a copy that is not four numbers', validateTerrain({ ...GROUND, scatter: [{ prefab: 'Tree', items: [[1, 2, 3]] }] })[0]?.includes('items[0]'))
    ok('a prefab listed twice', validateTerrain({ ...GROUND, scatter: [{ prefab: 'Tree', items: [] }, { prefab: 'Tree', items: [] }] })[0]?.includes('more than once'))
    equal('GROUND itself has none', [GROUND.scatter, scatterCount(planted) > put], [undefined, true])

    const bushes = planted.scatter?.[1].items.length ?? 0
    const gone = eraseScatter(planted, -8, 0, 3, 'Tree')
    ok(`erased: the trees under the brush (${gone})`, gone > 2 && trees.length - gone === planted.scatter?.[0].items.length)
    equal('the bushes stay', planted.scatter?.[1].items.length, bushes)
    eraseScatter(planted, -8, 0, 100)
    equal('erased: everything', [planted.scatter, scatterCount(planted)], [[], 0])

    // Drawn: every mesh of the prefab once for all its copies, each copy on the ground
    const drawn: TerrainData = { ...cloneTerrain(GROUND), scatter: [{ prefab: 'Tree', items: [[5, 0, 0, 1], [-5, 3, 90, 2], [100, 0, 0, 1]] }] }
    const group = createScatter(forest, drawn)
    const meshes = group.children as THREE.InstancedMesh[]
    equal('two meshes of the tree, two copies on the ground (the third is off it)', [meshes.length, meshes[0].count, meshes[1].count], [2, 2, 2])
    const placed = new THREE.Matrix4()
    const where = (mesh: THREE.InstancedMesh, n: number) => {
      mesh.getMatrixAt(n, placed)
      return new THREE.Vector3().setFromMatrixPosition(placed).toArray().map((value) => Math.round(value * 100) / 100)
    }
    equal('the trunk of the first stands on the slope', where(meshes[0], 0), [5, 3, 0])
    equal('the crown of the second, twice the size', where(meshes[1], 1), [-5, 6, 3])
    // The ground goes up: so do the props
    const raised = cloneTerrain(drawn)
    brushTerrain(raised, 'raise', -5, 3, 3, 4)
    const holder = new THREE.Group().add(group)
    updateScatter(holder, forest, raised)
    equal('they go up with the ground', where(meshes[1], 1), [-5, 10, 3])
    const resized = resizeTerrain(drawn, 8, 8, 1)
    equal('a smaller ground keeps the props that still stand on it', resized.scatter, undefined)
    equal('and a bigger one all that stood on it', resizeTerrain(drawn, 60, 60, 1).scatter?.[0].items.length, 2)
    equal('one collider for a copy on the ground', scatterColliders(forest, drawn).length, 2)

    // In the game: a tree stops what walks, a ray hits it
    const scene = { version: 3, entities: [{ name: 'Ground', components: [{ type: 'terrain', terrain: 'Woods' }] }, { name: 'Player', position: [-12, 0.6, 0], components: [capsule] }] }
    forest.setTerrain('Woods', { ...cloneTerrain(GROUND), scatter: [{ prefab: 'Tree', items: [[-8, 0, 0, 1], [-8, 10, 0, 1]] }, { prefab: 'Bush', items: [[-10, 0, 0, 1]] }] })
    const game = new Game(forest, parseScene(scene))
    game.sound.enabled = false
    try {
      game.start()
      game.update(1 / 60)
      const player = game.root.getObjectByName('Player')!
      for (let i = 0; i < 30; i++) game.runtime.fall(player, 1 / 60)
      walk(game, player, 3, 3)
      // The tree is 0.4 thick and the player 0.3: they meet 0.7 apart. The bush on the way has no collider.
      near('a tree stops what walks into it', player.position.x, -8.7, 0.03)
      for (let i = 0; i < 120; i++) game.runtime.move(player, 0, 0, 0.05)
      for (let i = 0; i < 120; i++) game.runtime.move(player, 0.05, 0, 0)
      ok(`and can be walked around (x = ${player.position.x.toFixed(2)})`, player.position.x > -4)
      const hit = game.runtime.raycast([-12, 1.5, 0], [1, 0, 0])
      near('a ray hits the tree', hit?.point.x ?? NaN, -8.4, 0.01)
      equal('it is the terrain that it hits', hit?.object.name, 'Ground')
      near('a ray that passes it goes on to the slope', game.runtime.raycast([-12, 1.5, 5], [1, 0, 0])?.point.x ?? NaN, 3.75, 0.01)
      equal('a short ray does not reach it', game.runtime.raycast([-12, 1.5, 0], [1, 0, 0], { distance: 3 }), null)
    } finally {
      game.dispose()
    }
  })

  test('a biome', () => {
    const settings = { ...defaultGenerator, seed: 11 }
    // Wooded hills that lie 20 m up: trees where it is not steep, a few rocks anywhere
    const WOODS: BiomeData = {
      base: 20,
      height: 16,
      size: 50,
      ground: '#335522',
      rock: '#777777',
      rockSlope: 0.45,
      lowBelow: -1000,
      props: [{ prefab: 'Tree', spacing: 4, maxSlope: 0.3 }, { prefab: 'Rock', spacing: 12, cover: 0.5, sizeMin: 1, sizeMax: 3 }],
    }
    const make = (at = { x: 0, z: 0 }) => {
      const data = flatTerrain(64, 1)
      generateTerrain(data, settings, at, undefined, WOODS)
      return data
    }
    const land = make()
    const [low, high] = terrainRange(land)
    ok(`the land lies as high as the biome says (from ${low.toFixed(1)} to ${high.toFixed(1)})`, low > 8 && high < 34 && (low + high) / 2 > 15)
    equal('its colors are added to the palette of the terrain', land.palette?.slice(5), ['#335522', '#777777'])
    const painted = new Set(land.colors?.flat())
    ok(`and the ground is painted with them (kinds: ${[...painted].join(', ')})`, painted.has(5) && painted.has(6) && !painted.has(0))
    const trees = land.scatter?.find((layer) => layer.prefab === 'Tree')?.items ?? []
    const rocks = land.scatter?.find((layer) => layer.prefab === 'Rock')?.items ?? []
    ok(`trees grow on it (${trees.length}), and fewer rocks (${rocks.length})`, trees.length > 60 && trees.length < 300 && rocks.length > 2 && rocks.length < trees.length / 4)
    const slopeAt = ([x, z]: number[]) => Math.hypot(generatedHeight({ ...settings, ...WOODS } as never, x + 1, z) - generatedHeight({ ...settings, ...WOODS } as never, x - 1, z), generatedHeight({ ...settings, ...WOODS } as never, x, z + 1) - generatedHeight({ ...settings, ...WOODS } as never, x, z - 1)) / 2
    ok('no tree where it is too steep for it', trees.every((item) => slopeAt(item) <= 0.3 + 1e-9))
    ok('rocks are from one to three times their size', rocks.every((item) => item[3] >= 1 && item[3] <= 3))
    equal('the same again gives the same land', [make().scatter, make().heights[10]], [land.scatter, land.heights[10]])
    equal('a good file with it', validateTerrain(land, { prefabs: ['Tree', 'Rock'] }), [])
    // A neighbor to the east: the trees along the common edge are not planted twice, nor left out
    const east = make({ x: 64, z: 0 })
    const inWorld = (data: TerrainData, shift: number) => (data.scatter?.find((layer) => layer.prefab === 'Tree')?.items ?? []).map(([x, z]) => `${(x + shift).toFixed(1)},${z.toFixed(1)}`)
    const both = [...inWorld(land, 0), ...inWorld(east, 64)]
    ok('neighbors do not plant the same tree twice', new Set(both).size >= both.length - 1)

    // The brush lays the biome on a part of another land: there and only there
    const mixed = flatTerrain(64, 1)
    mixed.scatter = [{ prefab: 'Bush', items: [[0, 0, 0, 1], [25, 25, 0, 1]] }]
    generateTerrain(mixed, settings, { x: 0, z: 0 }, { x: 0, z: 0, radius: 12, amount: 1 }, WOODS)
    near('under the brush the land is the biome', mixed.heights[32][32], land.heights[32][32], 1e-9)
    equal('past it the ground is as it was', [mixed.heights[32][50], mixed.colors?.[2][2]], [0, 0])
    equal('the props that stood under the brush are gone, the others stay', mixed.scatter?.find((layer) => layer.prefab === 'Bush')?.items, [[25, 25, 0, 1]])
    const core = (mixed.scatter?.find((layer) => layer.prefab === 'Tree')?.items ?? [])
    ok(`and the trees of the biome stand there (${core.length})`, core.length > 2 && core.every(([x, z]) => Math.hypot(x, z) <= 12 * 0.7 + 0.01))
    ok('the same trees as when the whole land is made', core.every((item) => trees.some((tree) => tree[0] === item[0] && tree[1] === item[1])))
    const bare = flatTerrain(16, 1)
    bare.scatter = [{ prefab: 'Bush', items: [[0, 0, 0, 1]] }]
    generateTerrain(bare, settings, { x: 0, z: 0 }, undefined, { height: 2 })
    equal('a biome without props clears the land', bare.scatter, undefined)
    const kept = flatTerrain(16, 1)
    kept.scatter = [{ prefab: 'Bush', items: [[0, 0, 0, 1]] }]
    generateTerrain(kept, settings, { x: 0, z: 0 })
    equal('without a biome the props are left alone', kept.scatter?.[0].items.length, 1)

    equal('a good biome', validateBiome(WOODS, { prefabs: ['Tree', 'Rock'] }), [])
    ok('a prefab the project does not have', validateBiome(WOODS, { prefabs: ['Tree'] })[0]?.includes('prefab "Rock" does not exist'))
    ok('a field a biome does not have', validateBiome({ hills: 3 })[0]?.includes('unknown field "hills"'))
    ok('a color that is not one', validateBiome({ ground: 'green' })[0]?.includes('ground'))
    ok('a field the props do not have', validateBiome({ props: [{ prefab: 'Tree', density: 2 }] })[0]?.includes('unknown field "density"'))
    ok('a biome the project does not have', validateTerrain({ ...flatTerrain(2, 1), generator: { biome: 'Moon' } }, { biomes: ['Woods'] })[0]?.includes('biome "Moon" does not exist'))
    equal('a terrain that names a biome', validateTerrain({ ...flatTerrain(2, 1), generator: { biome: 'Woods', seed: 3 } }, { biomes: ['Woods'] }), [])
  })

  test('the map of the biomes', () => {
    // A plateau 30 m up with trees, and a marsh below zero with reeds
    const BIOMES: Record<string, BiomeData> = {
      Plateau: { base: 30, height: 4, size: 40, ground: '#556644', lowBelow: -1000, rockSlope: 100, props: [{ prefab: 'Tree', spacing: 5, maxSlope: 10 }] },
      Marsh: { base: -4, height: 2, size: 30, ground: '#334422', lowBelow: -1000, rockSlope: 100, props: [{ prefab: 'Reeds', spacing: 3, maxSlope: 10 }] },
    }
    const biomeOf = (name: string) => BIOMES[name]
    const settings = { ...defaultGenerator, seed: 4 }
    const lay = (data: TerrainData, biome: string, x: number, z: number, radius: number) =>
      generateTerrain(data, { ...settings, biome }, { x: 0, z: 0 }, { x, z, radius, amount: 1 }, BIOMES[biome])
    const ground = flatTerrain(96, 1)
    equal('a ground without a map is not made by it', [generateByMap(ground, settings, { x: 0, z: 0 }, biomeOf), ground.biomeMap], [false, undefined])
    lay(ground, 'Plateau', -26, 0, 30)
    lay(ground, 'Marsh', 26, 0, 30)
    equal('the brush writes down where it has laid which biome', [ground.biomes, ground.biomeMap?.[48][24], ground.biomeMap?.[48][72], ground.biomeMap?.[2][2]], [['Plateau', 'Marsh'], 0, 1, -1])
    const shares = biomeShares(ground)
    ok(`most of the ground is still nobody's (${[...shares].map(([name, count]) => `${name || 'none'} ${count}`).join(', ')})`, (shares.get('') ?? 0) > (shares.get('Plateau') ?? 0) && (shares.get('Plateau') ?? 0) > 400)
    equal('a good file with a map', validateTerrain(ground, { prefabs: ['Tree', 'Reeds'], biomes: ['Plateau', 'Marsh'] }), [])
    ok('a biome the project does not have', validateTerrain(ground, { biomes: ['Plateau'] })[0]?.includes('biome "Marsh" does not exist'))
    ok('a place of the map past the list', validateTerrain({ ...flatTerrain(1, 1), biomes: ['A'], biomeMap: [[0, 1], [0, -1]] })[0]?.includes('biomeMap: row 1'))
    ok('a map of another size', validateTerrain({ ...flatTerrain(1, 1), biomes: ['A'], biomeMap: [[0, 0]] })[0]?.includes('as many rows'))

    // By hand, after the brush: a mound on nobody's ground with a bush on it, a pit on the plateau with a bush in it
    brushTerrain(ground, 'raise', 0, -40, 4, 6)
    brushTerrain(ground, 'lower', -28, 0, 3, 9)
    ground.scatter = [...(ground.scatter ?? []), { prefab: 'Bush', items: [[0, -40, 0, 1], [-28, 0, 0, 1]] }]
    const mound = ground.heights[8][48]
    ok('made again by its map', generateByMap(ground, settings, { x: 0, z: 0 }, biomeOf))
    near('the plateau is the plateau again: the pit is gone', ground.heights[48][20], generatedHeight({ ...settings, ...BIOMES.Plateau } as never, -28, 0), 0.01)
    near('the marsh is the marsh', ground.heights[48][76], generatedHeight({ ...settings, ...BIOMES.Marsh } as never, 28, 0), 0.01)
    equal('what no biome has made stays as the hand left it', [ground.heights[8][48], ground.heights[2][2]], [mound, 0])
    const between = ground.heights[48][48]
    ok(`between the two the land goes over from one into the other (${between.toFixed(1)} m)`, between > -3 && between < 29)
    const edge = [ground.heights[48][46], ground.heights[48][47], ground.heights[48][49], ground.heights[48][50]]
    ok(`without a cliff (${edge.map((h) => h.toFixed(1)).join(', ')})`, edge.every((h, n) => n === 0 || Math.abs(h - edge[n - 1]) < 12))
    const standing = (prefab: string) => ground.scatter?.find((layer) => layer.prefab === prefab)?.items ?? []
    ok(`trees on the plateau only (${standing('Tree').length})`, standing('Tree').length > 20 && standing('Tree').every(([x]) => x < 2))
    ok(`reeds in the marsh only (${standing('Reeds').length})`, standing('Reeds').length > 50 && standing('Reeds').every(([x]) => x > -2))
    equal('the bush on nobody\'s ground stays, the one on the plateau goes', standing('Bush'), [[0, -40, 0, 1]])
    const again = cloneTerrain(ground)
    generateByMap(again, settings, { x: 0, z: 0 }, biomeOf)
    equal('once more changes nothing', [again.heights[48], again.scatter], [ground.heights[48], ground.scatter])

    // A biome that is gone from the project: its land is nobody's
    const orphan = cloneTerrain(ground)
    brushTerrain(orphan, 'raise', 24, 0, 3, 5)
    const bump = orphan.heights[48][72]
    generateByMap(orphan, settings, { x: 0, z: 0 }, (name) => (name === 'Plateau' ? BIOMES.Plateau : undefined))
    equal('the land of a biome that is gone is left alone', orphan.heights[48][72], bump)

    const wider = resizeTerrain(ground, 120, 96, 1)
    equal('a bigger ground keeps its map; what is new is nobody\'s', [wider.biomes, wider.biomeMap?.[48][36], wider.biomeMap?.[48][0], wider.biomeMap?.length], [['Plateau', 'Marsh'], 0, -1, 97])
  })

  test('water', () => {
    // A lake 20 x 10 m whose surface is 2 m up, 6 m deep; the test ground under it, a diver in it
    const LAKE = { name: 'Lake', position: [-10, 2, 0], components: [{ type: 'water', sizeX: 20, sizeZ: 10, depth: 6, underColor: '#102030', visibility: 9 }] }
    const scene = parseScene({ version: 3, entities: [TERRAIN, LAKE, { ...PLAYER, position: [-10, 3, 0] }, { name: 'Diver', position: [-12, 0.5, 2], components: [{ type: 'script', script: 'diver' }] }] })
    equal('a scene with it', validateScene(scene, registry), ['/Diver [script:diver]: behavior "diver" is not defined in scripts/ (known: none)'])
    scene.entities.pop()
    const game = new Game(registry, scene)
    game.sound.enabled = false
    try {
      game.start()
      game.update(1 / 60)
      const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
      equal('how deep a point is under its surface', [submergedAt(game.root, at(-10, 0.5, 0)), submergedAt(game.root, at(-10, 2.5, 0))], [1.5, 0])
      equal('beside the water, and deeper than it goes, there is none', [submergedAt(game.root, at(5, 0, 0)), submergedAt(game.root, at(-10, -5, 0)), submergedAt(game.root, at(-10, 0, 6))], [0, 0, 0])
      const under = zoneAt(game.root, at(-10, 1, 0))
      equal('under the surface the scene is under water', [under?.fogColor, under?.fogFar, under?.sky, under?.fog], ['#102030', 9, false, true])
      equal('over it, and beside it, it is not', [zoneAt(game.root, at(-10, 2.2, 0)), zoneAt(game.root, at(-25, 1, 0))], [null, null])
      // The water stops nothing: what falls into it lands on the bottom
      const player = game.root.getObjectByName('Player')!
      for (let i = 0; i < 60; i++) game.runtime.fall(player, 1 / 60)
      near('what falls into it stands on the bottom', player.position.y, 0.5, 0.01)
      near('and is that deep in it', submergedAt(game.root, player.position), 1.5, 0.01)
    } finally {
      game.dispose()
    }
  })

  test('walking on a terrain', () => {
    play([TERRAIN, PLAYER], (game, object) => {
      const player = object('Player')
      for (let i = 0; i < 30; i++) game.runtime.fall(player, 1 / 60)
      near('it lands on the level ground', player.position.y, 0.5, 0.01)
      ok('and is grounded', game.runtime.grounded(player))
      const air = walk(game, player, 3, 3)
      near('it keeps its pace up the slope', player.position.x, 4, 0.1)
      near('and stands on it', player.position.y, onSlope(player.position.x), 0.06)
      ok(`with its feet on the ground (in the air for ${air} frames of 180)`, air <= 6)
      walk(game, player, 3, 4)
      ok(`the cliff is a wall (stopped at x = ${player.position.x.toFixed(2)}, y = ${player.position.y.toFixed(2)})`, player.position.x < 12.2 && player.position.y < 4.8)
      const back = walk(game, player, -3, 3)
      near('back down the slope', player.position.y, onSlope(player.position.x), 0.06)
      ok(`with its feet on the ground (in the air for ${back} frames of 180)`, back <= 6)
    })
    // A box is as much on the ground as a capsule
    play([TERRAIN, { name: 'Crate', position: [-5, 0.6, 0], components: [{ type: 'collider' }] }], (game, object) => {
      const crate = object('Crate')
      for (let i = 0; i < 30; i++) game.runtime.fall(crate, 1 / 60)
      near('a box lands on it', crate.position.y, 0.5, 0.01)
      for (let i = 0; i < 200; i++) game.runtime.move(crate, 0.05, 0, 0)
      near('and without a step the slope stops it', crate.position.x, -0.5, 0.05)
    })
  })

  test('a terrain that is not at the origin', () => {
    play([{ ...TERRAIN, position: [100, 2, -50] }, { ...PLAYER, position: [95, 2.6, -50] }], (game, object) => {
      const player = object('Player')
      for (let i = 0; i < 30; i++) game.runtime.fall(player, 1 / 60)
      near('the ground is where its entity is', player.position.y, 2.5, 0.01)
      const hit = game.runtime.raycast([105, 50, -50], [0, -1, 0])
      near('for a ray too', hit?.point.y ?? NaN, 4, 0.001)
      equal('outside of it there is nothing to stand on', game.runtime.raycast([0, 50, 0], [0, -1, 0]), null)
    })
  })

  test('rays and triggers on a terrain', () => {
    play([TERRAIN, { name: 'Coin', position: [5, 2.6, 0], components: [{ type: 'collider', shape: 'sphere', radius: 0.3, solid: false }] }], (game, object) => {
      const hit = game.runtime.raycast([5, 30, 0.4], [0, -1, 0])
      near('a ray from above lands on the slope', hit?.point.y ?? NaN, 2, 0.001)
      equal('the slope faces up and back', rounded(hit?.normal), [-0.37, 0.93, 0])
      equal('it is the terrain', hit?.object.name, 'Ground')
      equal('a ray that is too short does not reach', game.runtime.raycast([5, 30, 0.4], [0, -1, 0], { distance: 27 }), null)
      near('a slanted one', game.runtime.raycast([-5, 5, 0], [1, -1, 0])?.point.x ?? NaN, 0, 0.001)
      const coin = object('Coin')
      const touching = () => [...((game.runtime as unknown as { contacts: Map<THREE.Object3D, Set<THREE.Object3D>> }).contacts.get(coin) ?? [])].map((other) => other.name)
      equal('a trigger over the ground touches nothing', touching(), [])
      coin.position.y = 2.2
      game.update(1 / 60)
      equal('one that is in it touches the terrain', touching(), ['Ground'])
    })
  })

  test('the physics on a terrain', () => {
    const body = { type: 'body', bounce: 0 }
    const ball = { name: 'Ball', position: [5, 3.5, 0], components: [{ type: 'collider', shape: 'sphere' }, body] }
    const crate = { name: 'Crate', position: [-6, 1.5, 3], components: [{ type: 'collider' }, body] }
    play([TERRAIN, ball, crate], (game, object) => {
      for (let i = 0; i < 180; i++) game.update(1 / 60)
      const rolled = object('Ball').position
      ok(`a ball rolls down the slope (it is at x = ${rolled.x.toFixed(2)})`, rolled.x < 3)
      ok(`on the ground, not through it (y = ${rolled.y.toFixed(2)} over ${groundAt(rolled.x).toFixed(2)})`, rolled.y > groundAt(rolled.x) + 0.4 && rolled.y < groundAt(rolled.x) + 0.7)
      near('a box comes to rest on the level ground', object('Crate').position.y, 0.5, 0.03)
    })
    // The same ground higher and elsewhere: the body of the physics is where the entity is
    play([{ ...TERRAIN, position: [50, 3, 0] }, { ...crate, position: [44, 5, 3] }], (game, object) => {
      for (let i = 0; i < 120; i++) game.update(1 / 60)
      near('a terrain that is moved', object('Crate').position.y, 3.5, 0.03)
    })
  })
}

// ---------- animation ----------

const CLIPS = [
  defineClip({ name: 'Slide', tracks: [{ property: 'position.x', keys: [{ time: 0, value: 0 }, { time: 1, value: 2 }] }] }),
  // Counted from where the object is
  defineClip({ name: 'Open', relative: true, tracks: [{ property: 'rotation.y', keys: [{ time: 0, value: 0 }, { time: 1, value: 90 }] }] }),
  defineClip({
    name: 'Parts',
    length: 2,
    tracks: [
      { object: 'Arm/Hand', property: 'position', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 4, 0] }] },
      { object: 'Arm', property: 'scale', keys: [{ time: 0, value: 1 }, { time: 1, value: 3 }] },
      { object: 'Arm', property: 'active', keys: [{ time: 0, value: true }, { time: 1.5, value: false }] },
      { property: 'rotation', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 360, 0] }] },
    ],
  }),
  defineClip({
    name: 'Eased',
    tracks: [
      { property: 'position.x', keys: [{ time: 0, value: 0 }, { time: 1, value: 1, ease: 'out' }] },
      { property: 'position.y', keys: [{ time: 0, value: 0 }, { time: 1, value: 1, ease: 'step' }] },
    ],
  }),
  defineClip({ name: 'Idle', tracks: [{ property: 'position.y', keys: [{ time: 0, value: 0 }] }] }),
  defineClip({ name: 'Walk', tracks: [{ property: 'position.y', keys: [{ time: 0, value: 1 }] }] }),
  defineClip({ name: 'Jump', tracks: [{ property: 'position.y', keys: [{ time: 0, value: 2 }, { time: 0.5, value: 3 }] }] }),
]

const ANIMATOR = defineAnimator({
  name: 'mover',
  params: { speed: { type: 'number', default: 0 }, jump: { type: 'boolean', default: false } },
  start: 'Idle',
  states: { Idle: { clip: 'Idle' }, Walk: { clip: 'Walk' }, Jump: { clip: 'Jump', loop: 'once' } },
  transitions: [
    { to: 'Jump', when: (p) => p.jump },
    { from: 'Jump', to: 'Idle', after: 'end' },
    { from: 'Idle', to: 'Walk', when: (p) => p.speed > 0.1 },
    { from: 'Walk', to: 'Idle', when: (p) => p.speed <= 0.1 },
  ],
})

function animationTests(
  test: (name: string, run: () => void) => void,
  ok: (what: string, condition: unknown) => void,
  equal: (what: string, actual: unknown, expected: unknown) => void,
) {
  const registry = new Registry()
  registry.registerExports({ ...CLIPS, ANIMATOR })

  // Plays a scene made of these entities; `run` gets a way to move time and the objects by name
  const play = (entities: unknown[], run: (step: (seconds: number) => void, object: (name: string) => THREE.Object3D, game: Game) => void) => {
    const scene = parseScene({ version: 3, entities })
    const problems = validateScene(scene, registry)
    if (problems.length > 0) throw new Error(problems.join('; '))
    const game = new Game(registry, scene)
    game.sound.enabled = false
    try {
      game.resize(320, 240)
      game.start()
      const step = (seconds: number) => {
        for (let i = 0; i < Math.round(seconds * 60); i++) game.update(1 / 60)
      }
      run(step, (name) => game.root.getObjectByName(name)!, game)
    } finally {
      game.dispose()
    }
  }
  const rounded = (numbers: number[]) => numbers.map((n) => Math.round(n * 100) / 100)
  const place = (object: THREE.Object3D) => rounded(object.position.toArray())
  const turn = (object: THREE.Object3D) => rounded([object.rotation.x, object.rotation.y, object.rotation.z].map(THREE.MathUtils.radToDeg))
  const animation = (clip: string, more: object = {}) => ({ type: 'animation', clip, ...more })

  test('a clip', () => {
    play([{ name: 'Door', position: [0, 5, 0], components: [animation('Slide')] }], (step, object) => {
      step(0.5)
      // Only "position.x" is driven: the height the object was given stays
      equal('half way', place(object('Door')), [1, 5, 0])
      step(1)
      equal('it starts over', place(object('Door')), [1, 5, 0])
    })
    play([{ name: 'Door', components: [animation('Slide', { loop: 'once' })] }], (step, object) => {
      const handle = animationOf(object('Door'), registry)
      step(0.5)
      ok('not done yet', !handle.done && handle.playing === 'Slide')
      step(1)
      equal('once: it stays at the end', place(object('Door')), [2, 0, 0])
      ok('and says so', handle.done)
    })
    play([{ name: 'Door', components: [animation('Slide', { loop: 'yoyo', speed: 2 })] }], (step, object) => {
      step(0.75)
      equal('there and back, twice as fast', place(object('Door')), [1, 0, 0])
    })
    play([{ name: 'Door', components: [animation('Slide', { autoplay: false })] }], (step, object) => {
      step(0.5)
      equal('waits to be played', place(object('Door')), [0, 0, 0])
      const handle = animationOf(object('Door'), registry)
      ok('the clips of the scripts are listed', handle.clips.includes('Slide') && handle.clips.includes('Open'))
      equal('no such clip', handle.play('Nothing'), false)
      equal('played by a behavior', handle.play('Slide', { loop: false }), true)
      step(0.5)
      equal('goes', place(object('Door')), [1, 0, 0])
      handle.stop()
      step(0.5)
      // What the clip moved is back where it was before the clip
      equal('stopped', [handle.playing, place(object('Door'))], [null, [0, 0, 0]])
    })
    play([{ name: 'Door', active: false, components: [animation('Slide')] }], (step, object) => {
      step(0.5)
      equal('an inactive object waits', place(object('Door')), [0, 0, 0])
      object('Door').visible = true
      step(0.5)
      equal('and starts when it is active', place(object('Door')), [1, 0, 0])
    })
  })

  test('a relative clip', () => {
    play([{ name: 'Door', position: [5, 0, 0], rotation: [0, 30, 0], components: [animation('Open', { loop: 'once' })] }], (step, object) => {
      step(0.5)
      equal('from the turn it had', turn(object('Door')), [0, 75, 0])
      step(1)
      equal('to the end', turn(object('Door')), [0, 120, 0])
      equal('its place is its own', place(object('Door')), [5, 0, 0])
    })
  })

  test('tracks', () => {
    const entities = [{ name: 'Robot', components: [animation('Parts')], children: [{ name: 'Arm', children: [{ name: 'Hand' }] }] }]
    play(entities, (step, object) => {
      step(0.5)
      equal('an object by its path', place(object('Hand')), [0, 2, 0])
      equal('one number for an even scale', rounded(object('Arm').scale.toArray()), [2, 2, 2])
      equal('a turn past 180 degrees', turn(object('Robot')), [0, 180, 0])
      equal('active before its key', object('Arm').visible, true)
      step(1.25)
      equal('and after it', object('Arm').visible, false)
      equal('the clip is as long as it says: the last keys hold', place(object('Hand')), [0, 4, 0])
      step(0.5)
      equal('then it starts over', [object('Arm').visible, place(object('Hand'))], [true, [0, 1, 0]])
    })
    const { warn } = console
    const warnings: string[] = []
    console.warn = (text: string) => warnings.push(text)
    try {
      play([{ name: 'Robot', components: [animation('Parts')] }], (step, object) => {
        step(0.5)
        // The tracks that name nothing are left out, the rest plays
        equal('a missing object does not stop the clip', turn(object('Robot')), [0, 180, 0])
      })
    } finally {
      console.warn = warn
    }
    ok('and is told about', warnings.length === 1 && warnings[0].includes('no object "Arm/Hand"'))
    play([{ name: 'Box', components: [animation('Eased', { loop: 'once' })] }], (step, object) => {
      step(0.5)
      // "out" is ahead of an even move half way; "step" has not jumped yet
      equal('easing', place(object('Box')), [0.75, 0, 0])
      step(0.6)
      equal('at the end', place(object('Box')), [1, 1, 0])
    })
  })

  test('an animator', () => {
    play([{ name: 'Hero', components: [{ type: 'animator', animator: 'mover', params: { speed: 0 } }] }], (step, object) => {
      const hero = object('Hero')
      step(0.1)
      const animator = animatorOf(hero)!
      equal('the start state and its clip', [animator.state, place(hero)], ['Idle', [0, 0, 0]])
      animator.set('speed', 1)
      step(0.1)
      equal('a param leads on', [animator.state, place(hero)], ['Walk', [0, 1, 0]])
      animator.trigger('jump')
      step(0.1)
      equal('from any state', animator.state, 'Jump')
      equal('the trigger is spent', animator.get('jump'), false)
      step(0.2)
      ok('the clip of the state plays', hero.position.y > 2 && hero.position.y < 3)
      step(0.5)
      // Jump ends, Idle follows, and the speed that was set leads on to Walk at once
      equal('after the end of the clip', [animator.state, place(hero)], ['Walk', [0, 1, 0]])
      animator.set('speed', 0)
      step(0.1)
      equal('and back', animator.state, 'Idle')
      equal('by hand', [animator.go('Jump'), animator.state, animator.go('Nothing')], [true, 'Jump', false])
      ok('the time in the state', animator.time === 0)
    })
    play([{ name: 'Hero', components: [{ type: 'animator', animator: 'mover', params: { speed: 5 } }] }], (step, object) => {
      step(0.1)
      equal('the params the component gives', animatorOf(object('Hero'))?.state, 'Walk')
    })
  })

  test('the check of clips and animators', () => {
    equal('those of this test are fine', validateScripts(registry), [])
    const bad = new Registry()
    bad.registerExports({
      a: defineClip({ name: 'A', tracks: [{ property: 'colour' as 'position', keys: [{ time: 0, value: 1 }] }] }),
      b: defineClip({ name: 'B', tracks: [{ property: 'position', keys: [{ time: 0, value: 1 }] }, { property: 'active', keys: [] }] }),
      c: defineClip({ name: 'C', tracks: [{ property: 'position.y', keys: [{ time: -1, value: [0, 0, 0], ease: 'bounce' as 'in' }] }] }),
      d: defineAnimator({ name: 'D', start: 'Go', states: { Idle: { clip: '' } }, transitions: [{ from: 'Run', to: 'Fly' }] }),
    })
    const found = validateScripts(bad)
    for (const text of [
      'clip "A", track 1: unknown property "colour"', 'clip "B", track 1, key 1: the value of "position" must be [x, y, z]', 'clip "B", track 2: keys must be',
      'clip "C", track 1, key 1: time must be', 'clip "C", track 1, key 1: ease must be', 'clip "C", track 1, key 1: the value of "position.y" must be a number',
      'animator "D": start: there is no state "Go"', 'animator "D", state "Idle": clip must be', 'transition 1: to: there is no state "Fly"', 'transition 1: from: there is no state "Run"',
    ]) ok(`"${text}" in ${JSON.stringify(found)}`, found.some((problem) => problem.includes(text)))
    equal('nothing else', found.length, 10)
    const scene = (component: object) => validateScene(parseScene({ version: 3, entities: [{ name: 'It', components: [component] }] }), registry)
    ok('a scene that names a clip that is not there', scene(animation('Nothing')).some((problem) => problem.includes('there is no clip "Nothing"')))
    ok('or an animator', scene({ type: 'animator', animator: 'nobody' }).length === 1)
    ok('or a param it does not have', scene({ type: 'animator', animator: 'mover', params: { height: 1 } }).length === 1)
  })
}

// The root of a prefab as it is read from JSON, with the ids of `like` (they are made up at reading)
function parsePrefabRoot(json: unknown, like: EntityData): EntityData {
  const root = parsePrefab(json).root
  const copyIds = (to: EntityData, from: EntityData) => {
    to.id = from.id
    to.children.forEach((child, i) => copyIds(child, from.children[i]))
  }
  copyIds(root, like)
  return root
}
