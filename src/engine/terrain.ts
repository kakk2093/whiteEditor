import * as THREE from "three";
import { validateGenerator } from "./generate";

// The ground of a world: a grid of heights, drawn as a mesh and walked on as it is drawn.
//
// The heights are an asset, terrains/<name>.json; the Terrain component names it. `heights` is a list of
// rows: a row goes along X, the rows follow each other along Z, and neighbors are `cell` meters apart both
// ways. The middle of the grid is where the entity is, a height is counted from the entity upwards.
// The entity only places it: a terrain is never turned and never scaled.
//
// The ground can be painted: `palette` is its kinds of ground as colors (grass, mud, rock...), `colors` says
// for every height which of them is there, by its number in the palette. The color is multiplied by the
// material, so a painted terrain wants a white one (or none).
export interface TerrainData {
    // Meters between two neighbor heights
    cell: number;
    heights: number[][];
    palette?: string[];
    // As many rows of as many numbers as `heights` has
    colors?: number[][];
    // The settings the ground is generated with (see generate.ts); what is not named has its usual value
    generator?: Record<string, number | boolean | string>;
    // The props that stand on the ground (see scatter.ts): for every prefab, its copies
    scatter?: ScatterLayer[];
    // Which biome lies where (see generate.ts): the names of the biomes of this ground, and for every height
    // the number of its biome in that list; -1 is ground no biome has made, which the generator leaves alone
    biomes?: string[];
    biomeMap?: number[][];
}

// A copy of a prefab on the ground: x and z in meters from the middle of the terrain, how far it is turned
// around the vertical (degrees) and how many times the size of the prefab it is. It stands as high as the
// ground is there.
export type ScatterItem = [x: number, z: number, turn: number, size: number];

export interface ScatterLayer {
    prefab: string;
    items: ScatterItem[];
}

// The fields of the Terrain component, defaults filled in (see components.ts)
export interface TerrainFields {
    terrain: string;
    material: string;
    flat: boolean;
    textureSize: number;
    castShadow: boolean;
    receiveShadow: boolean;
    layer?: unknown;
}

// What the mesh of a Terrain component carries in userData.terrain, for the collisions and the physics
export interface TerrainMarker {
    data: TerrainData;
    layer?: unknown;
    // How its geometry was made, for whoever fills it again (fillTerrainGeometry)
    flat: boolean;
}

// The most heights a side of a terrain may have
export const MAX_TERRAIN_SIDE = 1025;

// The most kinds of ground a palette may have
export const MAX_TERRAIN_COLORS = 32;

// What a new terrain is painted with: grass, earth, rock, sand, snow
export const DEFAULT_PALETTE = ["#6f9a4a", "#7a6248", "#8b8d8f", "#d6c58f", "#eef2f5"];

// true if the ground has colors of its own
export function isPainted(data: TerrainData) {
    return !!data.colors && !!data.palette && data.palette.length > 0;
}

// A copy that can be changed without touching the original
export function cloneTerrain(data: TerrainData): TerrainData {
    return {
        cell: data.cell,
        heights: data.heights.map((row) => [...row]),
        ...(data.palette ? { palette: [...data.palette] } : {}),
        ...(data.colors ? { colors: data.colors.map((row) => [...row]) } : {}),
        ...(data.generator ? { generator: { ...data.generator } } : {}),
        ...(data.scatter ? { scatter: data.scatter.map((layer) => ({ prefab: layer.prefab, items: [...layer.items] })) } : {}),
        ...(data.biomes ? { biomes: [...data.biomes] } : {}),
        ...(data.biomeMap ? { biomeMap: data.biomeMap.map((row) => [...row]) } : {}),
    };
}

