import * as THREE from "three";
import type { ZoneFields } from "./environment";
import type { ParamDef } from "./Registry";
import { forgetTerrainRange, isPainted, terrainColor, terrainHeight, terrainSize } from "./terrain";
import type { TerrainData, TerrainRegion } from "./terrain";

// The rivers of a terrain: water that runs down a bed cut into the ground. A terrain file lists them
// (`rivers`); a river is a line of points from its spring to its mouth, each `[x, z, y]`: meters from the
// middle of the terrain, and how high the surface of the water is there. Between the points the river
// bends smoothly and its water goes evenly from one height to the next; water does not run uphill, so a
// point that is higher than the one before it counts as level with it.
//
// The bed is a part of the ground: applyRivers() cuts it into the heights (and paints it, and takes the
// props out of the water). Doing it twice changes nothing, so the generator calls it after everything it
// makes: a ground that is generated again keeps its rivers. The bed is painted only on a ground that is
// painted already. The water is drawn by the Terrain component.
// Like all water here it stops nothing: what walks goes along the bed.
//
// The water runs: its `flow` is how fast, meters per second. That shows (streaks that go down the river) and
// carries what floats: a behavior that swims, a body with buoyancy (see water.ts, flowAt).

// The fields of a river, but for its points; the Inspector and the checks are made from them
export const riverFields = {
    // Meters from bank to bank
    width: { type: "number", default: 6, min: 0.5, step: 0.5 },
    // Meters of water in the middle of the bed
    depth: { type: "number", default: 1.2, min: 0.1, step: 0.1 },
    // What the bed is painted with
    bed: { type: "color", default: "#8a7a5c" },
    color: { type: "color", default: "#2a6f8a" },
    // 1 hides what is in the water
    opacity: { type: "number", default: 0.75, min: 0, max: 1, step: 0.05 },
    // Meters per second the water runs with, from the spring to the mouth; 0 is still water
    flow: { type: "number", default: 1, min: 0, step: 0.25 },
} satisfies Record<string, ParamDef>;

export type RiverPoint = [x: number, z: number, y: number];

// A river as it is in a terrain file: any field but the points may be missing
export interface RiverData {
    points: RiverPoint[];
    width?: number;
    depth?: number;
    bed?: string;
    color?: string;
    opacity?: number;
    flow?: number;
}

export const defaultRiver = Object.fromEntries(Object.entries(riverFields).map(([key, def]) => [key, def.default])) as unknown as Required<Omit<RiverData, "points">>;

// Meters the top of a bank is above the water
const BANK_RISE = 0.3;

// How steep the ground may be beyond the banks: above the river (a gorge cut through a hill) and below it
// (a dike across a hollow), meters up or down for every meter across
const GORGE = 1;
const DIKE = 0.6;

// Meters beyond the banks within which the ground is brought down (or up) to the river
const REACH = 48;

// Seen from under the surface: what the Water component has as its usual values
const UNDER_COLOR = "#0b4a5c";
const VISIBILITY = 14;
const UNDER_LIGHT = 0.7;

// A place of the middle line of a river, and how high its water is there
export interface RiverSample {
    x: number;
    z: number;
    y: number;
    // The number of the point of the river the place comes after (or is at)
    after: number;
}

// How high the water is at every point of a river: water does not run uphill
export function riverLevels(river: RiverData): number[] {
    const levels: number[] = [];
    for (const point of river.points) levels.push(Math.min(levels[levels.length - 1] ?? Infinity, point[2]));
    return levels;
}

// The middle line of a river as a row of places about `step` meters apart: a smooth curve through its points
export function riverPath(river: RiverData, step = 1): RiverSample[] {
    const points = river.points;
    if (points.length < 2) return [];
    const samples: RiverSample[] = [];
    const levels = riverLevels(river);
    for (let n = 0; n < points.length - 1; n++) {
        const before = points[Math.max(0, n - 1)];
        const from = points[n];
        const to = points[n + 1];
        const after = points[Math.min(points.length - 1, n + 2)];
        const parts = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / step));
        for (let k = 0; k < parts + (n === points.length - 2 ? 1 : 0); k++) {
            const t = k / parts;
            // A Catmull-Rom curve: it goes through the points
            const along = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
            samples.push({ x: along(before[0], from[0], to[0], after[0]), z: along(before[1], from[1], to[1], after[1]), y: levels[n] === levels[n + 1] ? levels[n] : levels[n] * (1 - t) + levels[n + 1] * t, after: k === parts ? n + 1 : n });
        }
    }
    return samples;
}

