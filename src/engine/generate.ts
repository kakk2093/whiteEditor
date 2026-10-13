import type { ParamDef } from "./Registry";
import { brushRegion, DEFAULT_PALETTE, forgetTerrainRange, isPainted, MAX_TERRAIN_COLORS, terrainSize } from "./terrain";
import type { ScatterItem, TerrainData, TerrainRegion } from "./terrain";

// Making the ground of a terrain by rule instead of by hand: hills out of noise, painted the way they lie,
// with props strewn over them. The settings are kept in the terrain file (`generator`), so the same ground
// can be made again, and everything depends only on the settings and on the place in the world: two terrains
// that stand side by side and have the same settings meet without a seam.
//
// A terrain either has its own few settings (hills and the usual paint), or names a biome: an asset,
// biomes/<name>.json, that says what a kind of land is like — how high and how wide its hills are, what its
// ground is painted with, what grows on it. Several terrains can name one biome, and a brush can lay one
// biome next to another on the same ground.
//
// The ground remembers which biome was laid where (`biomes` and `biomeMap` of the terrain file), so it can
// be made again as a whole: every part by its own biome, the land of one going over into the land of the
// next. Ground that no biome has made (shaped by hand, or by the plain hills) is left as it is.

// The fields of `generator` in a terrain file; the Inspector and the checks are made from them
export const generatorFields = {
    // Another number, another land
    seed: { type: "number", default: 1, min: 0, max: 999999, step: 1 },
    // The kind of land (biomes/<name>.json): its shape, paint and props; none is plain hills by the fields below
    biome: { type: "asset", kind: "biome", default: "" },
    // Meters from the hollows to the tops of the hills, about
    height: { type: "number", default: 12, min: 0, step: 1, when: { biome: [""] } },
    // Meters across a hill
    size: { type: "number", default: 60, min: 1, step: 5, when: { biome: [""] } },
    // Meters of small bumps on top of the hills
    detail: { type: "number", default: 0.6, min: 0, step: 0.1, when: { biome: [""] } },
    // Paints the ground as it is made: the numbers below are places in the usual palette
    paint: { type: "boolean", default: true, when: { biome: [""] } },
    // Rock where the ground rises more than this for every meter across (1 is 45 degrees)
    rock: { type: "number", default: 0.7, min: 0, step: 0.05, when: { biome: [""], paint: [true] } },
    // Sand below this height and snow above this one, meters from the entity
    sandBelow: { type: "number", default: -3, step: 0.5, when: { biome: [""], paint: [true] } },
    snowAbove: { type: "number", default: 100, step: 0.5, when: { biome: [""], paint: [true] } },
} satisfies Record<string, ParamDef>;

