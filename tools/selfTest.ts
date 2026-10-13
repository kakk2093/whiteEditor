import * as THREE from 'three'
import { animationOf, animatorOf, defineAnimator, defineClip } from '../src/engine/animation'
import { componentDefs } from '../src/engine/components'
import { Game } from '../src/engine/game'
import {
  applyToPrefab, assignAddedIds, diffOverride, expandInstance, expandPristine, findInExpanded, innerPaths, ROOT_PATH,
} from '../src/engine/prefab'
import { Registry } from '../src/engine/Registry'
import { parsePrefab, parseScene } from '../src/engine/types'
import type { EntityData, EntityOverride } from '../src/engine/types'
import { validatePrefab, validateScene, validateScripts } from '../src/engine/validate'

// Checks of the engine itself, on data made right here: nothing of a project is read. `npm run check` runs
// them before it looks at the project, so a change in the engine that breaks them shows at once.
// Three parts: prefabs inside prefabs, animation (clips and animators), colliders that are turned (slopes).
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