// How far a place is from the middle line of a river, how high the water is at the nearest place of it, and
// which way the river runs there (a vector of length 1)
function nearest(path: RiverSample[], x: number, z: number) {
    let distance = Infinity;
    let level = 0;
    let along = [0, 0];
    for (let n = 0; n < path.length - 1; n++) {
        const a = path[n];
        const b = path[n + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = dx * dx + dz * dz;
        const t = length > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / length)) : 0;
        const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
        if (d < distance) {
            distance = d;
            level = a.y + (b.y - a.y) * t;
            along = length > 0 ? [dx / Math.sqrt(length), dz / Math.sqrt(length)] : along;
        }
    }
    return { distance, level, along };
}

// How wide the bank of a river is: the strip beside the water that rises to the top of the bank
function bankOf(width: number, cell: number) {
    return Math.max(2 * cell, width * 0.4);
}

// The part of the grid the rivers of a ground reach: what applyRivers() may change; null without rivers
export function riverRegion(data: TerrainData): TerrainRegion | null {
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    let region: TerrainRegion | null = null;
    for (const given of data.rivers ?? []) {
        const river = { ...defaultRiver, ...given };
        const reach = river.width / 2 + bankOf(river.width, data.cell) + REACH;
        for (const sample of riverPath(given, Math.max(data.cell, 0.5))) {
            const u = sample.x / data.cell + (columns - 1) / 2;
            const v = sample.z / data.cell + (rows - 1) / 2;
            const span = reach / data.cell;
            const fromI: number = Math.max(0, Math.ceil(u - span));
            const toI: number = Math.min(columns - 1, Math.floor(u + span));
            const fromJ: number = Math.max(0, Math.ceil(v - span));
            const toJ: number = Math.min(rows - 1, Math.floor(v + span));
            if (fromI > toI || fromJ > toJ) continue;
            region = region
                ? { fromI: Math.min(region.fromI, fromI), toI: Math.max(region.toI, toI), fromJ: Math.min(region.fromJ, fromJ), toJ: Math.max(region.toJ, toJ) }
                : { fromI, toI, fromJ, toJ };
        }
    }
    return region;
}