export interface GeneratorSettings {
    seed: number;
    biome: string;
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

// The fields of a biome asset, but for its props
export const biomeFields = {
    // How high the land lies as a whole, meters: a swamp below zero, a plateau above
    base: { type: "number", default: 0, step: 1 },
    // Meters from the hollows to the tops of the hills, about
    height: { type: "number", default: 12, min: 0, step: 1 },
    // Meters across a hill
    size: { type: "number", default: 60, min: 1, step: 5 },
    // Meters of small bumps on top of the hills
    detail: { type: "number", default: 0.6, min: 0, step: 0.1 },
    // What the ground is painted with
    ground: { type: "color", default: "#6f9a4a" },
    // ...where it rises more than `rockSlope` for every meter across (1 is 45 degrees)
    rock: { type: "color", default: "#8b8d8f" },
    rockSlope: { type: "number", default: 0.7, min: 0, step: 0.05 },
    // ...below this height, meters (sand, mud)
    low: { type: "color", default: "#d6c58f" },
    lowBelow: { type: "number", default: -3, step: 0.5 },
    // ...and above this one (snow)
    high: { type: "color", default: "#eef2f5" },
    highAbove: { type: "number", default: 100, step: 0.5 },
} satisfies Record<string, ParamDef>;

// The fields of one kind of props of a biome
export const biomePropFields = {
    prefab: { type: "asset", kind: "prefab", default: "" },
    // Meters between neighbor copies, about
    spacing: { type: "number", default: 4, min: 0.25, step: 0.5 },
    // Each copy is from so many to so many times the size of the prefab
    sizeMin: { type: "number", default: 0.8, min: 0.01, step: 0.1 },
    sizeMax: { type: "number", default: 1.2, min: 0.01, step: 0.1 },
    // How much of the land has them: 1 is all of it, less leaves clearings between groves
    cover: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
    // They do not grow where the ground rises more than this for every meter across
    maxSlope: { type: "number", default: 0.5, min: 0, step: 0.05 },
    // ...nor below this height or above that one, meters
    minHeight: { type: "number", default: -1000, step: 1 },
    maxHeight: { type: "number", default: 1000, step: 1 },
} satisfies Record<string, ParamDef>;

export interface BiomeProp {
    prefab: string;
    spacing: number;
    sizeMin: number;
    sizeMax: number;
    cover: number;
    maxSlope: number;
    minHeight: number;
    maxHeight: number;
}

// A biome asset as it is in its file: any field may be missing
export interface BiomeData {
    base?: number;
    height?: number;
    size?: number;
    detail?: number;
    ground?: string;
    rock?: string;
    rockSlope?: number;
    low?: string;
    lowBelow?: number;
    high?: string;
    highAbove?: number;
    props?: Partial<BiomeProp>[];
}

const defaultsOf = (defs: Record<string, ParamDef>) => Object.fromEntries(Object.entries(defs).map(([key, def]) => [key, def.default]));

export const defaultBiome = defaultsOf(biomeFields) as unknown as Required<Omit<BiomeData, "props">>;

export const defaultBiomeProp = defaultsOf(biomePropFields) as unknown as BiomeProp;

// Where the kinds of ground a terrain without a biome is painted with are in the usual palette (DEFAULT_PALETTE)
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

// The shape of a land: what generatedHeight() needs
interface Relief {
    seed: number;
    height: number;
    size: number;
    detail: number;
    base?: number;
}

// The height the settings give at a place of the world, meters
export function generatedHeight(settings: Relief, x: number, z: number) {
    // The noise keeps to the middle of its range: stretched so that the hills are about as high as asked
    const hills = (noise2D(x / settings.size, z / settings.size, settings.seed, 4) - 0.5) * 1.7 * settings.height;
    const bumps = settings.detail > 0 ? (noise2D(x / (settings.size / 8) + 100, z / (settings.size / 8) + 100, settings.seed + 50, 2) - 0.5) * 2 * settings.detail : 0;
    return (settings.base ?? 0) + hills + bumps;
}

// The place of a color in the palette of a terrain; a color it does not have yet is added at its end
// (a palette that is full gives its first one)
function colorOf(data: TerrainData, color: string) {
    data.palette ??= [];
    const found = data.palette.findIndex((each) => each.toLowerCase() === color.toLowerCase());
    if (found >= 0) return found;
    if (data.palette.length >= MAX_TERRAIN_COLORS) return 0;
    data.palette.push(color);
    return data.palette.length - 1;
}

// The props a biome gives a piece of land: for every kind, a place in every square of a grid of the world
// that is `spacing` wide, moved about inside its square, kept if the land there suits the kind. `inside`
// tells whether a place (x and z from the middle of the terrain) is to be planted at all.
function biomeProps(biome: BiomeData, relief: Relief, offset: { x: number; z: number }, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, inside: (x: number, z: number) => boolean) {
    const planted = new Map<string, ScatterItem[]>();
    (biome.props ?? []).forEach((given, k) => {
        const prop = { ...defaultBiomeProp, ...given };
        if (!prop.prefab || !(prop.spacing > 0)) return;
        const seed = relief.seed + 1000 + k * 17;
        const step = prop.spacing;
        // The noise keeps to the middle of its range: a cover of 1 is everywhere, of 0 nowhere
        const most = 0.5 + (prop.cover - 0.5) * 1.3;
        const items = planted.get(prop.prefab) ?? [];
        for (let gz = Math.floor((offset.z + bounds.minZ) / step); gz <= Math.floor((offset.z + bounds.maxZ) / step); gz++) {
            for (let gx = Math.floor((offset.x + bounds.minX) / step); gx <= Math.floor((offset.x + bounds.maxX) / step); gx++) {
                // In the world: the same place whichever terrain asks, and however much of it is planted
                const wx = (gx + 0.15 + 0.7 * corner(gx, gz, seed)) * step;
                const wz = (gz + 0.15 + 0.7 * corner(gx, gz, seed + 1)) * step;
                const x = Math.round((wx - offset.x) * 100) / 100;
                const z = Math.round((wz - offset.z) * 100) / 100;
                if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ || !inside(x, z)) continue;
                // Groves and clearings: wide patches of the noise
                if (noise2D(wx / (step * 6) + 31, wz / (step * 6) - 17, seed + 2, 2) > most) continue;
                const height = generatedHeight(relief, wx, wz);
                if (height < prop.minHeight || height > prop.maxHeight) continue;
                const steep = Math.hypot(generatedHeight(relief, wx + 1, wz) - generatedHeight(relief, wx - 1, wz), generatedHeight(relief, wx, wz + 1) - generatedHeight(relief, wx, wz - 1)) / 2;
                if (steep > prop.maxSlope) continue;
                const size = prop.sizeMin + (prop.sizeMax - prop.sizeMin) * corner(gx, gz, seed + 3);
                items.push([x, z, Math.floor(corner(gx, gz, seed + 4) * 360), Math.round(size * 100) / 100]);
            }
        }
        planted.set(prop.prefab, items);
    });
    return planted;
}