// The same ground with another size or another cell: `columns` x `rows` cells of `cell` meters around the
// same middle. What was there keeps its shape (the heights are read off the old ground); what is new goes on
// from the edge of the old ground at the height and with the color the edge has there, so there is no cliff.
export function resizeTerrain(data: TerrainData, columns: number, rows: number, cell: number): TerrainData {
    const heights: number[][] = [];
    const colors: number[][] = [];
    const biomeMap: number[][] = [];
    const [width, depth] = terrainSize(data);
    for (let j = 0; j <= rows; j++) {
        const row: number[] = [];
        const paint: number[] = [];
        const lands: number[] = [];
        for (let i = 0; i <= columns; i++) {
            const x = (i - columns / 2) * cell;
            const z = (j - rows / 2) * cell;
            // The nearest place of the old ground: the point itself, or the edge it is beyond
            const nearX = Math.min(width / 2, Math.max(-width / 2, x));
            const nearZ = Math.min(depth / 2, Math.max(-depth / 2, z));
            row.push(Math.round((terrainHeight(data, nearX, nearZ) ?? 0) * 100) / 100);
            const oi = Math.round((nearX + width / 2) / data.cell);
            const oj = Math.round((nearZ + depth / 2) / data.cell);
            paint.push(data.colors?.[oj]?.[oi] ?? 0);
            // New ground past the old edge is nobody's: a biome is laid on it by hand
            lands.push(nearX === x && nearZ === z ? data.biomeMap?.[oj]?.[oi] ?? -1 : -1);
        }
        heights.push(row);
        colors.push(paint);
        biomeMap.push(lands);
    }
    const resized: TerrainData = {
        cell,
        heights,
        ...(data.palette ? { palette: [...data.palette] } : {}),
        ...(data.colors ? { colors } : {}),
        ...(data.generator ? { generator: { ...data.generator } } : {}),
        ...(data.biomes && data.biomeMap ? { biomes: [...data.biomes], biomeMap } : {}),
    };
    const scatter = fitScatter(data.scatter, resized);
    return scatter?.length ? { ...resized, scatter } : resized;
}

// A flat piece: what a Terrain component shows while it names no asset, and what a new asset starts as
export function flatTerrain(cells = 32, cell = 1): TerrainData {
    return { cell, heights: Array.from({ length: cells + 1 }, () => new Array<number>(cells + 1).fill(0)) };
}

// Meters along X and along Z
export function terrainSize(data: TerrainData): [number, number] {
    return [(data.heights[0].length - 1) * data.cell, (data.heights.length - 1) * data.cell];
}

// The lowest and the highest of the heights
export function terrainRange(data: TerrainData): [number, number] {
    const known = ranges.get(data);
    if (known) return known;
    let min = Infinity;
    let max = -Infinity;
    for (const row of data.heights) {
        for (const height of row) {
            if (height < min) min = height;
            if (height > max) max = height;
        }
    }
    ranges.set(data, [min, max]);
    return [min, max];
}

// The ranges counted so far. A big ground has a quarter of a million heights, and its range is asked for at
// every ray and every move of a collider: whoever changes heights in place calls forgetTerrainRange().
const ranges = new WeakMap<TerrainData, [number, number]>();

export function forgetTerrainRange(data: TerrainData) {
    ranges.delete(data);
}

// The cell under a point (x and z from the middle of the terrain), and where in the cell it is, 0 to 1.
// null outside of the terrain.
function cellAt(data: TerrainData, x: number, z: number) {
    const columns = data.heights[0].length - 1;
    const rows = data.heights.length - 1;
    const u = x / data.cell + columns / 2;
    const v = z / data.cell + rows / 2;
    if (u < 0 || v < 0 || u > columns || v > rows) return null;
    const i = Math.min(columns - 1, Math.floor(u));
    const j = Math.min(rows - 1, Math.floor(v));
    return { i, j, fx: u - i, fz: v - j };
}

// The height of the ground over a point, x and z from the middle of the terrain; null outside of it.
// A cell is two triangles, split from its corner of the lowest x and z to the opposite one: the same way
// the mesh is cut and the physics takes it (see physics.ts), so all three agree to the millimeter.
export function terrainHeight(data: TerrainData, x: number, z: number): number | null {
    const at = cellAt(data, x, z);
    if (!at) return null;
    const { i, j, fx, fz } = at;
    const h00 = data.heights[j][i];
    const h11 = data.heights[j + 1][i + 1];
    if (fx >= fz) {
        const h10 = data.heights[j][i + 1];
        return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    }
    const h01 = data.heights[j + 1][i];
    return h00 + (h01 - h00) * fz + (h11 - h01) * fx;
}

