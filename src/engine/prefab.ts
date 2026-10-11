import { componentDefs, componentKey, findComponent } from "./components";
import type { Registry } from "./Registry";
import type { ComponentData, EntityData, EntityOverride, Params } from "./types";

// A prefab instance takes its components and children from the prefab file. Its `overrides` change that
// content for this one instance: { "Desk/Lamp": { "position": [0, 1, 0], "components": { "light": { "intensity": 5 } } } }.
// The key is the path of names from the root of the prefab; ROOT_PATH is the root itself (only its components
// can be overridden: its name, active flag and transform are the instance's own). A path may go on into an
// instance of another prefab that stands inside this one.

export const ROOT_PATH = ".";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mergeOverride(base: EntityOverride | undefined, over: EntityOverride): EntityOverride {
    const merged: EntityOverride = { ...base, ...structuredClone(over) };
    if (base?.components && over.components) {
        merged.components = { ...base.components };
        for (const [key, fields] of Object.entries(over.components)) {
            const old = merged.components[key] ?? {};
            merged.components[key] = { ...old, ...structuredClone(fields) };
            if (old.params && fields.params) {
                merged.components[key].params = { ...(old.params as Params), ...(fields.params as Params) };
            }
        }
    }
    return merged;
}

function applyComponents(entity: EntityData, components: NonNullable<EntityOverride["components"]>) {
    for (const [key, fields] of Object.entries(components)) {
        const component = findComponent(entity, key);
        if (!component) continue;
        const def = componentDefs[component.type];
        const sourceKey = def?.source?.key;
        for (const [field, value] of Object.entries(fields)) {
            // What tells the components of an entity apart cannot be overridden
            if (field === "type" || field === "params" || (def?.multiple && field === sourceKey)) continue;
            // Another model has other params
            if (field === sourceKey && component[field] !== value) component.params = {};
            component[field] = structuredClone(value);
        }
        if (fields.params) component.params = { ...(component.params as Params | undefined), ...structuredClone(fields.params as Params) };
    }
}

// Applies one override to what is at `path` under `root`; false if there is nothing at that path
function applyAt(root: EntityData, path: string, override: EntityOverride): boolean {
    const names = path === ROOT_PATH ? [] : path.split("/");
    let node = root;
    for (let i = 0; i < names.length; i++) {
        // The path goes on inside an instance of another prefab: that instance carries the rest
        if (node !== root && node.prefab) {
            const rest = names.slice(i).join("/");
            node.overrides = { ...node.overrides, [rest]: mergeOverride(node.overrides?.[rest], override) };
            return true;
        }
        const next = node.children.find((child) => child.name === names[i]);
        if (!next) return false;
        node = next;
    }

    if (node !== root) {
        if (override.active !== undefined) {
            if (override.active) delete node.active;
            else node.active = false;
        }
        for (const property of ["position", "rotation", "scale"] as const) {
            const value = override[property];
            if (value) node[property] = [...value];
        }
    }
    if (override.components) {
        if (node !== root && node.prefab) {
            const { components } = override;
            node.overrides = { ...node.overrides, [ROOT_PATH]: mergeOverride(node.overrides?.[ROOT_PATH], { components }) };
        } else {
            applyComponents(node, override.components);
        }
    }
    return true;
}

// What the instance really is: an entity with the content of its prefab and the overrides applied.
// null if the prefab does not exist or contains itself (`stack` lists the prefabs being expanded).
// The entities inside get ids "<instance id>/<path>", so they can be told apart and found again.
// With deep = false the instances of other prefabs inside stay instances (and carry their part of the overrides).
export function expandInstance(registry: Registry, instance: EntityData, stack: string[] = [], deep = true): EntityData | null {
    const root = instance.prefab ? registry.getPrefab(instance.prefab) : undefined;
    if (!instance.prefab || !root || stack.includes(instance.prefab)) return null;

    const expanded: EntityData = {
        id: instance.id,
        name: instance.name,
        ...(instance.active === false ? { active: false } : {}),
        position: [...instance.position],
        rotation: [...instance.rotation],
        scale: [...instance.scale],
        components: structuredClone(root.components),
        children: structuredClone(root.children),
    };
    for (const [path, override] of Object.entries(instance.overrides ?? {})) applyAt(expanded, path, override);

    if (deep) {
        const inner = [...stack, instance.prefab];
        const expandChild = (child: EntityData): EntityData => {
            // One that cannot be expanded stays an instance; whoever builds it shows a placeholder
            if (child.prefab) return expandInstance(registry, child, inner) ?? child;
            child.children = child.children.map(expandChild);
            return child;
        };
        expanded.children = expanded.children.map(expandChild);
    }

    const setIds = (entity: EntityData, id: string) => {
        entity.id = id;
        entity.children.forEach((child) => setIds(child, `${id}/${child.name}`));
    };
    setIds(expanded, instance.id);
    return expanded;
}