// The part of the radius of a brush within which it also paints and plants: its rim barely moves the ground
const BRUSH_CORE = 0.7;

// Makes the ground of `data` by its settings, in place: the heights, the colors and, with a biome, the props.
// `offset` is where the middle of the terrain is in the world (x and z). With `area`, only within `radius`
// meters of a point (x and z from the middle of the terrain), `amount` of the way there in the middle (0 to 1)
// and less towards the edge: the brush. Without it, the whole ground at once. `biome` is the biome the
// settings name, if there is one: with it the land is the biome's, and the props that stood there are
// replaced by those of the biome.
// Returns the part of the grid it has written, or null if it reached none.
export function generateTerrain(
    data: TerrainData,
    settings: GeneratorSettings,
    offset: { x: number; z: number },
    area?: { x: number; z: number; radius: number; amount: number },
    biome?: BiomeData,
): TerrainRegion | null {
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    const { cell } = data;
    const region: TerrainRegion | null = area ? brushRegion(data, area.x, area.z, area.radius) : { fromI: 0, toI: columns - 1, fromJ: 0, toJ: rows - 1 };
    if (!region) return null;
    const land = biome ? { ...defaultBiome, ...biome } : null;
    const relief: Relief = land ? { seed: settings.seed, height: land.height, size: land.size, detail: land.detail, base: land.base } : settings;
    const paint = land ? true : settings.paint;
    if (paint && !isPainted(data)) {
        data.palette = data.palette?.length ? data.palette : [...DEFAULT_PALETTE];
        data.colors = data.heights.map((row) => row.map(() => 0));
    }
    const kinds = data.palette?.length ?? 0;
    // A palette that has been cut short has no such kind of ground: its first one is taken
    const kind = (n: number) => (n < kinds ? n : 0);
    // What the ground is painted with, by how it lies: the colors of the biome, or the usual kinds
    // Where the biome is laid is written down: generateByMap() makes the ground again by that
    let mark = -1;
    if (land && settings.biome) {
        data.biomes ??= [];
        if (!data.biomes.includes(settings.biome)) data.biomes.push(settings.biome);
        mark = data.biomes.indexOf(settings.biome);
        data.biomeMap ??= data.heights.map((row) => row.map(() => -1));
    }
    const colors = land
        ? { ground: colorOf(data, land.ground), rock: colorOf(data, land.rock), low: colorOf(data, land.low), high: colorOf(data, land.high) }
        : { ground: kind(GRASS), rock: kind(ROCK), low: kind(SAND), high: kind(SNOW) };
    const limits = land ? { rock: land.rockSlope, low: land.lowBelow, high: land.highAbove } : { rock: settings.rock, low: settings.sandBelow, high: settings.snowAbove };

    // The heights the settings give, for the part and one more height around it: the slope needs neighbors
    const fromI = region.fromI - 1;
    const fromJ = region.fromJ - 1;
    const wide = region.toI - region.fromI + 3;
    const made = new Float64Array(wide * (region.toJ - region.fromJ + 3));
    for (let j = fromJ; j <= region.toJ + 1; j++) {
        for (let i = fromI; i <= region.toI + 1; i++) {
            made[(j - fromJ) * wide + (i - fromI)] = generatedHeight(relief, offset.x + (i - (columns - 1) / 2) * cell, offset.z + (j - (rows - 1) / 2) * cell);
        }
    }
    const at = (i: number, j: number) => made[(j - fromJ) * wide + (i - fromI)];

    const u = area ? area.x / cell + (columns - 1) / 2 : 0;
    const v = area ? area.z / cell + (rows - 1) / 2 : 0;
    const span = area ? area.radius / cell : 1;
    // The rim of the brush barely moves the ground: it keeps its paint and its props
    const core = (1 - BRUSH_CORE * BRUSH_CORE) ** 2;
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
            if (fade < core) continue;
            if (mark >= 0 && data.biomeMap) data.biomeMap[j][i] = mark;
            if (!paint || !data.colors) continue;
            const steep = Math.hypot(at(i + 1, j) - at(i - 1, j), at(i, j + 1) - at(i, j - 1)) / (2 * cell);
            data.colors[j][i] = steep > limits.rock ? colors.rock : height > limits.high ? colors.high : height < limits.low ? colors.low : colors.ground;
        }
    }

    if (land) {
        // The props of the land that was there go, those of the biome come
        const [width, depth] = terrainSize(data);
        const reach = area ? area.radius * BRUSH_CORE : Infinity;
        const inside = (x: number, z: number) => !area || Math.hypot(x - area.x, z - area.z) <= reach;
        const bounds = {
            minX: Math.max(-width / 2, area ? area.x - reach : -Infinity),
            maxX: Math.min(width / 2, area ? area.x + reach : Infinity),
            minZ: Math.max(-depth / 2, area ? area.z - reach : -Infinity),
            maxZ: Math.min(depth / 2, area ? area.z + reach : Infinity),
        };
        const kept = (data.scatter ?? []).map((layer) => ({ prefab: layer.prefab, items: layer.items.filter((item) => !inside(item[0], item[1])) }));
        for (const [prefab, items] of biomeProps(biome!, relief, offset, bounds, inside)) {
            const layer = kept.find((each) => each.prefab === prefab);
            if (layer) layer.items.push(...items);
            else kept.push({ prefab, items });
        }
        const scatter = kept.filter((layer) => layer.items.length > 0);
        if (scatter.length > 0) data.scatter = scatter;
        else delete data.scatter;
    }
    return region;
}

