import { componentDefs, componentKey, UI_PARTS } from "./components";
import { environmentFields } from "./environment";
import { lookFields } from "./look";
import type { LookData } from "./look";
import { materialFields } from "./materials";
import { expandPristine, findInExpanded, innerPaths, ROOT_PATH } from "./prefab";
import { DEFAULT_LAYER } from "./settings";
import type { ParamDef, Registry } from "./Registry";
import { MAX_COLORS } from "./shaderParams";
import type { ComponentData, EntityData, ParamValue, PrefabData, SceneData } from "./types";

function checkValue(def: ParamDef, value: unknown, registry: Registry): string | null {
    switch (def.type) {
        case "number":
            if (typeof value !== "number" || Number.isNaN(value)) return "must be a number";
            if (def.min !== undefined && value < def.min) return `must be >= ${def.min}`;
            if (def.max !== undefined && value > def.max) return `must be <= ${def.max}`;
            return null;
        case "boolean":
            return typeof value === "boolean" ? null : "must be true or false";
        case "color":
            return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? null : 'must be a color like "#aabbcc"';
        case "colors":
            if (!Array.isArray(value) || !value.every((c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c))) {
                return 'must be a list of colors like ["#aabbcc", "#112233"]';
            }
            return value.length > MAX_COLORS ? `must have at most ${MAX_COLORS} colors` : null;
        case "string":
            return typeof value === "string" ? null : "must be a string";
        case "select":
            return def.options.includes(value as string) ? null : `must be one of: ${def.options.join(", ")}`;
        case "asset":
            if (value === "") return null;
            if (registry.assetNames(def.kind).includes(value as string)) return null;
            if (def.kind === "layer") {
                if (value === DEFAULT_LAYER) return null;
                return `there is no layer "${value}" in project.json (layers: ${[DEFAULT_LAYER, ...registry.settings.layers].join(", ")})`;
            }
            if (def.kind === "font") return `there is no font "${value}" in assets/ (fonts: ${registry.fontNames().join(", ") || "none"})`;
            if (def.kind === "sound") return `there is no sound "${value}" in assets/ (sounds: ${registry.soundNames().join(", ") || "none"})`;
            return def.kind === "texture"
                ? `there is no image "${value}" in assets/ (images: ${registry.textureNames().join(", ") || "none"})`
                : `${def.kind} "${value}" does not exist`;
    }
}

function checkFields(
    defs: Record<string, ParamDef>,
    values: Record<string, unknown>,
    where: string,
    registry: Registry,
    problems: string[],
    skip: string[] = []
) {
    for (const [key, value] of Object.entries(values)) {
        if (skip.includes(key)) continue;
        const def = defs[key];
        if (!def) {
            problems.push(`${where}: unknown field "${key}" (known: ${Object.keys(defs).join(", ") || "none"})`);
            continue;
        }
        const problem = checkValue(def, value as ParamValue, registry);
        if (problem) problems.push(`${where}.${key}: ${problem}`);
    }
}

function isVec3(value: unknown) {
    return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && !Number.isNaN(n));
}

// The fields of one component: its own, and the params of the model or behavior it takes from scripts/.
// With `partial` it is a piece of an override: only what it names is checked.
function checkComponent(component: ComponentData, at: string, registry: Registry, problems: string[], partial = false) {
    const def = componentDefs[component.type];
    const { source } = def;
    if (source) {
        const name = component[source.key] as string;
        const found = source.get(registry, name);
        if (!found) {
            const known = source.list(registry).map((d) => d.name).join(", ") || "none";
            problems.push(`${at}: ${source.what} "${name}" is not defined in scripts/ (known: ${known})`);
        } else if (!partial || component.params !== undefined) {
            const params = (component.params ?? {}) as Record<string, unknown>;
            checkFields(found.params ?? {}, params, `${at}.params`, registry, problems);
        }
    }
    checkFields(def.fields, component, at, registry, problems, ["type", ...(source ? [source.key, "params"] : [])]);
}