// Which way the ground faces at a point (a vector of length 1); straight up outside of the terrain
export function terrainNormal(data: TerrainData, x: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
    const at = cellAt(data, x, z);
    if (!at) return target.set(0, 1, 0);
    const { i, j, fx, fz } = at;
    const h00 = data.heights[j][i];
    const h11 = data.heights[j + 1][i + 1];
    // How much the triangle rises per meter along X and along Z
    let dx: number;
    let dz: number;
    if (fx >= fz) {
        const h10 = data.heights[j][i + 1];
        dx = h10 - h00;
        dz = h11 - h10;
    } else {
        const h01 = data.heights[j + 1][i];
        dx = h11 - h01;
        dz = h01 - h00;
    }
    return target.set(-dx / data.cell, 1, -dz / data.cell).normalize();
}

// Where a ray enters the ground: how far from its start and which way the ground faces there. `origin` is
// counted from the middle of the terrain, `direction` has length 1. null if it misses, or starts under it.
export function rayTerrain(data: TerrainData, origin: THREE.Vector3, direction: THREE.Vector3, reach = Infinity): { distance: number; normal: THREE.Vector3 } | null {
    const [width, depth] = terrainSize(data);
    const [low, high] = terrainRange(data);
    // The stretch of the ray that is over the terrain and not above its highest point
    let from = 0;
    let to = reach;
    const clip = (start: number, step: number, min: number, max: number) => {
        if (Math.abs(step) < 1e-12) return start >= min && start <= max;
        const a = (min - start) / step;
        const b = (max - start) / step;
        from = Math.max(from, Math.min(a, b));
        to = Math.min(to, Math.max(a, b));
        return from <= to;
    };
    if (!clip(origin.x, direction.x, -width / 2, width / 2)) return null;
    if (!clip(origin.z, direction.z, -depth / 2, depth / 2)) return null;
    if (!clip(origin.y, direction.y, low - 1e-6, Math.max(high, origin.y) + 1e-6)) return null;

    // How high over the ground the ray is, this far along
    const over = (distance: number) => {
        const height = terrainHeight(data, origin.x + direction.x * distance, origin.z + direction.z * distance);
        return height === null ? Infinity : origin.y + direction.y * distance - height;
    };
    let before = from;
    if (over(before) < 0) return null;
    // In steps of half a cell, so that no hill is jumped over; then the crossing is narrowed down
    const sideways = Math.hypot(direction.x, direction.z);
    const stride = sideways > 1e-9 ? (data.cell / 2) / sideways : to - from;
    const steps = Math.max(1, Math.ceil((to - from) / Math.max(stride, 1e-9)));
    for (let n = 1; n <= steps; n++) {
        const after = Math.min(to, from + (n * (to - from)) / steps);
        if (over(after) < 0) {
            let a = before;
            let b = after;
            for (let k = 0; k < 24; k++) {
                const middle = (a + b) / 2;
                if (over(middle) < 0) b = middle;
                else a = middle;
            }
            return { distance: a, normal: terrainNormal(data, origin.x + direction.x * a, origin.z + direction.z * a) };
        }
        before = after;
    }
    return null;
}

