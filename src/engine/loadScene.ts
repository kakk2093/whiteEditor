import * as THREE from "three";
import { createComponentObject, createPlaceholder } from "./components";
import type { Registry } from "./Registry";
import { generateId } from "./types";
import type { ComponentData, EntityData, SceneData, Vec3 } from "./types";

// An entity is a Group: the objects of its components and its child entities are children of that group.
// `prefabStack` lists the prefabs being expanded: objects that come from inside a prefab carry no entityId,
// so in the editor a click on any part of an instance selects the instance itself.
export function createEntityObject(registry: Registry, entity: EntityData, prefabStack: string[] = []): THREE.Group {
    const group = new THREE.Group();
    group.name = entity.name;
    group.visible = entity.active ?? true;
    if (prefabStack.length === 0) group.userData.entityId = entity.id;
    group.position.fromArray(entity.position);
    group.rotation.set(...(entity.rotation.map(THREE.MathUtils.degToRad) as Vec3));
    group.scale.fromArray(entity.scale);

    // A prefab instance takes its components and children from the prefab
    let source = entity;
    let stack = prefabStack;
    if (entity.prefab) {
        const root = registry.getPrefab(entity.prefab);
        if (!root || prefabStack.includes(entity.prefab)) {
            console.warn(root ? `Prefab "${entity.prefab}" contains itself` : `Unknown prefab "${entity.prefab}"`);
            group.add(createPlaceholder());
            return group;
        }
        group.userData.prefab = entity.prefab;
        source = root;
        stack = [...prefabStack, entity.prefab];
    }

    // Behaviors are started from here by the Runtime
    const scripts = source.components.filter((c) => c.type === "script");
    if (scripts.length > 0) group.userData.scripts = scripts;

    for (const component of source.components) {
        const obj = createComponentObject(registry, component);
        if (obj) group.add(obj);
    }
    for (const child of source.children) {
        group.add(createEntityObject(registry, child, stack));
    }
    return group;
}

// A new scene entity that is an instance of the prefab
export function createPrefabInstance(registry: Registry, prefab: string, name = prefab): EntityData {
    const root = registry.getPrefab(prefab);
    const entity = createEntity(name);
    entity.prefab = prefab;
    if (root) {
        entity.rotation = [...root.rotation];
        entity.scale = [...root.scale];
    }
    return entity;
}

// Game side: scene.add(instantiatePrefab(registry, "Crate", [0, 0, 3]))
export function instantiatePrefab(registry: Registry, prefab: string, position: Vec3 = [0, 0, 0]): THREE.Group {
    const entity = createPrefabInstance(registry, prefab);
    entity.position = position;
    return createEntityObject(registry, entity);
}

// Game side: const level = loadScene(registry, json); scene.add(level); applyEnvironment(scene, json.environment)
export function loadScene(registry: Registry, data: SceneData): THREE.Group {
    const group = new THREE.Group();
    for (const entity of data.entities) {
        group.add(createEntityObject(registry, entity));
    }
    return group;
}

export function createEntity(name: string, components: ComponentData[] = []): EntityData {
    return {
        id: generateId(),
        name,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        components,
        children: [],
    };
}

// Euler rotation (degrees) that points the local -Z axis from `from` to `to`
function lookRotation(from: Vec3, to: Vec3): Vec3 {
    const matrix = new THREE.Matrix4().lookAt(
        new THREE.Vector3(...from),
        new THREE.Vector3(...to),
        new THREE.Vector3(0, 1, 0)
    );
    const euler = new THREE.Euler().setFromRotationMatrix(matrix);
    return [euler.x, euler.y, euler.z].map((r) => Math.round(THREE.MathUtils.radToDeg(r) * 100) / 100) as Vec3;
}

// What a new scene starts with, same as in Unity: a camera and a sun
export function createDefaultScene(): SceneData {
    const camera = createEntity("Main Camera", [{ type: "camera" }]);
    camera.position = [0, 1.6, 5];

    const sun = createEntity("Directional Light", [{ type: "light", kind: "directional", castShadow: true }]);
    sun.position = [3, 6, 4];
    sun.rotation = lookRotation(sun.position, [0, 0, 0]);

    return { version: 3, entities: [camera, sun] };
}