// Cuts the beds of the rivers of `data` into its ground, in place: the heights (to centimeters), the paint
// of the beds, and the props that would stand in the water are taken away. With `within`, only that part of
// the grid is touched. The rows of heights and of colors it writes have to be the caller's own (riverRegion()
// tells which they can be); the lists of the props are made anew.
// Doing it again changes nothing. Returns the part of the grid the rivers reach there, or null.
export function applyRivers(data: TerrainData, within?: TerrainRegion): TerrainRegion | null {
    const rivers = data.rivers ?? [];
    if (rivers.length === 0) return null;
    const rows = data.heights.length;
    const columns = data.heights[0].length;
    const { cell } = data;
    const area = within ?? { fromI: 0, toI: columns - 1, fromJ: 0, toJ: rows - 1 };
    let touched: TerrainRegion | null = null;
    let wet = false;

    for (const given of rivers) {
        const river = { ...defaultRiver, ...given };
        const path = riverPath(given, Math.max(cell, 0.5));
        if (path.length < 2) continue;
        const half = river.width / 2;
        const bank = bankOf(river.width, cell);
        const reach = half + bank + REACH;
        const span = reach / cell;
        const place = (sample: RiverSample) => [sample.x / cell + (columns - 1) / 2, sample.z / cell + (rows - 1) / 2];

        // The part of the area this river reaches
        let fromI = Infinity;
        let toI = -Infinity;
        let fromJ = Infinity;
        let toJ = -Infinity;
        for (const sample of path) {
            const [u, v] = place(sample);
            fromI = Math.min(fromI, u - span);
            toI = Math.max(toI, u + span);
            fromJ = Math.min(fromJ, v - span);
            toJ = Math.max(toJ, v + span);
        }
        fromI = Math.max(area.fromI, Math.ceil(fromI));
        toI = Math.min(area.toI, Math.floor(toI));
        fromJ = Math.max(area.fromJ, Math.ceil(fromJ));
        toJ = Math.min(area.toJ, Math.floor(toJ));
        if (fromI > toI || fromJ > toJ) continue;
        const wide = toI - fromI + 1;

        // For every height of that part: how far the middle line is, and how high the water is there
        const far = new Float32Array(wide * (toJ - fromJ + 1)).fill(Infinity);
        const level = new Float32Array(far.length);
        for (let n = 0; n < path.length - 1; n++) {
            const [au, av] = place(path[n]);
            const [bu, bv] = place(path[n + 1]);
            const du = bu - au;
            const dv = bv - av;
            const length = du * du + dv * dv;
            const i0 = Math.max(fromI, Math.ceil(Math.min(au, bu) - span));
            const i1 = Math.min(toI, Math.floor(Math.max(au, bu) + span));
            const j0 = Math.max(fromJ, Math.ceil(Math.min(av, bv) - span));
            const j1 = Math.min(toJ, Math.floor(Math.max(av, bv) + span));
            for (let j = j0; j <= j1; j++) {
                for (let i = i0; i <= i1; i++) {
                    const t = length > 0 ? Math.min(1, Math.max(0, ((i - au) * du + (j - av) * dv) / length)) : 0;
                    const d = Math.hypot(i - au - du * t, j - av - dv * t) * cell;
                    const at = (j - fromJ) * wide + (i - fromI);
                    if (d >= far[at]) continue;
                    far[at] = d;
                    level[at] = path[n].y + (path[n + 1].y - path[n].y) * t;
                }
            }
        }

        const painted = isPainted(data);
        const bed = painted ? terrainColor(data, river.bed) : 0;
        for (let j = fromJ; j <= toJ; j++) {
            for (let i = fromI; i <= toI; i++) {
                const at = (j - fromJ) * wide + (i - fromI);
                const d = far[at];
                if (d > reach) continue;
                const y = level[at];
                const was = data.heights[j][i];
                let next = was;
                if (d <= half) {
                    // The bed: deepest in the middle, up to the surface at its edges
                    next = y - river.depth * (1 - (d / half) ** 2);
                    if (painted && data.colors![j][i] !== bed) data.colors![j][i] = bed;
                } else if (d <= half + bank) {
                    next = y + BANK_RISE * ((d - half) / bank);
                } else {
                    // Beyond the banks the ground keeps its shape between a dike and the side of a gorge
                    const beyond = d - half - bank;
                    next = Math.min(y + BANK_RISE + beyond * GORGE, Math.max(y + BANK_RISE - beyond * DIKE, was));
                }
                next = Math.round(next * 100) / 100;
                if (next === was) continue;
                data.heights[j][i] = next;
                touched = touched
                    ? { fromI: Math.min(touched.fromI, i), toI: Math.max(touched.toI, i), fromJ: Math.min(touched.fromJ, j), toJ: Math.max(touched.toJ, j) }
                    : { fromI: i, toI: i, fromJ: j, toJ: j };
            }
        }

        // Nothing grows in the water
        const inWater = (x: number, z: number) => {
            const i = Math.round(x / cell + (columns - 1) / 2);
            const j = Math.round(z / cell + (rows - 1) / 2);
            return i >= fromI && i <= toI && j >= fromJ && j <= toJ && far[(j - fromJ) * wide + (i - fromI)] <= half + 0.5;
        };
        if (data.scatter?.some((layer) => layer.items.some((item) => inWater(item[0], item[1])))) {
            wet = true;
            data.scatter = data.scatter.map((layer) => ({ prefab: layer.prefab, items: layer.items.filter((item) => !inWater(item[0], item[1])) })).filter((layer) => layer.items.length > 0);
            if (data.scatter.length === 0) delete data.scatter;
        }
    }
    if (touched) forgetTerrainRange(data);
    return touched ?? (wet ? area : null);
}