// Meters over which the land of one biome goes over into the land of its neighbor
const BIOME_BLEND = 24;

// The average over a square of `reach` heights each way of a number every height has (the part of the
// square that is off the ground counts as nothing)
function blurred(rows: number, columns: number, reach: number, value: (i: number, j: number) => number) {
    const along = new Float32Array(rows * columns);
    const both = new Float32Array(rows * columns);
    const span = 2 * reach + 1;
    // A window that slides along the rows, then along the columns: every height is added and taken off once
    for (let j = 0; j < rows; j++) {
        let sum = 0;
        for (let i = -reach; i < columns; i++) {
            if (i + reach < columns) sum += value(i + reach, j);
            if (i - reach - 1 >= 0) sum -= value(i - reach - 1, j);
            if (i >= 0) along[j * columns + i] = sum / span;
        }
    }
    for (let i = 0; i < columns; i++) {
        let sum = 0;
        for (let j = -reach; j < rows; j++) {
            if (j + reach < rows) sum += along[(j + reach) * columns + i];
            if (j - reach - 1 >= 0) sum -= along[(j - reach - 1) * columns + i];
            if (j >= 0) both[j * columns + i] = sum / span;
        }
    }
    return both;
}

// Makes the whole ground of `data` again by the map of its biomes, in place: every part by the biome that
// was laid there, with the land of neighbor biomes blended across `BIOME_BLEND` meters; painted and planted
// by the biome of each place. Ground that has no biome keeps its heights, its paint and its props; the land
// of a biome next to it comes down (or up) to it over the same distance. `biomeOf` gives the biome of a
// name, if the project has it. Making the same ground twice gives the same ground.
// Returns false, with nothing done, if the ground has no map.
export function generateByMap(data: TerrainData, settings: GeneratorSettings, offset: { x: number; z: number }, biomeOf: (name: string) => BiomeData | undefined) {
    const map = data.biomeMap;
    const names = data.biomes;
    if (!map || !names) return false;
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    const { cell } = data;
    const [width, depth] = terrainSize(data);
    const given = names.map((name) => biomeOf(name));
    const lands = given.map((biome) => (biome ? { ...defaultBiome, ...biome } : null));
    const reliefs = lands.map((land): Relief | null => (land ? { seed: settings.seed, height: land.height, size: land.size, detail: land.detail, base: land.base } : null));
    const used = new Set(map.flat());
    const reach = Math.max(1, Math.round(BIOME_BLEND / 2 / cell));
    // How much of every biome there is around every height
    const weights = lands.map((land, k) => (land && used.has(k) ? blurred(rows, columns, reach, (i, j) => (map[j][i] === k ? 1 : 0)) : null));
    // ...and of the ground no biome has made (or whose biome is gone), with the height it has there. That
    // ground is never touched, so what it says is the same however often the land around it is made.
    const free = (i: number, j: number) => !lands[map[j][i]];
    const freeWeight = blurred(rows, columns, reach, (i, j) => (free(i, j) ? 1 : 0));
    const freeHeight = blurred(rows, columns, reach, (i, j) => (free(i, j) ? data.heights[j][i] : 0));

    // How far every height is from the nearest ground that is free, in heights (two sweeps over the grid: a
    // step along a row or a column is 1, across a corner 1.41). A small piece of free ground is little of
    // what is around a height, but it is near: so the land comes to it by the distance, not by the share.
    const far = new Float32Array(rows * columns);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < columns; i++) {
            const n = j * columns + i;
            far[n] = free(i, j) ? 0 : Math.min(
                reach + 1,
                i > 0 ? far[n - 1] + 1 : Infinity,
                j > 0 ? far[n - columns] + 1 : Infinity,
                i > 0 && j > 0 ? far[n - columns - 1] + Math.SQRT2 : Infinity,
                i < columns - 1 && j > 0 ? far[n - columns + 1] + Math.SQRT2 : Infinity,
            );
        }
    }
    for (let j = rows - 1; j >= 0; j--) {
        for (let i = columns - 1; i >= 0; i--) {
            const n = j * columns + i;
            far[n] = Math.min(
                far[n],
                i < columns - 1 ? far[n + 1] + 1 : Infinity,
                j < rows - 1 ? far[n + columns] + 1 : Infinity,
                i < columns - 1 && j < rows - 1 ? far[n + columns + 1] + Math.SQRT2 : Infinity,
                i > 0 && j < rows - 1 ? far[n + columns - 1] + Math.SQRT2 : Infinity,
            );
        }
    }

    // The heights of the land of the biomes: every biome around has its say by how much of it there is; near
    // free ground the land comes to the height that ground has there
    forgetTerrainRange(data);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < columns; i++) {
            if (free(i, j)) continue;
            const n = j * columns + i;
            let height = 0;
            let said = 0;
            for (let k = 0; k < weights.length; k++) {
                const weight = weights[k]?.[n] ?? 0;
                if (weight <= 0) continue;
                height += weight * generatedHeight(reliefs[k]!, offset.x + (i - (columns - 1) / 2) * cell, offset.z + (j - (rows - 1) / 2) * cell);
                said += weight;
            }
            height = said > 0 ? height / said : data.heights[j][i];
            if (far[n] <= reach && freeWeight[n] > 0) {
                const near = 1 - far[n] / (reach + 1);
                const part = near * near * (3 - 2 * near);
                height += (freeHeight[n] / freeWeight[n] - height) * part;
            }
            data.heights[j][i] = height;
        }
    }

    // The paint: by the biome of the place, and by how the ground lies now that it is made
    if (lands.some((land, k) => land && used.has(k)) && !isPainted(data)) {
        data.palette = data.palette?.length ? data.palette : [...DEFAULT_PALETTE];
        data.colors = data.heights.map((row) => row.map(() => 0));
    }
    const colors = lands.map((land) => (land ? { ground: colorOf(data, land.ground), rock: colorOf(data, land.rock), low: colorOf(data, land.low), high: colorOf(data, land.high) } : null));
    const heightAt = (i: number, j: number) => data.heights[Math.min(rows - 1, Math.max(0, j))][Math.min(columns - 1, Math.max(0, i))];
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < columns; i++) {
            const land = lands[map[j][i]];
            const color = colors[map[j][i]];
            if (!land || !color || !data.colors) continue;
            const height = data.heights[j][i];
            const steep = Math.hypot(heightAt(i + 1, j) - heightAt(i - 1, j), heightAt(i, j + 1) - heightAt(i, j - 1)) / (2 * cell);
            data.colors[j][i] = steep > land.rockSlope ? color.rock : height > land.highAbove ? color.high : height < land.lowBelow ? color.low : color.ground;
        }
    }

    // The props: those that stood on the land of a biome go, every biome plants its own on its land
    const landAt = (x: number, z: number) => {
        const i = Math.min(columns - 1, Math.max(0, Math.round(x / cell + (columns - 1) / 2)));
        const j = Math.min(rows - 1, Math.max(0, Math.round(z / cell + (rows - 1) / 2)));
        return map[j][i];
    };
    const kept = (data.scatter ?? []).map((layer) => ({ prefab: layer.prefab, items: layer.items.filter((item) => !lands[landAt(item[0], item[1])]) }));
    const bounds = { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2 };
    given.forEach((biome, k) => {
        if (!biome || !reliefs[k] || !used.has(k)) return;
        for (const [prefab, items] of biomeProps(biome, reliefs[k], offset, bounds, (x, z) => landAt(x, z) === k)) {
            const layer = kept.find((each) => each.prefab === prefab);
            if (layer) layer.items.push(...items);
            else kept.push({ prefab, items });
        }
    });
    const scatter = kept.filter((layer) => layer.items.length > 0);
    if (scatter.length > 0) data.scatter = scatter;
    else delete data.scatter;
    return true;
}