// The overrides of a prefab instance: every path and component must exist in the prefab
function checkOverrides(entity: EntityData, where: string, registry: Registry, ids: Set<string>, problems: string[]) {
    const overrides = entity.overrides ?? {};
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
        problems.push(`${where}.overrides: must be an object of "path": { ... }`);
        return;
    }
    const pristine = expandPristine(registry, entity);
    if (!pristine) return;

    for (const [path, override] of Object.entries(overrides)) {
        const at = `${where}.overrides["${path}"]`;
        const target = findInExpanded(pristine, path === ROOT_PATH ? entity.id : `${entity.id}/${path}`);
        if (!target) {
            problems.push(`${at}: prefab "${entity.prefab}" has nothing at this path (known: ${[ROOT_PATH, ...innerPaths(pristine)].join(", ")})`);
            continue;
        }
        if (typeof override !== "object" || override === null) {
            problems.push(`${at}: must be an object`);
            continue;
        }
        for (const [key, value] of Object.entries(override)) {
            if (["components", "addComponents", "removeComponents", "addChildren"].includes(key)) continue;
            if (key === "name") {
                if (path === ROOT_PATH) problems.push(`${at}.name: the root is the instance itself, write "name" on the instance`);
                else if (typeof value !== "string" || value === "" || value.includes("/")) problems.push(`${at}.name: must be a name without "/"`);
            } else if (key === "removed") {
                if (path === ROOT_PATH) problems.push(`${at}.removed: the root of the prefab cannot be removed (delete the instance instead)`);
                else if (value !== true) problems.push(`${at}.removed: must be true (or leave it out)`);
            } else if (!["active", "position", "rotation", "scale"].includes(key)) {
                problems.push(`${at}: unknown field "${key}" (known: name, active, position, rotation, scale, components, addComponents, removeComponents, addChildren, removed)`);
            } else if (path === ROOT_PATH) {
                problems.push(`${at}.${key}: the root is the instance itself, write "${key}" on the instance`);
            } else if (key === "active" ? typeof value !== "boolean" : !isVec3(value)) {
                problems.push(`${at}.${key}: must be ${key === "active" ? "true or false" : "[x, y, z]"}`);
            }
        }
        for (const [key, fields] of Object.entries(override.components ?? {})) {
            const component = target.components.find((c) => componentKey(c) === key);
            if (!component) {
                const known = target.components.map(componentKey).join(", ") || "none";
                problems.push(`${at}.components["${key}"]: "${target.name}" has no such component in the prefab (known: ${known})`);
                continue;
            }
            const def = componentDefs[component.type];
            if (!def) continue;
            if ("type" in fields || (def.multiple && def.source && def.source.key in fields)) {
                problems.push(`${at}.components["${key}"]: an override cannot change what the component is`);
                continue;
            }
            // Checked as the component would be with these fields put in
            const sourceKey = def.source?.key;
            const changed = { type: component.type, ...(sourceKey ? { [sourceKey]: component[sourceKey] } : {}), ...fields };
            checkComponent(changed, `${at}.components["${key}"]`, registry, problems, true);
        }

        const known = target.components.map(componentKey);
        const removeComponents: unknown = override.removeComponents ?? [];
        if (!Array.isArray(removeComponents)) {
            problems.push(`${at}.removeComponents: must be a list of component keys, e.g. ["mesh", "script:spin"]`);
        } else {
            for (const key of removeComponents) {
                if (!known.includes(key)) {
                    problems.push(`${at}.removeComponents: "${target.name}" has no component "${key}" in the prefab (known: ${known.join(", ") || "none"})`);
                }
            }
        }

        const addComponents: unknown = override.addComponents ?? [];
        if (!Array.isArray(addComponents)) {
            problems.push(`${at}.addComponents: must be a list of components, e.g. [{ "type": "collider" }]`);
        } else {
            const added = new Set<string>();
            for (const component of addComponents as ComponentData[]) {
                if (typeof component !== "object" || component === null || typeof component.type !== "string") {
                    problems.push(`${at}.addComponents: every item must be a component: { "type": "...", ... }`);
                    continue;
                }
                const key = componentKey(component);
                const there = `${at}.addComponents [${key}]`;
                if (known.includes(key)) problems.push(`${there}: the prefab already gives "${target.name}" this component; change its fields through "components"`);
                if (added.has(key)) problems.push(`${there}: added more than once`);
                added.add(key);
                if (!componentDefs[component.type]) {
                    problems.push(`${there}: unknown component (known: ${Object.keys(componentDefs).join(", ")})`);
                    continue;
                }
                checkComponent(component, there, registry, problems);
            }
        }

        const addChildren: unknown = override.addChildren ?? [];
        if (!Array.isArray(addChildren)) {
            problems.push(`${at}.addChildren: must be a list of entities`);
        } else {
            const names = new Set(target.children.map((child) => child.name));
            for (const child of addChildren as EntityData[]) {
                if (typeof child !== "object" || child === null) {
                    problems.push(`${at}.addChildren: every item must be an entity: { "name": "...", ... }`);
                    continue;
                }
                // Paths go by names, so an added entity must not take the name of a neighbor
                if (names.has(child.name)) problems.push(`${at}.addChildren: "${target.name}" already has a child named "${child.name}"`);
                if (child.name.includes("/")) problems.push(`${at}.addChildren: the name "${child.name}" must not have "/" in it`);
                names.add(child.name);
                checkEntity(child, `${at}.addChildren`, registry, ids, problems);
            }
        }
    }
}

