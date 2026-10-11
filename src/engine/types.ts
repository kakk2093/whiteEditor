import type { EnvironmentData } from "./environment";

export type Vec3 = [number, number, number];

// string[] is a list of colors (a param of type "colors")
export type ParamValue = number | string | boolean | string[];

export type Params = Record<string, ParamValue>;

// { type: "mesh", shape: "box", material: "Wood" }, { type: "light", kind: "point" }, ...
// Fields are described in components.ts; a missing field means its default value.
// The "model" and "script" components additionally keep the params of the code-defined model or behavior.
export interface ComponentData {
    type: string;
    [field: string]: ParamValue | Params;
}

// What a prefab instance changes in one entity of its prefab (see prefab.ts)
export interface EntityOverride {
    active?: boolean;
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
    // By component key ("mesh", "script:spin"): the fields to replace; "params" are replaced one by one
    components?: Record<string, Record<string, ParamValue | Params>>;
    // Components this instance has on top of what the prefab gives; changed right here, not through "components"
    addComponents?: ComponentData[];
    // Keys of the components of the prefab this instance does not have
    removeComponents?: string[];
    // Entities this instance has on top of the children the prefab gives: ordinary entities, written whole
    addChildren?: EntityData[];
    // true: the instance does not have this entity of the prefab, nor anything under it
    removed?: boolean;
}

// A GameObject: does nothing by itself, everything comes from its components
export interface EntityData {
    // Any string unique within the scene
    id: string;
    name: string;
    // false hides the entity together with its children; missing means true
    active?: boolean;
    // Any word to find the entity by in the running game: self.findAll({ tag: "enemy" }). An instance without
    // a tag of its own has the tag of the root of its prefab.
    tag?: string;
    // Name of a prefab asset: the entity is an instance of it. Its components and children then come
    // from the prefab file; the instance itself only keeps its name, active flag, transform and overrides.
    prefab?: string;
    // Only for an instance: what it changes inside the prefab, by the path of names from the prefab root
    // ("Desk/Lamp"; "." is the root itself)
    overrides?: Record<string, EntityOverride>;
    // Local transform, relative to the parent entity
    position: Vec3;
    // Euler XYZ, degrees
    rotation: Vec3;
    scale: Vec3;
    // At most one component of each type, except "script": any number, each with another behavior
    components: ComponentData[];
    children: EntityData[];
}

// prefabs/<name>.json: an entity with its children, saved for reuse.
// The root's position is ignored; its rotation and scale are what a new instance starts with.
export interface PrefabData {
    version: 3;
    root: EntityData;
}

export interface SceneData {
    version: 3;
    // Missing values fall back to defaultEnvironment
    environment?: Partial<EnvironmentData>;
    entities: EntityData[];
}

export function generateId() {
    return crypto.randomUUID().slice(0, 8);
}

const RAD_TO_DEG = 180 / Math.PI;

// Files may omit everything that has a default (id, transform, components, children); fill it in
function normalizeEntity(raw: Partial<EntityData>, fromRadians: boolean, usedIds: Set<string>): EntityData {
    let id = raw.id;
    if (!id || usedIds.has(id)) id = generateId();
    usedIds.add(id);

    const rotation: Vec3 = raw.rotation ? [...raw.rotation] : [0, 0, 0];
    return {
        id,
        name: raw.name ?? "GameObject",
        ...(raw.active === false ? { active: false } : {}),
        ...(raw.tag ? { tag: raw.tag } : {}),
        ...(raw.prefab ? { prefab: raw.prefab } : {}),
        ...(raw.prefab && raw.overrides ? { overrides: normalizeOverrides(raw.overrides, fromRadians, usedIds) } : {}),
        position: raw.position ? [...raw.position] : [0, 0, 0],
        rotation: fromRadians ? (rotation.map((r) => r * RAD_TO_DEG) as Vec3) : rotation,
        scale: raw.scale ? [...raw.scale] : [1, 1, 1],
        components: (raw.components ?? []).map((c) => ({ ...c })),
        children: (raw.children ?? []).map((child) => normalizeEntity(child, fromRadians, usedIds)),
    };
}

// The entities an instance adds are written like any other, so they are read like any other
function normalizeOverrides(raw: Record<string, EntityOverride>, fromRadians: boolean, usedIds: Set<string>) {
    const overrides = structuredClone(raw);
    if (typeof overrides !== "object" || overrides === null) return overrides;
    for (const override of Object.values(overrides)) {
        if (override && Array.isArray(override.addChildren)) {
            override.addChildren = override.addChildren.map((child) => normalizeEntity(child, fromRadians, usedIds));
        }
    }
    return overrides;
}

export function parsePrefab(json: unknown): PrefabData {
    const data = json as { version?: number; root?: Partial<EntityData> } | null;
    if (!data || data.version !== 3 || typeof data.root !== "object" || data.root === null) {
        throw new Error("Not a prefab file (expected { version: 3, root: {...} })");
    }
    return { version: 3, root: normalizeEntity(data.root, false, new Set()) };
}

// Accepts what is on disk (including the older version 2, which kept rotation in radians)
export function parseScene(json: unknown): SceneData {
    const data = json as { version?: number; environment?: Partial<EnvironmentData>; entities?: Partial<EntityData>[] } | null;
    if (!data || (data.version !== 2 && data.version !== 3) || !Array.isArray(data.entities)) {
        throw new Error("Not a scene file (expected { version: 3, entities: [...] })");
    }
    const usedIds = new Set<string>();
    return {
        version: 3,
        ...(data.environment ? { environment: { ...data.environment } } : {}),
        entities: data.entities.map((entity) => normalizeEntity(entity, data.version === 2, usedIds)),
    };
}