// How many heights of a ground each of its biomes has; -1 is the ground no biome has made
export function biomeShares(data: TerrainData): Map<string, number> {
    const shares = new Map<string, number>();
    for (const row of data.biomeMap ?? []) {
        for (const k of row) {
            const name = k < 0 ? "" : data.biomes?.[k] ?? "";
            shares.set(name, (shares.get(name) ?? 0) + 1);
        }
    }
    return shares;
}

function checkFields(defs: Record<string, ParamDef>, values: object, where: string, known: { prefabs?: string[]; biomes?: string[] }, problems: string[], skip: string[] = []) {
    for (const [key, value] of Object.entries(values)) {
        if (skip.includes(key)) continue;
        const def = defs[key];
        const at = `${where}${key}`;
        if (!def) {
            problems.push(`${where.replace(/[.:]\s*$/, "")}: unknown field "${key}" (known: ${[...Object.keys(defs), ...skip].join(", ")})`);
        } else if (def.type === "boolean") {
            if (typeof value !== "boolean") problems.push(`${at}: must be true or false`);
        } else if (def.type === "color") {
            if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) problems.push(`${at}: must be a color like "#aabbcc"`);
        } else if (def.type === "asset") {
            const names = def.kind === "biome" ? known.biomes : known.prefabs;
            if (typeof value !== "string") problems.push(`${at}: must be the name of a ${def.kind}`);
            else if (value && names && !names.includes(value)) problems.push(`${at}: ${def.kind} "${value}" does not exist (known: ${names.join(", ") || "none"})`);
        } else if (typeof value !== "number" || Number.isNaN(value)) {
            problems.push(`${at}: must be a number`);
        } else if (def.type === "number" && ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max))) {
            problems.push(`${at}: must be ${def.min !== undefined ? `>= ${def.min}` : ""}${def.min !== undefined && def.max !== undefined ? " and " : ""}${def.max !== undefined ? `<= ${def.max}` : ""}`);
        }
    }
}