// One more point of a river, where the ground is at (x, z): the water there is a little below the ground,
// and no higher than at the point before. `index` past the last river starts a new one. In place: the list
// of the rivers and the river have to be the caller's own. Returns false off the ground.
export function addRiverPoint(data: TerrainData, index: number, x: number, z: number) {
    const ground = terrainHeight(data, x, z);
    if (ground === null) return false;
    data.rivers ??= [];
    const river = data.rivers[index] ?? { points: [] };
    if (!data.rivers.includes(river)) data.rivers.push(river);
    const last = river.points[river.points.length - 1];
    // A point on the bed of the river itself goes on from its water
    const level = Math.min(ground - BANK_RISE, last ? last[2] : Infinity);
    river.points.push([Math.round(x * 100) / 100, Math.round(z * 100) / 100, Math.round(level * 100) / 100]);
    return true;
}

// One more point of a river between two of its points: where its line runs nearest to (x, z). The point
// is put at (x, z) itself, so the line bends to it; its water is as high as the river has it there. In
// place, like addRiverPoint(). Returns the number of the new point, -1 if the river has no line yet.
export function insertRiverPoint(data: TerrainData, index: number, x: number, z: number) {
    const river = data.rivers?.[index];
    if (!river || river.points.length < 2) return -1;
    let best: RiverSample | null = null;
    let distance = Infinity;
    for (const sample of riverPath(river, 0.5)) {
        const d = Math.hypot(sample.x - x, sample.z - z);
        if (d >= distance) continue;
        distance = d;
        best = sample;
    }
    if (!best) return -1;
    const at = Math.min(best.after, river.points.length - 2) + 1;
    river.points.splice(at, 0, [Math.round(x * 100) / 100, Math.round(z * 100) / 100, Math.round(best.y * 100) / 100]);
    return at;
}

// What the water of a river carries in userData.river: where it runs, from the middle of the terrain
export interface RiverMarker {
    path: RiverSample[];
    half: number;
    depth: number;
    flow: number;
}

// How deep under the surface of a river a place is (x, y, z from the middle of the terrain); 0 if not in it
export function riverDepthAt(marker: RiverMarker, x: number, y: number, z: number) {
    const { distance, level } = nearest(marker.path, x, z);
    if (distance > marker.half || y > level || y < level - marker.depth - 0.5) return 0;
    return level - y;
}

// Where the water of a river carries what is in it at a place (as in riverDepthAt): meters per second along
// x and along z; null out of the water, and in water that stands still
export function riverFlowAt(marker: RiverMarker, x: number, y: number, z: number): [x: number, z: number] | null {
    if (!(marker.flow > 0)) return null;
    const { distance, level, along } = nearest(marker.path, x, z);
    if (distance > marker.half || y > level || y < level - marker.depth - 0.5) return null;
    return [along[0] * marker.flow, along[1] * marker.flow];
}

// The streaks of running water: a picture the color of the water is multiplied by, the same for every river.
// It repeats along the river and is moved down it as time goes (see riverMesh).
const STREAKS_WIDE = 64;
const STREAKS_LONG = 128;

let streaks: THREE.DataTexture | null = null;

function streaksTexture() {
    if (streaks) return streaks;
    const data = new Uint8Array(STREAKS_WIDE * STREAKS_LONG * 4).fill(255);
    const shade = new Float32Array(STREAKS_WIDE * STREAKS_LONG).fill(0.82);
    // Always the same streaks: a picture of a scene is the same every time it is made
    let seed = 12345;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    for (let n = 0; n < 70; n++) {
        const u = Math.floor(random() * STREAKS_WIDE);
        const from = Math.floor(random() * STREAKS_LONG);
        const long = 12 + Math.floor(random() * 44);
        // Some are light (foam), some dark (deep water)
        const tone = random() < 0.6 ? 1 : 0.68;
        for (let k = 0; k < long; k++) {
            // Thin at its ends
            const part = Math.sin((k / long) * Math.PI);
            const at = ((from + k) % STREAKS_LONG) * STREAKS_WIDE + u;
            shade[at] += (tone - shade[at]) * part;
        }
    }
    shade.forEach((value, n) => data.fill(Math.round(value * 255), n * 4, n * 4 + 3));
    streaks = new THREE.DataTexture(data, STREAKS_WIDE, STREAKS_LONG);
    streaks.wrapS = THREE.RepeatWrapping;
    streaks.wrapT = THREE.RepeatWrapping;
    streaks.magFilter = THREE.LinearFilter;
    streaks.minFilter = THREE.LinearFilter;
    streaks.needsUpdate = true;
    return streaks;
}