// Problems of a terrain asset (terrains/<name>.json as it is on disk)
// `known`: the names of the prefabs and of the biomes of the project, if they are known: its props and its
// generator may name only those
export function validateTerrain(data: unknown, known: { prefabs?: string[]; biomes?: string[] } = {}): string[] {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return ["must be an object: { \"cell\": 1, \"heights\": [[0, 0], [0, 0]] }"];
    const problems: string[] = [];
    const { cell, heights, palette, colors, generator, scatter, biomes, biomeMap, ...rest } = data as Record<string, unknown>;
    for (const key of Object.keys(rest)) problems.push(`unknown field "${key}" (known: cell, heights, palette, colors, generator, scatter, biomes, biomeMap)`);
    if (scatter !== undefined) problems.push(...validateScatter(scatter, known.prefabs));
    if (generator !== undefined) problems.push(...validateGenerator(generator, known));
    if (typeof cell !== "number" || !(cell > 0)) problems.push("cell: must be a number of meters above zero");
    if (!Array.isArray(heights) || heights.length < 2) {
        problems.push("heights: must be a list of at least 2 rows, each a list of numbers");
        return problems;
    }
    const length = Array.isArray(heights[0]) ? heights[0].length : 0;
    if (length < 2) problems.push("heights: a row must have at least 2 numbers");
    if (heights.length > MAX_TERRAIN_SIDE || length > MAX_TERRAIN_SIDE) problems.push(`heights: at most ${MAX_TERRAIN_SIDE} rows of at most ${MAX_TERRAIN_SIDE} numbers`);
    for (let j = 0; j < heights.length; j++) {
        const row: unknown = heights[j];
        if (!Array.isArray(row) || row.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
            problems.push(`heights: row ${j + 1} must be a list of numbers`);
            break;
        }
        if (row.length !== length) {
            problems.push(`heights: row ${j + 1} has ${row.length} numbers, the first one has ${length}: every row must be as long`);
            break;
        }
    }
    if (biomes !== undefined || biomeMap !== undefined) {
        const names = Array.isArray(biomes) && biomes.every((name) => typeof name === "string") ? (biomes as string[]) : null;
        if (!names) problems.push('biomes: must be a list of the names of biomes, e.g. ["Meadow", "Swamp"]');
        for (const name of names ?? []) {
            if (known.biomes && !known.biomes.includes(name)) problems.push(`biomes: biome "${name}" does not exist (known: ${known.biomes.join(", ") || "none"})`);
        }
        if (!Array.isArray(biomeMap) || biomeMap.length !== heights.length) {
            problems.push(`biomeMap: must have as many rows as heights (${heights.length})`);
        } else {
            for (let j = 0; j < biomeMap.length; j++) {
                const row: unknown = biomeMap[j];
                if (!Array.isArray(row) || row.length !== length) {
                    problems.push(`biomeMap: row ${j + 1} must have as many numbers as a row of heights (${length})`);
                    break;
                }
                if (row.some((n) => !Number.isInteger(n) || n < -1 || n >= (names?.length ?? 0))) {
                    problems.push(`biomeMap: row ${j + 1}: every number must be a place in "biomes" (0 to ${(names?.length ?? 0) - 1}), or -1 for none`);
                    break;
                }
            }
        }
    }
    const kinds = Array.isArray(palette) ? palette.length : 0;
    if (palette !== undefined) {
        if (!Array.isArray(palette) || !palette.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) {
            problems.push('palette: must be a list of colors like ["#6f9a4a", "#8b8d8f"]');
        } else if (palette.length > MAX_TERRAIN_COLORS) {
            problems.push(`palette: at most ${MAX_TERRAIN_COLORS} colors`);
        }
    }
    if (colors !== undefined) {
        if (kinds === 0) problems.push("colors: there is no palette to take the colors from");
        if (!Array.isArray(colors) || colors.length !== heights.length) {
            problems.push(`colors: must have as many rows as heights (${heights.length})`);
        } else {
            for (let j = 0; j < colors.length; j++) {
                const row: unknown = colors[j];
                if (!Array.isArray(row) || row.length !== length) {
                    problems.push(`colors: row ${j + 1} must have as many numbers as a row of heights (${length})`);
                    break;
                }
                if (kinds > 0 && row.some((n) => !Number.isInteger(n) || n < 0 || n >= kinds)) {
                    problems.push(`colors: row ${j + 1}: every number must be a place in the palette, 0 to ${kinds - 1}`);
                    break;
                }
            }
        }
    }
    return problems;
}

// The data of a terrain file; throws if it is not one
export function parseTerrain(json: unknown): TerrainData {
    const problems = validateTerrain(json);
    if (problems.length > 0) throw new Error(problems[0]);
    const { cell, heights, palette, colors, generator, scatter, biomes, biomeMap } = json as TerrainData;
    return {
        cell,
        heights,
        ...(palette ? { palette } : {}),
        ...(colors ? { colors } : {}),
        ...(generator ? { generator } : {}),
        ...(scatter ? { scatter } : {}),
        ...(biomes && biomeMap ? { biomes, biomeMap } : {}),
    };
}

// A part of the grid of a ground: the heights from column `fromI` to `toI` and from row `fromJ` to `toJ`
export interface TerrainRegion {
    fromI: number;
    toI: number;
    fromJ: number;
    toJ: number;
}

