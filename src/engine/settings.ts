// The settings of a project: projects/<name>/project.json. The file may be missing.
//   { "layers": ["Player", "Enemy", "Pickup"], "noCollision": [["Player", "Pickup"], ["Enemy", "Enemy"]] }
//
// Layers are for colliders, like in Unity: a collider names its layer, and the pairs of "noCollision" are the
// layers whose colliders do not notice each other: they neither stop each other nor get "enter" / "exit".
// Every other pair collides. A collider without a layer is on DEFAULT_LAYER, which always exists.

export const DEFAULT_LAYER = "Default";

export interface ProjectSettings {
    // The layers of the project besides DEFAULT_LAYER
    layers: string[];
    // Pairs of layers that do not collide; a pair of one layer twice: its colliders ignore each other
    noCollision: [string, string][];
}

export const defaultSettings: ProjectSettings = { layers: [], noCollision: [] };

// Reads project.json leniently: what is not as it should be is left out (validateSettings() tells about it)
export function parseSettings(data: unknown): ProjectSettings {
    const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const layers = Array.isArray(raw.layers) ? raw.layers.filter((name): name is string => typeof name === "string" && name !== "") : [];
    const pairs = Array.isArray(raw.noCollision) ? raw.noCollision : [];
    return {
        layers: [...new Set(layers)].filter((name) => name !== DEFAULT_LAYER),
        noCollision: pairs.filter(
            (pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every((name) => typeof name === "string")
        ),
    };
}

// The layer a collider is on, by what its "layer" field says
export const layerOf = (name: unknown) => (typeof name === "string" && name !== "" ? name : DEFAULT_LAYER);

// true if colliders of these two layers notice each other
export function layersCollide(settings: ProjectSettings, a: string, b: string) {
    return !settings.noCollision.some(([first, second]) => (first === a && second === b) || (first === b && second === a));
}

// The same settings with the pair switched: `collide` false puts it into "noCollision", true takes it out
export function setLayersCollide(settings: ProjectSettings, a: string, b: string, collide: boolean): ProjectSettings {
    const others = settings.noCollision.filter(([first, second]) => !((first === a && second === b) || (first === b && second === a)));
    return { ...settings, noCollision: collide ? others : [...others, [a, b]] };
}

// Human-readable problems of project.json as it is written; an empty list means it is fine
export function validateSettings(data: unknown): string[] {
    const problems: string[] = [];
    if (typeof data !== "object" || data === null || Array.isArray(data)) return ["must be an object: { \"layers\": [...], \"noCollision\": [...] }"];
    const raw = data as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
        if (key !== "layers" && key !== "noCollision") problems.push(`unknown field "${key}" (known: layers, noCollision)`);
    }

    const layers = raw.layers ?? [];
    if (!Array.isArray(layers) || layers.some((name) => typeof name !== "string" || name === "")) {
        problems.push('layers: must be a list of names, e.g. ["Player", "Enemy"]');
        return problems;
    }
    if (layers.includes(DEFAULT_LAYER)) problems.push(`layers: "${DEFAULT_LAYER}" always exists, do not list it`);
    if (new Set(layers).size !== layers.length) problems.push("layers: a name is listed twice");

    const known = [DEFAULT_LAYER, ...(layers as string[])];
    const pairs = raw.noCollision ?? [];
    if (!Array.isArray(pairs)) {
        problems.push('noCollision: must be a list of pairs of layers, e.g. [["Player", "Pickup"]]');
        return problems;
    }
    for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some((name) => typeof name !== "string")) {
            problems.push(`noCollision: ${JSON.stringify(pair)} must be a pair of layer names`);
            continue;
        }
        for (const name of pair as string[]) {
            if (!known.includes(name)) problems.push(`noCollision: there is no layer "${name}" (layers: ${known.join(", ")})`);
        }
    }
    return problems;
}
