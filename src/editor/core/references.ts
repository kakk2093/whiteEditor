import { componentDefs, environmentFields } from "../../engine";
import type { EntityData, ParamDef, Registry, SceneData } from "../../engine";

// Scenes and prefabs refer to materials, looks and prefabs by name. When an asset is renamed, these functions put the
// new name wherever the old one stood. They work on what is on disk as well, where anything with a default
// may be missing. Nothing refers to a prefab through a field, so for it only the instances are renamed.

type Kind = "material" | "look" | "prefab" | "layer" | "object";

// Replaces `from` in the fields that are references to assets of this kind; true if anything changed
function renameInFields(defs: Record<string, ParamDef>, values: Record<string, unknown> | undefined, kind: Kind, from: string, to: string) {
    let changed = false;
    for (const [key, def] of Object.entries(defs)) {
        if (values && def.type === "asset" && def.kind === kind && values[key] === from) {
            values[key] = to;
            changed = true;
        }
    }
    return changed;
}

// One component, or the fields an override gives for it; `sourceName` is the model or behavior it takes its params from
function renameInComponent(
    registry: Registry, type: string, sourceName: unknown, fields: Record<string, unknown>, kind: Kind, from: string, to: string
) {
    const def = componentDefs[type];
    if (!def) return false;
    let changed = renameInFields(def.fields, fields, kind, from, to);
    const source = typeof sourceName === "string" ? def.source?.get(registry, sourceName) : undefined;
    if (source?.params && renameInFields(source.params, fields.params as Record<string, unknown> | undefined, kind, from, to)) changed = true;
    return changed;
}

export function renameInEntities(registry: Registry, entities: Partial<EntityData>[], kind: Kind, from: string, to: string): boolean {
    let changed = false;
    for (const entity of entities) {
        // An instance names its prefab
        if (kind === "prefab" && entity.prefab === from) {
            entity.prefab = to;
            changed = true;
        }
        const added = Object.values(entity.overrides ?? {}).flatMap((override) => override.addComponents ?? []);
        for (const component of [...(entity.components ?? []), ...added]) {
            const sourceKey = componentDefs[component.type]?.source?.key;
            if (renameInComponent(registry, component.type, sourceKey && component[sourceKey], component, kind, from, to)) changed = true;
        }
        // What a prefab instance changes inside its prefab, by component key: "mesh", "script:spin"
        for (const override of Object.values(entity.overrides ?? {})) {
            for (const [key, fields] of Object.entries(override.components ?? {})) {
                const [type, ...name] = key.split(":");
                const sourceKey = componentDefs[type]?.source?.key;
                const sourceName = name.length > 0 ? name.join(":") : sourceKey && fields[sourceKey];
                if (renameInComponent(registry, type, sourceName, fields, kind, from, to)) changed = true;
            }
            // The entities the instance adds are ordinary ones
            if (renameInEntities(registry, override.addChildren ?? [], kind, from, to)) changed = true;
        }
        if (renameInEntities(registry, entity.children ?? [], kind, from, to)) changed = true;
    }
    return changed;
}

export function renameInScene(registry: Registry, scene: Partial<SceneData>, kind: Kind, from: string, to: string): boolean {
    const inEnvironment = renameInFields(environmentFields, scene.environment as Record<string, unknown> | undefined, kind, from, to);
    const inEntities = renameInEntities(registry, scene.entities ?? [], kind, from, to);
    return inEnvironment || inEntities;
}