// The root of a prefab with overrides of one of its instances written into it: what "Apply" saves.
// Overrides that reach into an instance of another prefab inside stay overrides, now of that inner instance.
export function applyToPrefab(root: EntityData, overrides: Record<string, EntityOverride>): EntityData {
    const changed = structuredClone(root);
    for (const [path, override] of Object.entries(overrides)) applyAt(changed, path, override);
    return changed;
}

// The instance as its prefab alone makes it, without its own overrides
export function expandPristine(registry: Registry, instance: EntityData) {
    return expandInstance(registry, { ...instance, overrides: undefined });
}

export function findInExpanded(entity: EntityData, id: string): EntityData | null {
    if (entity.id === id) return entity;
    for (const child of entity.children) {
        const found = findInExpanded(child, id);
        if (found) return found;
    }
    return null;
}

// The paths overrides can name, for an expanded instance
export function innerPaths(expanded: EntityData): string[] {
    const paths: string[] = [];
    const visit = (entity: EntityData) => {
        for (const child of entity.children) {
            paths.push(child.id.slice(expanded.id.length + 1));
            visit(child);
        }
    };
    visit(expanded);
    return paths;
}

// A field that is not written means its default
function fieldValue(component: ComponentData, field: string) {
    return component[field] ?? componentDefs[component.type]?.fields[field]?.default;
}

function paramValue(registry: Registry, component: ComponentData, param: string) {
    const source = componentDefs[component.type]?.source;
    const def = source?.get(registry, component[source.key] as string);
    return (component.params as Params | undefined)?.[param] ?? def?.params?.[param]?.default;
}

// The override that turns `pristine` (an entity as the prefab makes it) into `edited`; null if they are the
// same. `root` is true for the root of the instance, whose active flag and transform are the instance's own.
export function diffOverride(registry: Registry, pristine: EntityData, edited: EntityData, root: boolean): EntityOverride | null {
    const override: EntityOverride = {};
    if (!root) {
        if ((pristine.active ?? true) !== (edited.active ?? true)) override.active = edited.active ?? true;
        for (const property of ["position", "rotation", "scale"] as const) {
            if (!same(pristine[property], edited[property])) override[property] = [...edited[property]];
        }
    }

    const components: NonNullable<EntityOverride["components"]> = {};
    for (const component of edited.components) {
        const key = componentKey(component);
        const before = findComponent(pristine, key);
        if (!before) continue;
        const fields: Record<string, ComponentData[string]> = {};
        for (const field of new Set([...Object.keys(before), ...Object.keys(component)])) {
            if (field === "type" || field === "params") continue;
            if (!same(fieldValue(before, field), fieldValue(component, field))) fields[field] = fieldValue(component, field);
        }

        const sourceKey = componentDefs[component.type]?.source?.key;
        if (sourceKey && sourceKey in fields) {
            // Another model: all of its params are this instance's
            if (Object.keys(component.params ?? {}).length > 0) fields.params = structuredClone(component.params);
        } else {
            const params: Params = {};
            const names = new Set([...Object.keys(before.params ?? {}), ...Object.keys(component.params ?? {})]);
            for (const param of names) {
                const value = paramValue(registry, component, param);
                if (value !== undefined && !same(paramValue(registry, before, param), value)) params[param] = value;
            }
            if (Object.keys(params).length > 0) fields.params = params;
        }
        if (Object.keys(fields).length > 0) components[key] = fields;
    }
    if (Object.keys(components).length > 0) override.components = components;

    return Object.keys(override).length > 0 ? override : null;
}
