import type { ParamDef } from "./Registry";
import { brushRegion, DEFAULT_PALETTE, forgetTerrainRange, isPainted } from "./terrain";
import type { TerrainData, TerrainRegion } from "./terrain";

// Making the ground of a terrain by rule instead of by hand: hills out of noise, painted the way they lie.
// The settings are kept in the terrain file (`generator`), so the same ground can be made again, and a
// height depends only on the settings and on the place in the world: two terrains that stand side by side
// and have the same settings meet without a seam.

// The fields of `generator` in a terrain file; the Inspector and the checks are made from them
export const generatorFields = {
    // Another number, another land
    seed: { type: "number", default: 1, min: 0, max: 999999, step: 1 },
    // Meters from the hollows to the tops of the hills, about
    height: { type: "number", default: 12, min: 0, step: 1 },
    // Meters across a hill
    size: { type: "number", default: 60, min: 1, step: 5 },
    // Meters of small bumps on top of the hills
    detail: { type: "number", default: 0.6, min: 0, step: 0.1 },
    // Paints the ground as it is made: the numbers below are places in the usual palette
    paint: { type: "boolean", default: true },
    // Rock where the ground rises more than this for every meter across (1 is 45 degrees)
    rock: { type: "number", default: 0.7, min: 0, step: 0.05, when: { paint: [true] } },
    // Sand below this height and snow above this one, meters from the entity
    sandBelow: { type: "number", default: -3, step: 0.5, when: { paint: [true] } },
    snowAbove: { type: "number", default: 100, step: 0.5, when: { paint: [true] } },
} satisfies Record<string, ParamDef>;

export interface GeneratorSettings {
    seed: number;
    height: number;
    size: number;
    detail: number;
    paint: boolean;
    rock: number;
    sandBelow: number;
    snowAbove: number;
}

export const defaultGenerator = Object.fromEntries(Object.entries(generatorFields).map(([key, def]) => [key, def.default])) as unknown as GeneratorSettings;

// The settings of a terrain with the usual values where it names none
export function generatorOf(data: TerrainData): GeneratorSettings {
    return { ...defaultGenerator, ...(data.generator as Partial<GeneratorSettings> | undefined) };
}

// Where the kinds of ground the generator paints with are in the usual palette (DEFAULT_PALETTE)
const GRASS = 0;
const ROCK = 2;
const SAND = 3;
const SNOW = 4;