// The heights a brush of this radius reaches from a point (x and z from the middle of the terrain); null if
// it reaches none
export function brushRegion(data: TerrainData, x: number, z: number, radius: number): TerrainRegion | null {
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    const u = x / data.cell + (columns - 1) / 2;
    const v = z / data.cell + (rows - 1) / 2;
    const span = radius / data.cell;
    const region = {
        fromI: Math.max(0, Math.ceil(u - span)),
        toI: Math.min(columns - 1, Math.floor(u + span)),
        fromJ: Math.max(0, Math.ceil(v - span)),
        toJ: Math.min(rows - 1, Math.floor(v + span)),
    };
    return region.fromI <= region.toI && region.fromJ <= region.toJ ? region : null;
}

// Writes the heights, the colors and the normals of the ground into its geometry (made by terrainGeometry()
// for a ground of the same number of heights). With `region`, only that part of the ground and what is next
// to it is written and sent to the video card: what a brush calls at every touch, so that a big ground is
// as quick to work as a small one.
export function fillTerrainGeometry(geometry: THREE.BufferGeometry, data: TerrainData, flat: boolean, region?: TerrainRegion) {
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    const { cell, heights } = data;
    const [width, depth] = terrainSize(data);
    const attributes = ["position", "color", "normal"].map((name) => geometry.getAttribute(name) as THREE.BufferAttribute);
    const [positions, colors, normals] = attributes.map((attribute) => attribute.array as Float32Array);
    // The colors of the palette as three.js keeps them; unpainted ground is white: the material shows as it is
    const painted = isPainted(data);
    const palette = painted ? data.palette!.map((color) => new THREE.Color(color)) : [];
    const white = new THREE.Color(1, 1, 1);
    const colorAt = (i: number, j: number) => (painted ? palette[data.colors![j][i]] ?? white : white);
    // A height that moved turns the normals of its neighbors too
    const fromI = region ? Math.max(0, region.fromI - 1) : 0;
    const toI = region ? Math.min(columns - 1, region.toI + 1) : columns - 1;
    const fromJ = region ? Math.max(0, region.fromJ - 1) : 0;
    const toJ = region ? Math.min(rows - 1, region.toJ + 1) : rows - 1;

    // Which way the two triangles of a cell face, added to (nx, ny, nz); each is as long as twice its area.
    // The first has the corners (i, j), (i + 1, j + 1), (i + 1, j), the second (i, j), (i, j + 1), (i + 1, j + 1):
    // the cut of terrainHeight().
    let nx = 0;
    let ny = 0;
    let nz = 0;
    const first = (i: number, j: number) => {
        if (i < 0 || j < 0 || i >= columns - 1 || j >= rows - 1) return;
        const a = heights[j][i];
        nx -= cell * (heights[j][i + 1] - a);
        ny += cell * cell;
        nz += cell * (heights[j][i + 1] - heights[j + 1][i + 1]);
    };
    const second = (i: number, j: number) => {
        if (i < 0 || j < 0 || i >= columns - 1 || j >= rows - 1) return;
        const a = heights[j][i];
        nx += cell * (heights[j + 1][i] - heights[j + 1][i + 1]);
        ny += cell * cell;
        nz -= cell * (heights[j + 1][i] - a);
    };
    const put = (n: number, i: number, j: number, color: THREE.Color) => {
        const length = Math.hypot(nx, ny, nz) || 1;
        positions[n] = i * cell - width / 2;
        positions[n + 1] = heights[j][i];
        positions[n + 2] = j * cell - depth / 2;
        colors[n] = color.r;
        colors[n + 1] = color.g;
        colors[n + 2] = color.b;
        normals[n] = nx / length;
        normals[n + 1] = ny / length;
        normals[n + 2] = nz / length;
    };

    // What was written, in numbers of the arrays: only that goes to the video card
    let start = 0;
    let count = positions.length;
    if (!flat) {
        // A vertex at every height: it faces the way the six triangles around it do, taken together
        for (let j = fromJ; j <= toJ; j++) {
            for (let i = fromI; i <= toI; i++) {
                nx = ny = nz = 0;
                first(i, j);
                second(i, j);
                first(i - 1, j - 1);
                second(i - 1, j - 1);
                first(i - 1, j);
                second(i, j - 1);
                put((j * columns + i) * 3, i, j, colorAt(i, j));
            }
        }
        start = fromJ * columns * 3;
        count = (toJ - fromJ + 1) * columns * 3;
    } else {
        // Every triangle has vertices of its own, one normal and one color: what its three corners are
        // painted with, mixed. The cells that have a corner in the part being written.
        const mixed = new THREE.Color();
        const cellsFromI = Math.max(0, fromI - 1);
        const cellsToI = Math.min(columns - 2, toI);
        const cellsFromJ = Math.max(0, fromJ - 1);
        const cellsToJ = Math.min(rows - 2, toJ);
        for (let j = cellsFromJ; j <= cellsToJ; j++) {
            for (let i = cellsFromI; i <= cellsToI; i++) {
                let n = (j * (columns - 1) + i) * 18;
                for (const [face, corners] of [[first, [[i, j], [i + 1, j + 1], [i + 1, j]]], [second, [[i, j], [i, j + 1], [i + 1, j + 1]]]] as const) {
                    nx = ny = nz = 0;
                    face(i, j);
                    mixed.setRGB(0, 0, 0);
                    for (const [ci, cj] of corners) mixed.add(colorAt(ci, cj));
                    mixed.multiplyScalar(1 / 3);
                    for (const [ci, cj] of corners) {
                        put(n, ci, cj, mixed);
                        n += 3;
                    }
                }
            }
        }
        start = cellsFromJ * (columns - 1) * 18;
        count = Math.max(0, cellsToJ - cellsFromJ + 1) * (columns - 1) * 18;
    }
    for (const attribute of attributes) {
        attribute.clearUpdateRanges();
        if (region) attribute.addUpdateRange(start, count);
        attribute.needsUpdate = true;
    }

    if (region && geometry.boundingBox && geometry.boundingSphere) {
        // The box only grows here: it is counted exactly when the whole ground is written again
        for (let j = fromJ; j <= toJ; j++) {
            for (let i = fromI; i <= toI; i++) {
                if (heights[j][i] < geometry.boundingBox.min.y) geometry.boundingBox.min.y = heights[j][i];
                if (heights[j][i] > geometry.boundingBox.max.y) geometry.boundingBox.max.y = heights[j][i];
            }
        }
        geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
    } else {
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
    }
}