// `canvas`: the entity is, or may be, inside a Canvas, where the elements of the interface are drawn
function checkEntity(entity: EntityData, path: string, registry: Registry, ids: Set<string>, problems: string[], canvas = false) {
    const where = `${path}/${entity.name}`;

    if (ids.has(entity.id)) problems.push(`${where}: duplicate id "${entity.id}"`);
    ids.add(entity.id);

    for (const key of ["position", "rotation", "scale"] as const) {
        if (!isVec3(entity[key])) problems.push(`${where}.${key}: must be [x, y, z]`);
    }
    if (entity.tag !== undefined && typeof entity.tag !== "string") {
        problems.push(`${where}.tag: must be a string`);
    } else if (entity.tag && registry.settings.tags.length > 0 && !registry.settings.tags.includes(entity.tag)) {
        // The project lists its tags, so one that is not there is most likely a slip of the hand
        problems.push(`${where}.tag: "${entity.tag}" is not among the tags of project.json (tags: ${registry.settings.tags.join(", ")})`);
    }

    if (entity.prefab) {
        if (!registry.getPrefab(entity.prefab)) {
            problems.push(`${where}: prefab "${entity.prefab}" does not exist (known: ${registry.prefabNames().join(", ") || "none"})`);
        }
        if (entity.components.length > 0 || entity.children.length > 0) {
            problems.push(`${where}: a prefab instance cannot have its own components or children (use "overrides" to change what the prefab gives)`);
        }
        if (entity.overrides) checkOverrides(entity, where, registry, ids, problems);
        return;
    }
    if (entity.overrides) problems.push(`${where}: only a prefab instance can have overrides`);

    const keys = new Set<string>();
    for (const component of entity.components) {
        const def = componentDefs[component.type];
        const key = componentKey(component);
        const at = `${where} [${key}]`;
        if (keys.has(key)) {
            problems.push(`${at}: ${def?.multiple ? "attached more than once" : "more than one component of this type"}`);
        }
        keys.add(key);

        if (!def) {
            problems.push(`${at}: unknown component (known: ${Object.keys(componentDefs).join(", ")})`);
            continue;
        }

        checkComponent(component, at, registry, problems);
    }
    for (const part of UI_PARTS) {
        if (keys.has(part) && !keys.has("ui")) problems.push(`${where} [${part}]: is drawn only with a UI Element next to it: add { "type": "ui" }`);
    }

    if (keys.has("input") && !keys.has("text")) problems.push(`${where} [input]: what is typed is shown by a Text next to it: add { "type": "text" }`);

    if (keys.has("body")) {
        const collider = entity.components.find((component) => component.type === "collider");
        if (!collider) problems.push(`${where} [body]: needs a shape: add a Collider, { "type": "collider" }`);
        else if (collider.solid === false) problems.push(`${where} [body]: its Collider must be solid; a trigger is not a part of the physics`);
    }
    const inside = canvas || keys.has("canvas");
    if (keys.has("ui") && !inside) {
        problems.push(`${where} [ui]: is drawn only inside a Canvas: put the object under one that has { "type": "canvas" }`);
    }

    for (const child of entity.children) checkEntity(child, where, registry, ids, problems, inside);
}

