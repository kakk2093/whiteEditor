import { componentDefs, componentKey } from "./components";
import { environmentFields } from "./environment";
import { lookFields } from "./look";
import type { LookData } from "./look";
import type { ParamDef, Registry } from "./Registry";
import type { EntityData, ParamValue, PrefabData, SceneData } from "./types";

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
        case "string":
            return typeof value === "string" ? null : "must be a string";
        case "select":
            return def.options.includes(value as string) ? null : `must be one of: ${def.options.join(", ")}`;
        case "asset":
            if (value === "") return null;
            return registry.assetNames(def.kind).includes(value as string) ? null : `${def.kind} "${value}" does not exist`;
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

function checkEntity(entity: EntityData, path: string, registry: Registry, ids: Set<string>, problems: string[]) {
    const where = `${path}/${entity.name}`;

    if (ids.has(entity.id)) problems.push(`${where}: duplicate id "${entity.id}"`);
    ids.add(entity.id);

    for (const key of ["position", "rotation", "scale"] as const) {
        if (!isVec3(entity[key])) problems.push(`${where}.${key}: must be [x, y, z]`);
    }

    if (entity.prefab) {
        if (!registry.getPrefab(entity.prefab)) {
            problems.push(`${where}: prefab "${entity.prefab}" does not exist (known: ${registry.prefabNames().join(", ") || "none"})`);
        }
        if (entity.components.length > 0 || entity.children.length > 0) {
            problems.push(`${where}: a prefab instance cannot have its own components or children`);
        }
        return;
    }

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

        const { source } = def;
        if (source) {
            const name = component[source.key] as string;
            const found = source.get(registry, name);
            if (!found) {
                const known = source.list(registry).map((d) => d.name).join(", ") || "none";
                problems.push(`${at}: ${source.what} "${name}" is not defined in scripts/ (known: ${known})`);
            } else {
                const params = (component.params ?? {}) as Record<string, unknown>;
                checkFields(found.params ?? {}, params, `${at}.params`, registry, problems);
            }
        }
        checkFields(def.fields, component, at, registry, problems, ["type", ...(source ? [source.key, "params"] : [])]);
    }

    for (const child of entity.children) checkEntity(child, where, registry, ids, problems);
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
    checkEntity(data.root, "", registry, new Set(), problems);
    if (containsItself(registry, data.root, [name])) problems.push(`prefab "${name}" contains itself`);
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
