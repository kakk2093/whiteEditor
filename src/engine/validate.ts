import { componentDefs } from "./components";
import { environmentFields } from "./environment";
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
            return registry.materialNames().includes(value as string) ? null : `${def.kind} "${value}" does not exist`;
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

    const types = new Set<string>();
    for (const component of entity.components) {
        const isScript = component.type === "script";
        const at = isScript ? `${where} [script ${component.script}]` : `${where} [${component.type}]`;
        // Scripts are told apart by the behavior they run
        const key = isScript ? `script ${component.script}` : component.type;
        if (types.has(key)) problems.push(`${at}: ${isScript ? "this script is attached twice" : "more than one component of this type"}`);
        types.add(key);

        const def = componentDefs[component.type];
        if (!def) {
            problems.push(`${at}: unknown component (known: ${Object.keys(componentDefs).join(", ")})`);
            continue;
        }

        if (component.type === "model") {
            const model = registry.getModel(component.model as string);
            if (!model) {
                const known = registry.models().map((m) => m.name).join(", ") || "none";
                problems.push(`${at}: model "${component.model}" is not defined in scripts/ (known: ${known})`);
            } else {
                const params = (component.params ?? {}) as Record<string, unknown>;
                checkFields(model.params ?? {}, params, `${at}.params`, registry, problems);
            }
            checkFields({}, component, at, registry, problems, ["type", "model", "params"]);
        } else if (isScript) {
            const behavior = registry.getBehavior(component.script as string);
            if (!behavior) {
                const known = registry.behaviors().map((b) => b.name).join(", ") || "none";
                problems.push(`${at}: behavior "${component.script}" is not defined in scripts/ (known: ${known})`);
            } else {
                const params = (component.params ?? {}) as Record<string, unknown>;
                checkFields(behavior.params ?? {}, params, `${at}.params`, registry, problems);
            }
            checkFields({}, component, at, registry, problems, ["type", "script", "params"]);
        } else {
            checkFields(def.fields, component, at, registry, problems, ["type"]);
        }
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

// Human-readable problems of a parsed scene; an empty list means the scene is fine
export function validateScene(data: SceneData, registry: Registry): string[] {
    const problems: string[] = [];
    checkFields(environmentFields, data.environment ?? {}, "environment", registry, problems);

    const ids = new Set<string>();
    for (const entity of data.entities) checkEntity(entity, "", registry, ids, problems);
    return problems;
}