// The mesh of a terrain: a vertex at every height, two triangles in every cell
export function terrainGeometry(data: TerrainData, flat: boolean, textureSize: number): THREE.BufferGeometry {
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    const [width, depth] = terrainSize(data);
    // The image of the material lies on the ground, `textureSize` meters to one repeat
    const uvOf = (i: number, j: number) => [(i * data.cell - width / 2) / textureSize, -(j * data.cell - depth / 2) / textureSize];
    const geometry = new THREE.BufferGeometry();
    let count = rows * columns;
    let uvs: number[] = [];
    if (flat) {
        count = (rows - 1) * (columns - 1) * 6;
        for (let j = 0; j < rows - 1; j++) {
            for (let i = 0; i < columns - 1; i++) {
                for (const [ci, cj] of [[i, j], [i + 1, j + 1], [i + 1, j], [i, j], [i, j + 1], [i + 1, j + 1]]) uvs.push(...uvOf(ci, cj));
            }
        }
    } else {
        const index: number[] = [];
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < columns; i++) uvs.push(...uvOf(i, j));
        }
        for (let j = 0; j < rows - 1; j++) {
            for (let i = 0; i < columns - 1; i++) {
                const a = j * columns + i;
                index.push(a, a + columns + 1, a + 1, a, a + columns, a + columns + 1);
            }
        }
        geometry.setIndex(index);
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    uvs = [];
    fillTerrainGeometry(geometry, data, flat);
    return geometry;
}

// `material` has to take the colors of the vertices (registry.getMaterial(name, true))
export function createTerrain(f: TerrainFields, data: TerrainData, material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(terrainGeometry(data, f.flat, f.textureSize), material);
    mesh.castShadow = f.castShadow;
    mesh.receiveShadow = f.receiveShadow;
    const marker: TerrainMarker = { data, layer: f.layer, flat: f.flat };
    mesh.userData.terrain = marker;
    // The asset it shows ("" for none), for the editor
    mesh.userData.terrainName = f.terrain;
    return mesh;
}

// What a brush does to the ground it touches
export type TerrainTool = "raise" | "lower" | "smooth" | "flatten" | "paint";