// Problems of the `generator` of a terrain file; `known.biomes` are the biomes it may name, if they are known
export function validateGenerator(generator: unknown, known: { biomes?: string[] } = {}): string[] {
    if (typeof generator !== "object" || generator === null || Array.isArray(generator)) return ['generator: must be an object, e.g. { "seed": 7, "height": 20 }'];
    const problems: string[] = [];
    checkFields(generatorFields, generator, "generator.", known, problems);
    return problems;
}

// Problems of a biome asset (biomes/<name>.json as it is on disk); `known.prefabs` are the prefabs of the project
export function validateBiome(data: unknown, known: { prefabs?: string[] } = {}): string[] {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return ['must be an object, e.g. { "height": 20, "ground": "#6f9a4a" }'];
    const problems: string[] = [];
    checkFields(biomeFields, data, "", known, problems, ["props"]);
    const { props } = data as BiomeData;
    if (props !== undefined && !Array.isArray(props)) problems.push('props: must be a list: [{ "prefab": "Pine", "spacing": 4 }]');
    for (const [n, prop] of (Array.isArray(props) ? props : []).entries()) {
        if (typeof prop !== "object" || prop === null) problems.push(`props[${n}]: must be an object: { "prefab": "Pine", "spacing": 4 }`);
        else checkFields(biomePropFields, prop, `props[${n}].`, known, problems);
    }
    return problems;
}