// true if expanding the prefab would come back to one of `stack`
function containsItself(registry: Registry, entity: EntityData, stack: string[]): boolean {
    if (entity.prefab) {
        if (stack.includes(entity.prefab)) return true;
        const root = registry.getPrefab(entity.prefab);
        return root ? containsItself(registry, root, [...stack, entity.prefab]) : false;
    }
    return entity.children.some((child) => containsItself(registry, child, stack));
}

export function validatePrefab(name: string, data: PrefabData, registry: Registry): string[] {
    const problems: string[] = [];
    if (data.root.prefab) problems.push(`root: the root of a prefab cannot itself be a prefab instance`);
    // Where its instances will stand is not known here: a prefab of one button is fine
    checkEntity(data.root, "", registry, new Set(), problems, true);
    if (containsItself(registry, data.root, [name])) problems.push(`prefab "${name}" contains itself`);
    return problems;
}

// Problems of a material asset (materials/<name>.json as it is on disk)
export function validateMaterial(data: unknown, registry: Registry): string[] {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return ["must be an object"];
    const problems: string[] = [];
    checkFields(materialFields, data as Record<string, unknown>, "material", registry, problems);
    return problems;
}

// Problems of a look asset (looks/<name>.json as it is on disk)
export function validateLook(name: string, data: LookData, registry: Registry): string[] {
    const problems: string[] = [];
    if (typeof data !== "object" || data === null || Array.isArray(data)) return ["must be an object"];

    const { extends: base, surfaces, effects, ...settings } = data;
    checkFields(lookFields, settings, "look", registry, problems);

    if (base !== undefined) {
        if (typeof base !== "string" || !registry.getLookData(base)) {
            problems.push(`extends: look "${base}" does not exist (known: ${registry.lookNames().join(", ") || "none"})`);
        } else {
            // Following the chain must not come back to this look
            const seen = [name];
            for (let next: string | undefined = base; next; next = registry.getLookData(next)?.extends) {
                if (seen.includes(next)) {
                    problems.push(`extends: look "${name}" extends itself through ${seen.slice(1).concat(next).join(" -> ")}`);
                    break;
                }
                seen.push(next);
            }
        }
    }

    // The two lists of a look are written the same way: the name under `key`, then the params
    const checkList = (list: unknown, key: "effect" | "surface", known: { name: string; params?: Record<string, ParamDef> }[]) => {
        if (list !== undefined && !Array.isArray(list)) problems.push(`${key}s: must be a list`);
        const names = new Set<unknown>();
        for (const entry of (Array.isArray(list) ? list : []) as Record<string, unknown>[]) {
            const name = entry?.[key];
            const at = `${key}s [${name}]`;
            if (names.has(name)) problems.push(`${at}: listed more than once`);
            names.add(name);

            const def = known.find((d) => d.name === name);
            if (!def) {
                problems.push(`${at}: unknown ${key} (known: ${known.map((d) => d.name).join(", ")})`);
                continue;
            }
            if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") problems.push(`${at}.enabled: must be true or false`);
            checkFields(def.params ?? {}, entry, at, registry, problems, [key, "enabled"]);
        }
    };
    checkList(surfaces, "surface", registry.surfaces());
    checkList(effects, "effect", registry.effects());
    return problems;
}

// Human-readable problems of a parsed scene; an empty list means the scene is fine
export function validateScene(data: SceneData, registry: Registry): string[] {
    const problems: string[] = [];
    checkFields(environmentFields, data.environment ?? {}, "environment", registry, problems);

    const ids = new Set<string>();
    for (const entity of data.entities) checkEntity(entity, "", registry, ids, problems);
    return problems;
}