const local = new THREE.Vector3();
const inverse = new THREE.Matrix4();

// Corners of the round end of a river
const CAP = 8;

function riverMesh(given: RiverData, cell: number): THREE.Mesh | null {
    const river = { ...defaultRiver, ...given };
    const path = riverPath(given, Math.max(cell, 0.5));
    if (path.length < 2) return null;
    // A little under the banks: the edge of the water is where the ground comes out of it
    const half = river.width / 2 + cell;
    const positions: number[] = [];
    const uvs: number[] = [];
    const index: number[] = [];
    // The streaks repeat every so many meters down the river
    const tile = river.width * 3;
    let run = 0;
    const runs: number[] = [];
    const side = (n: number) => {
        const a = path[Math.max(0, n - 1)];
        const b = path[Math.min(path.length - 1, n + 1)];
        const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        return [-(b.z - a.z) / length, (b.x - a.x) / length];
    };
    path.forEach((sample, n) => {
        const [sx, sz] = side(n);
        if (n > 0) run += Math.hypot(sample.x - path[n - 1].x, sample.z - path[n - 1].z);
        runs.push(run);
        uvs.push(0, run / tile, 1, run / tile);
        positions.push(sample.x + sx * half, sample.y, sample.z + sz * half, sample.x - sx * half, sample.y, sample.z - sz * half);
        if (n > 0) index.push(2 * n - 2, 2 * n, 2 * n - 1, 2 * n - 1, 2 * n, 2 * n + 1);
    });
    // The spring and the mouth are round, as their beds are
    for (const [n, turn] of [[0, 1], [path.length - 1, -1]] as const) {
        const sample = path[n];
        const [sx, sz] = side(n);
        const middle = positions.length / 3;
        positions.push(sample.x, sample.y, sample.z);
        uvs.push(0.5, runs[n] / tile);
        for (let k = 0; k <= CAP; k++) {
            const angle = (k / CAP) * Math.PI * turn;
            // From one side of the end round its back to the other
            const cx = sx * Math.cos(angle) + sz * Math.sin(angle);
            const cz = sz * Math.cos(angle) - sx * Math.sin(angle);
            positions.push(sample.x + cx * half, sample.y, sample.z + cz * half);
            // Across the river as on its sides, and on along it: the river runs along (sz, -sx)
            uvs.push(0.5 - 0.5 * (cx * sx + cz * sz), (runs[n] + (cx * sz - cz * sx) * half) / tile);
            if (k > 0) index.push(middle, middle + k + 1, middle + k);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(positions.length).map((_, n) => (n % 3 === 1 ? 1 : 0)), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(index);
    // Running water shows its streaks; each river moves a picture of its own
    let map: THREE.Texture | null = null;
    if (river.flow > 0) {
        map = streaksTexture().clone();
        map.needsUpdate = true;
    }
    // The same water as the Water component has
    const material = new THREE.MeshStandardMaterial({
        color: river.color,
        map,
        opacity: river.opacity,
        transparent: river.opacity < 1,
        roughness: 0.15,
        side: THREE.DoubleSide,
        depthWrite: river.opacity >= 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    if (map) {
        // Nobody ticks the water: the streaks go by the clock, as the waves of a Water do
        const moved = map;
        mesh.onBeforeRender = () => {
            moved.offset.y = -(((performance.now() / 1000) * river.flow) / tile) % 1;
        };
    }
    const marker: RiverMarker = { path, half: river.width / 2, depth: river.depth, flow: river.flow };
    mesh.userData.river = marker;

    // Under the surface the scene is seen as under water: a zone that says itself whether a point is in it
    const under = new THREE.Object3D();
    const zone: ZoneFields = {
        sizeX: 0,
        sizeY: 0,
        sizeZ: 0,
        blend: 0.25,
        sky: false,
        background: UNDER_COLOR,
        ambientColor: "#ffffff",
        ambientIntensity: UNDER_LIGHT,
        fog: true,
        fogColor: UNDER_COLOR,
        fogNear: 0.5,
        fogFar: VISIBILITY,
        look: "",
    };
    under.userData.zoneOf = (point: THREE.Vector3) => {
        local.copy(point).applyMatrix4(inverse.copy(mesh.matrixWorld).invert());
        return riverDepthAt(marker, local.x, local.y, local.z) > 0 ? zone : null;
    };
    mesh.add(under);
    return mesh;
}

function fillRivers(group: THREE.Group, data: TerrainData) {
    for (const child of [...group.children]) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.MeshStandardMaterial).map?.dispose();
        (mesh.material as THREE.Material).dispose();
        group.remove(mesh);
    }
    for (const river of data.rivers ?? []) {
        const mesh = riverMesh(river, data.cell);
        if (mesh) group.add(mesh);
    }
}

// The object that shows the water of the rivers of a terrain; it goes under the mesh of the terrain
export function createRivers(data: TerrainData): THREE.Group {
    const group = new THREE.Group();
    group.userData.rivers = true;
    fillRivers(group, data);
    return group;
}

// Draws the rivers of a terrain mesh again: they have changed in place
export function updateRivers(mesh: THREE.Object3D, data: TerrainData) {
    const group = mesh.children.find((child) => child.userData.rivers) as THREE.Group | undefined;
    if (group) fillRivers(group, data);
    else if (data.rivers?.length) mesh.add(createRivers(data));
}

// Problems of the `rivers` of a terrain file
export function validateRivers(rivers: unknown): string[] {
    if (!Array.isArray(rivers)) return ['rivers: must be a list like [{ "points": [[0, -20, 3], [10, 20, 1]], "width": 6 }]'];
    const problems: string[] = [];
    rivers.forEach((river: unknown, n) => {
        const where = `rivers[${n}]`;
        if (typeof river !== "object" || river === null || Array.isArray(river)) {
            problems.push(`${where}: must be an object with "points"`);
            return;
        }
        const { points, ...fields } = river as Record<string, unknown>;
        if (!Array.isArray(points) || points.length < 1 || !points.every((point) => Array.isArray(point) && point.length === 3 && point.every((value) => typeof value === "number" && Number.isFinite(value)))) {
            problems.push(`${where}.points: must be a list of points from the spring to the mouth, each [x, z, y]: meters from the middle of the terrain and the height of the water there (a river of one point shows nothing yet)`);
        }
        for (const [key, value] of Object.entries(fields)) {
            const def = (riverFields as Record<string, ParamDef>)[key];
            if (!def) problems.push(`${where}: unknown field "${key}" (known: points, ${Object.keys(riverFields).join(", ")})`);
            else if (def.type === "color") {
                if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) problems.push(`${where}.${key}: must be a color like "#aabbcc"`);
            } else if (typeof value !== "number" || Number.isNaN(value)) problems.push(`${where}.${key}: must be a number`);
            else if (def.type === "number" && ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max))) problems.push(`${where}.${key}: must be ${def.min !== undefined ? `>= ${def.min}` : ""}${def.min !== undefined && def.max !== undefined ? " and " : ""}${def.max !== undefined ? `<= ${def.max}` : ""}`);
        }
    });
    return problems;
}

// The rivers that still have a part on the ground, for a ground of another size
export function fitRivers(rivers: RiverData[] | undefined, data: TerrainData): RiverData[] | undefined {
    const [width, depth] = terrainSize(data);
    const kept = (rivers ?? []).filter((river) => river.points.some(([x, z]) => Math.abs(x) <= width / 2 && Math.abs(z) <= depth / 2));
    return kept.length > 0 ? kept.map((river) => ({ ...river, points: river.points.map((point) => [...point] as RiverPoint) })) : undefined;
}