// A number from 0 to 1 for a corner of the grid of the noise: always the same for the same corner and seed
function corner(x: number, z: number, seed: number) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smooth noise, 0 to 1: the numbers of the corners around a point, blended; then the same at twice the
// detail and half the strength, `octaves` times over
export function noise2D(x: number, z: number, seed: number, octaves = 4) {
    let sum = 0;
    let strength = 0.5;
    let total = 0;
    for (let n = 0; n < octaves; n++) {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        const fx = x - ix;
        const fz = z - iz;
        const u = fx * fx * (3 - 2 * fx);
        const v = fz * fz * (3 - 2 * fz);
        const a = corner(ix, iz, seed + n);
        const b = corner(ix + 1, iz, seed + n);
        const c = corner(ix, iz + 1, seed + n);
        const d = corner(ix + 1, iz + 1, seed + n);
        sum += (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * strength;
        total += strength;
        strength /= 2;
        x *= 2;
        z *= 2;
    }
    return sum / total;
}

// The height the settings give at a place of the world, meters
export function generatedHeight(settings: GeneratorSettings, x: number, z: number) {
    // The noise keeps to the middle of its range: stretched so that the hills are about as high as asked
    const hills = (noise2D(x / settings.size, z / settings.size, settings.seed, 4) - 0.5) * 1.7 * settings.height;
    const bumps = settings.detail > 0 ? (noise2D(x / (settings.size / 8) + 100, z / (settings.size / 8) + 100, settings.seed + 50, 2) - 0.5) * 2 * settings.detail : 0;
    return hills + bumps;
}

// Makes the ground of `data` by its settings, in place: the heights and, with `paint`, the colors.
// `offset` is where the middle of the terrain is in the world (x and z). With `area`, only within `radius`
// meters of a point (x and z from the middle of the terrain), `amount` of the way there in the middle (0 to 1)
// and less towards the edge: the brush. Without it, the whole ground at once.
// Returns the part of the grid it has written, or null if it reached none.
export function generateTerrain(
    data: TerrainData,
    settings: GeneratorSettings,
    offset: { x: number; z: number },
    area?: { x: number; z: number; radius: number; amount: number },
): TerrainRegion | null {
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    const { cell } = data;
    const region: TerrainRegion | null = area ? brushRegion(data, area.x, area.z, area.radius) : { fromI: 0, toI: columns - 1, fromJ: 0, toJ: rows - 1 };
    if (!region) return null;
    if (settings.paint && !isPainted(data)) {
        data.palette = data.palette?.length ? data.palette : [...DEFAULT_PALETTE];
        data.colors = data.heights.map((row) => row.map(() => 0));
    }
    const kinds = data.palette?.length ?? 0;
    // A palette that has been cut short has no such kind of ground: its first one is taken
    const kind = (n: number) => (n < kinds ? n : 0);

    // The heights the settings give, for the part and one more height around it: the slope needs neighbors
    const fromI = region.fromI - 1;
    const fromJ = region.fromJ - 1;
    const wide = region.toI - region.fromI + 3;
    const made = new Float64Array(wide * (region.toJ - region.fromJ + 3));
    for (let j = fromJ; j <= region.toJ + 1; j++) {
        for (let i = fromI; i <= region.toI + 1; i++) {
            made[(j - fromJ) * wide + (i - fromI)] = generatedHeight(settings, offset.x + (i - (columns - 1) / 2) * cell, offset.z + (j - (rows - 1) / 2) * cell);
        }
    }
    const at = (i: number, j: number) => made[(j - fromJ) * wide + (i - fromI)];

    const u = area ? area.x / cell + (columns - 1) / 2 : 0;
    const v = area ? area.z / cell + (rows - 1) / 2 : 0;
    const span = area ? area.radius / cell : 1;
    forgetTerrainRange(data);
    for (let j = region.fromJ; j <= region.toJ; j++) {
        for (let i = region.fromI; i <= region.toI; i++) {
            let part = 1;
            let fade = 1;
            if (area) {
                const distance = Math.hypot(i - u, j - v) / span;
                if (distance > 1) continue;
                fade = (1 - distance * distance) ** 2;
                part = Math.min(1, area.amount * fade);
            }
            const height = at(i, j);
            data.heights[j][i] += (height - data.heights[j][i]) * part;
            // The rim of the brush barely moves the ground: it keeps its paint
            if (!settings.paint || !data.colors || fade < 0.25) continue;
            const steep = Math.hypot(at(i + 1, j) - at(i - 1, j), at(i, j + 1) - at(i, j - 1)) / (2 * cell);
            data.colors[j][i] = kind(steep > settings.rock ? ROCK : height > settings.snowAbove ? SNOW : height < settings.sandBelow ? SAND : GRASS);
        }
    }
    return region;
}

// Problems of the `generator` of a terrain file
export function validateGenerator(generator: unknown): string[] {
    if (typeof generator !== "object" || generator === null || Array.isArray(generator)) return ['generator: must be an object, e.g. { "seed": 7, "height": 20 }'];
    const problems: string[] = [];
    for (const [key, value] of Object.entries(generator)) {
        const def = (generatorFields as Record<string, ParamDef>)[key];
        if (!def) {
            problems.push(`generator: unknown field "${key}" (known: ${Object.keys(generatorFields).join(", ")})`);
        } else if (def.type === "boolean" ? typeof value !== "boolean" : typeof value !== "number" || Number.isNaN(value)) {
            problems.push(`generator.${key}: must be ${def.type === "boolean" ? "true or false" : "a number"}`);
        } else if (def.type === "number" && def.min !== undefined && (value as number) < def.min) {
            problems.push(`generator.${key}: must be >= ${def.min}`);
        }
    }
    return problems;
}
