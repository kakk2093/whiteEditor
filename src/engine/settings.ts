// The settings of a project: projects/<name>/project.json. The file may be missing, and so may any field.
//   {
//     "startScene": "menu",
//     "aspect": "16:9",
//     "gravity": 20,
//     "tags": ["player", "enemy"],
//     "layers": ["Player", "Enemy", "Pickup"],
//     "noCollision": [["Player", "Pickup"], ["Enemy", "Enemy"]]
//   }
//
// Layers are for colliders, like in Unity: a collider names its layer, and the pairs of "noCollision" are the
// layers whose colliders do not notice each other: they neither stop each other nor get "enter" / "exit".
// Every other pair collides. A collider without a layer is on DEFAULT_LAYER, which always exists.

export const DEFAULT_LAYER = "Default";

// The shapes the picture of the game can be given; "free" fills the window, whatever its shape
export const ASPECTS = ["free", "16:9", "16:10", "4:3", "1:1", "9:16"] as const;

export interface ProjectSettings {
    // The scene a built game starts with; "" is "main", or the first one if there is no "main"
    startScene: string;
    // The shape of the picture of the game, one of ASPECTS; the rest of the window stays black
    aspect: string;
    // How fast the bodies of the physics gain speed downwards, meters per second squared. 20 by default, like
    // self.fall(): games feel better heavier than the real 9.8.
    gravity: number;
    // The tags of the project. With a list, a tag that is not in it is a mistake (check tells); an empty
    // list lets any tag be.
    tags: string[];
    // The layers of the project besides DEFAULT_LAYER
    layers: string[];
    // Pairs of layers that do not collide; a pair of one layer twice: its colliders ignore each other
    noCollision: [string, string][];
}

export const DEFAULT_GRAVITY = 20;

export const defaultSettings: ProjectSettings = { startScene: "", aspect: "free", gravity: DEFAULT_GRAVITY, tags: [], layers: [], noCollision: [] };

const names = (value: unknown) => (Array.isArray(value) ? [...new Set(value.filter((name): name is string => typeof name === "string" && name !== ""))] : []);

// Reads project.json leniently: what is not as it should be is left out (validateSettings() tells about it)
export function parseSettings(data: unknown): ProjectSettings {
    const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const pairs = Array.isArray(raw.noCollision) ? raw.noCollision : [];
    return {
        startScene: typeof raw.startScene === "string" ? raw.startScene : "",
        aspect: typeof raw.aspect === "string" && (ASPECTS as readonly string[]).includes(raw.aspect) ? raw.aspect : "free",
        gravity: typeof raw.gravity === "number" && !Number.isNaN(raw.gravity) ? raw.gravity : DEFAULT_GRAVITY,
        tags: names(raw.tags),
        layers: names(raw.layers).filter((name) => name !== DEFAULT_LAYER),
        noCollision: pairs.filter(
            (pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every((name) => typeof name === "string")
        ),
    };
}

// The settings as they are written to project.json: what has its default value is left out
export function serializeSettings(settings: ProjectSettings) {
    return {
        ...(settings.startScene ? { startScene: settings.startScene } : {}),
        ...(settings.aspect !== "free" ? { aspect: settings.aspect } : {}),
        ...(settings.gravity !== DEFAULT_GRAVITY ? { gravity: settings.gravity } : {}),
        ...(settings.tags.length > 0 ? { tags: settings.tags } : {}),
        ...(settings.layers.length > 0 ? { layers: settings.layers } : {}),
        ...(settings.noCollision.length > 0 ? { noCollision: settings.noCollision } : {}),
    };
}

// Width / height of the picture of the game; null if it takes the shape of its window
export function aspectRatio(settings: ProjectSettings): number | null {
    const [width, height] = settings.aspect.split(":").map(Number);
    return width > 0 && height > 0 ? width / height : null;
}

// The biggest area of that shape inside a width x height box, centered; the whole box if there is no shape.
// `left` and `top` are from the corner of the box.
export function fitAspect(settings: ProjectSettings, width: number, height: number) {
    const ratio = aspectRatio(settings);
    if (!ratio || width <= 0 || height <= 0) return { left: 0, top: 0, width, height };
    const fitted = width / height > ratio ? { width: Math.round(height * ratio), height } : { width, height: Math.round(width / ratio) };
    return { left: Math.round((width - fitted.width) / 2), top: Math.round((height - fitted.height) / 2), ...fitted };
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

// The same settings with a layer under another name, in the list and in the pairs
export function renameLayerIn(settings: ProjectSettings, from: string, to: string): ProjectSettings {
    const swap = (name: string) => (name === from ? to : name);
    return { ...settings, layers: settings.layers.map(swap), noCollision: settings.noCollision.map(([a, b]) => [swap(a), swap(b)]) };
}

// Human-readable problems of project.json as it is written; an empty list means it is fine.
// `scenes` are the names of the scenes of the project, if they are known: the start scene must be one of them.
export function validateSettings(data: unknown, scenes?: string[]): string[] {
    const problems: string[] = [];
    if (typeof data !== "object" || data === null || Array.isArray(data)) return ["must be an object: { \"layers\": [...], \"noCollision\": [...] }"];
    const raw = data as Record<string, unknown>;
    const known = ["startScene", "aspect", "gravity", "tags", "layers", "noCollision"];
    for (const key of Object.keys(raw)) {
        if (!known.includes(key)) problems.push(`unknown field "${key}" (known: ${known.join(", ")})`);
    }

    if (raw.startScene !== undefined) {
        if (typeof raw.startScene !== "string") problems.push("startScene: must be the name of a scene");
        else if (raw.startScene && scenes && !scenes.includes(raw.startScene)) {
            problems.push(`startScene: there is no scene "${raw.startScene}" (scenes: ${scenes.join(", ") || "none"})`);
        }
    }
    if (raw.aspect !== undefined && !(ASPECTS as readonly unknown[]).includes(raw.aspect)) {
        problems.push(`aspect: must be one of: ${ASPECTS.join(", ")}`);
    }
    if (raw.gravity !== undefined && (typeof raw.gravity !== "number" || Number.isNaN(raw.gravity))) {
        problems.push("gravity: must be a number, e.g. 20");
    }
    const tags = raw.tags ?? [];
    if (!Array.isArray(tags) || tags.some((name) => typeof name !== "string" || name === "")) {
        problems.push('tags: must be a list of words, e.g. ["player", "enemy"]');
    } else if (new Set(tags).size !== tags.length) {
        problems.push("tags: a tag is listed twice");
    }

    const layers = raw.layers ?? [];
    if (!Array.isArray(layers) || layers.some((name) => typeof name !== "string" || name === "")) {
        problems.push('layers: must be a list of names, e.g. ["Player", "Enemy"]');
        return problems;
    }
    if (layers.includes(DEFAULT_LAYER)) problems.push(`layers: "${DEFAULT_LAYER}" always exists, do not list it`);
    if (new Set(layers).size !== layers.length) problems.push("layers: a name is listed twice");

    const all = [DEFAULT_LAYER, ...(layers as string[])];
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
            if (!all.includes(name)) problems.push(`noCollision: there is no layer "${name}" (layers: ${all.join(", ")})`);
        }
    }
    return problems;
}
