import { componentDefs, componentKey, findComponent } from "./components";
import type { Registry } from "./Registry";
import { generateId } from "./types";
import type { ComponentData, EntityData, EntityOverride, Params } from "./types";

// A prefab instance takes its components and children from the prefab file. Its `overrides` change that
// content for this one instance: { "Desk/Lamp": { "position": [0, 1, 0], "components": { "light": { "intensity": 5 } } } }.
// The key is the path of names from the root of the prefab; ROOT_PATH is the root itself (only its components
// can be overridden: its name, active flag and transform are the instance's own). A path may go on into an
// instance of another prefab that stands inside this one.
//
// An override can also change what the entity is made of: "addComponents" and "removeComponents" for its
// components, "addChildren" for entities the prefab does not have there, "removed" to leave the entity out.
// What an instance adds is its own: an added entity is written whole and changed right there, and no path
// leads to it or into it. In an expanded instance it gets an id like everything else, "<id of what it is in>/<name>".

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
    if (base?.removeComponents && over.removeComponents) {
        merged.removeComponents = [...new Set([...base.removeComponents, ...over.removeComponents])];
    }
    if (base?.addComponents && over.addComponents) {
        const keys = over.addComponents.map(componentKey);
        merged.addComponents = [...base.addComponents.filter((c) => !keys.includes(componentKey(c))), ...structuredClone(over.addComponents)];
    }
    if (base?.addChildren && over.addChildren) merged.addChildren = [...base.addChildren, ...structuredClone(over.addChildren)];
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
    let parent = root;
    for (let i = 0; i < names.length; i++) {
        // The path goes on inside an instance of another prefab: that instance carries the rest
        if (node !== root && node.prefab) {
            const rest = names.slice(i).join("/");
            node.overrides = { ...node.overrides, [rest]: mergeOverride(node.overrides?.[rest], override) };
            return true;
        }
        const next = node.children.find((child) => child.name === names[i]);
        if (!next) return false;
        parent = node;
        node = next;
    }

    if (node !== root) {
        if (override.removed) {
            parent.children.splice(parent.children.indexOf(node), 1);
            return true;
        }
        if (override.active !== undefined) {
            if (override.active) delete node.active;
            else node.active = false;
        }
        for (const property of ["position", "rotation", "scale"] as const) {
            const value = override[property];
            if (value) node[property] = [...value];
        }
    }
    const { components, addComponents, removeComponents, addChildren } = override;
    if (node !== root && node.prefab) {
        // What an instance of another prefab is made of is its own business: it gets this as its override
        const content: EntityOverride = {
            ...(components ? { components } : {}),
            ...(addComponents ? { addComponents } : {}),
            ...(removeComponents ? { removeComponents } : {}),
            ...(addChildren ? { addChildren } : {}),
        };
        if (Object.keys(content).length > 0) {
            node.overrides = { ...node.overrides, [ROOT_PATH]: mergeOverride(node.overrides?.[ROOT_PATH], content) };
        }
        return true;
    }
    if (removeComponents) node.components = node.components.filter((c) => !removeComponents.includes(componentKey(c)));
    for (const component of addComponents ?? []) {
        // The prefab may have got such a component since: then that one stays
        if (!findComponent(node, componentKey(component))) node.components.push(structuredClone(component));
    }
    if (components) applyComponents(node, components);
    for (const child of addChildren ?? []) node.children.push(structuredClone(child));
    return true;
}

// The lists of entities an instance adds to its prefab: the "addChildren" of its overrides
export function addedLists(entity: EntityData): EntityData[][] {
    return Object.values(entity.overrides ?? {}).flatMap((override) => (override.addChildren ? [override.addChildren] : []));
}

// The id of what an override path of the instance names
export const innerId = (instance: EntityData, path: string) => (path === ROOT_PATH ? instance.id : `${instance.id}/${path}`);

// Gives every entity an instance adds the id it has in the expanded instance: "<id of what it is in>/<name>",
// and so on down. An entity that has such an id but is not inside an instance (it was moved out) gets a new one.
export function assignAddedIds(entities: EntityData[]) {
    const visit = (entity: EntityData, derived: boolean) => {
        for (const [path, override] of Object.entries(entity.overrides ?? {})) {
            for (const child of override.addChildren ?? []) {
                child.id = `${innerId(entity, path)}/${child.name}`;
                visit(child, true);
            }
        }
        for (const child of entity.children) {
            if (derived) child.id = `${entity.id}/${child.name}`;
            else if (child.id.includes("/")) child.id = generateId();
            visit(child, derived);
        }
    };
    for (const entity of entities) {
        if (entity.id.includes("/")) entity.id = generateId();
        visit(entity, false);
    }
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
        ...(instance.tag ?? root.tag ? { tag: instance.tag ?? root.tag } : {}),
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
    // What the instance added is now a part of the prefab, with ids of its own
    assignAddedIds([changed]);
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

    // Components the prefab does not give here, and those of the prefab that are gone
    const added = edited.components.filter((component) => !findComponent(pristine, componentKey(component)));
    if (added.length > 0) override.addComponents = structuredClone(added);
    const removed = pristine.components.map(componentKey).filter((key) => !findComponent(edited, key));
    if (removed.length > 0) override.removeComponents = removed;

    return Object.keys(override).length > 0 ? override : null;
}