// One touch of a brush: changes `data` in place within `radius` meters of a point (x and z from the middle
// of the terrain), strongest in the middle and fading to nothing at the edge. `amount` is how much: meters
// for "raise" and "lower", the part of the way (0 to 1) for "smooth" (towards the neighbors) and "flatten"
// (towards the height `level`). "paint" puts the color of the palette with the number `color` everywhere
// within the radius. Returns true if anything changed.
export function brushTerrain(data: TerrainData, tool: TerrainTool, x: number, z: number, radius: number, amount: number, options: { level?: number; color?: number } = {}) {
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    const u = x / data.cell + (columns - 1) / 2;
    const v = z / data.cell + (rows - 1) / 2;
    const span = radius / data.cell;
    const fromI = Math.max(0, Math.ceil(u - span));
    const toI = Math.min(columns - 1, Math.floor(u + span));
    const fromJ = Math.max(0, Math.ceil(v - span));
    const toJ = Math.min(rows - 1, Math.floor(v + span));
    // The heights as they were: smoothing a height must not see neighbors this same touch has moved already
    const first = Math.max(0, fromJ - 1);
    const was = tool === "smooth" ? data.heights.slice(first, toJ + 2).map((row) => [...row]) : [];
    const before = (i: number, j: number) => was[Math.min(rows - 1, Math.max(0, j)) - first][Math.min(columns - 1, Math.max(0, i))];
    let changed = false;
    if (tool !== "paint") forgetTerrainRange(data);
    for (let j = fromJ; j <= toJ; j++) {
        for (let i = fromI; i <= toI; i++) {
            const distance = Math.hypot(i - u, j - v) / span;
            if (distance > 1) continue;
            if (tool === "paint") {
                const color = options.color ?? 0;
                if (!data.colors || data.colors[j][i] === color) continue;
                data.colors[j][i] = color;
                changed = true;
                continue;
            }
            const fade = (1 - distance * distance) ** 2;
            const height = data.heights[j][i];
            let next = height;
            if (tool === "raise") next += amount * fade;
            else if (tool === "lower") next -= amount * fade;
            else if (tool === "flatten") next += ((options.level ?? 0) - height) * Math.min(1, amount * fade);
            else next += ((before(i - 1, j) + before(i + 1, j) + before(i, j - 1) + before(i, j + 1)) / 4 - height) * Math.min(1, amount * fade);
            if (next !== height) changed = true;
            data.heights[j][i] = next;
        }
    }
    return changed;
}

// The props of a ground of another size: those that still stand on it
export function fitScatter(scatter: ScatterLayer[] | undefined, data: TerrainData): ScatterLayer[] | undefined {
    if (!scatter) return undefined;
    const [width, depth] = terrainSize(data);
    return scatter
        .map((layer) => ({ prefab: layer.prefab, items: layer.items.filter((item) => Math.abs(item[0]) <= width / 2 && Math.abs(item[1]) <= depth / 2) }))
        .filter((layer) => layer.items.length > 0);
}

// Problems of the `scatter` of a terrain file; `prefabs` are the names it may use, if they are known
export function validateScatter(scatter: unknown, prefabs?: string[]): string[] {
    if (!Array.isArray(scatter)) return ['scatter: must be a list: [{ "prefab": "Pine", "items": [[x, z, turn, size], ...] }]'];
    const problems: string[] = [];
    const seen = new Set<unknown>();
    scatter.forEach((layer: Partial<ScatterLayer> | null, n) => {
        const at = `scatter[${n}]`;
        if (typeof layer !== "object" || layer === null || typeof layer.prefab !== "string" || !layer.prefab) {
            problems.push(`${at}: must be { "prefab": "<name>", "items": [...] }`);
            return;
        }
        if (seen.has(layer.prefab)) problems.push(`${at}: prefab "${layer.prefab}" is listed more than once`);
        seen.add(layer.prefab);
        if (prefabs && !prefabs.includes(layer.prefab)) problems.push(`${at}: prefab "${layer.prefab}" does not exist (known: ${prefabs.join(", ") || "none"})`);
        const bad = Array.isArray(layer.items) ? layer.items.findIndex((item) => !Array.isArray(item) || item.length !== 4 || item.some((value) => typeof value !== "number" || !Number.isFinite(value))) : 0;
        if (!Array.isArray(layer.items)) problems.push(`${at}.items: must be a list of [x, z, turn, size]`);
        else if (bad >= 0) problems.push(`${at}.items[${bad}]: must be four numbers: [x, z, turn, size]`);
    });
    return problems;
}
