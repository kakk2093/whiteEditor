import * as THREE from "three";
import type { ParamDef, Registry } from "./Registry";
import { cullScatter } from "./scatter";
import { terrainSize } from "./terrain";
import type { TerrainData, TerrainFields } from "./terrain";

// A world: ground of any size, made of pieces no bigger than 500 x 500 m. A piece is an ordinary file of
// terrains/, named by its place in the grid of the world: "World_0_0", "World_1_0", "World_-1_2" (the world,
// the column along X, the row along Z). All the pieces of a world are squares of one size; the piece i, j
// has its middle i * size meters along X and j * size meters along Z from the entity. Neighbors share the
// heights of their common edge, so there is no seam.
//
// One entity with a World component shows them, and only those near the camera: a piece is made when the
// camera comes within `distance` meters of it and is taken away again when it is further than that (and a
// quarter of a piece more, so that it does not come and go at the border). The rest of the engine sees a piece as the
// ground of a Terrain component: the mesh of a piece carries userData.terrain like that one, with its
// props, its rivers and the air of its biomes.

// The longest side a piece may have, meters
export const MAX_PIECE = 500;

export const worldFields = {
    // The name of the world: its pieces are the terrains <world>_<i>_<j>
    world: { type: "string", default: "" },
    // Meters from the camera within which the pieces are shown: past the fog is enough
    distance: { type: "number", default: 400, min: 1, step: 50 },
    // Meters within which a piece is drawn whole, with its props; further away it is a coarse grid (a height
    // every few meters) without them. 0: always whole
    detail: { type: "number", default: 150, min: 0, step: 25 },
    // As those of the Terrain component, for every piece
    material: { type: "asset", kind: "material", default: "" },
    flat: { type: "boolean", default: false },
    textureSize: { type: "number", default: 4, min: 0.01, step: 0.5 },
    castShadow: { type: "boolean", default: false },
    receiveShadow: { type: "boolean", default: true },
    layer: { type: "asset", kind: "layer", default: "" },
} satisfies Record<string, ParamDef>;

export interface WorldFields {
    world: string;
    distance: number;
    detail: number;
    material: string;
    flat: boolean;
    textureSize: number;
    castShadow: boolean;
    receiveShadow: boolean;
    layer: string;
}

// A piece of a world: its place in the grid and the name of its terrain
export interface WorldPiece {
    i: number;
    j: number;
    name: string;
}

const PIECE = /^(.+)_(-?\d+)_(-?\d+)$/;

export function pieceName(world: string, i: number, j: number) {
    return `${world}_${i}_${j}`;
}

// The place of a terrain in the grid of its world, if its name is one of a piece
export function parsePiece(name: string): (WorldPiece & { world: string }) | null {
    const match = PIECE.exec(name);
    return match ? { world: match[1], i: Number(match[2]), j: Number(match[3]), name } : null;
}

// The pieces of a world, as the terrains of the project are named
export function worldPieces(names: string[], world: string): WorldPiece[] {
    if (!world) return [];
    return names.map(parsePiece).filter((piece): piece is WorldPiece & { world: string } => piece?.world === world).map(({ i, j, name }) => ({ i, j, name }));
}

// The worlds of a project: every name that has a piece
export function worldNames(names: string[]) {
    return [...new Set(names.map(parsePiece).filter((piece) => piece).map((piece) => piece!.world))].sort();
}

// The size of the pieces of a world: of the first of them that there is (loaded or not); 0 without pieces
export function pieceSize(registry: Registry, pieces: WorldPiece[]) {
    for (const piece of pieces) {
        const side = registry.terrainSide(piece.name);
        if (side > 0) return side;
    }
    return 0;
}

// Where the middle of a piece is, from the entity of its world
export function pieceOffset(i: number, j: number, size: number, target = new THREE.Vector3()) {
    return target.set(i * size, 0, j * size);
}

// What the group of a World component carries in userData.world
export interface WorldMarker {
    fields: WorldFields;
    registry: Registry;
    // The meshes of the pieces that are shown now, by the name of their terrain
    shown: Map<string, THREE.Object3D>;
    // Makes the object of a piece (as the Terrain component makes it; with `step` above 1, the coarse one) and
    // takes one away
    make: (fields: TerrainFields, step: number) => THREE.Object3D;
    dispose: (object: THREE.Object3D) => void;
    // Every piece is shown, wherever the camera is (the editor shows a world whole while it is asked to)
    all: boolean;
}

export function createWorld(fields: WorldFields, registry: Registry, make: WorldMarker["make"], dispose: WorldMarker["dispose"]): THREE.Group {
    const group = new THREE.Group();
    const marker: WorldMarker = { fields, registry, shown: new Map(), make, dispose, all: false };
    group.userData.world = marker;
    return group;
}

const middle = new THREE.Vector3();
const offset = new THREE.Vector3();

// How far a point is from a square piece along the ground (0 inside it)
function distanceTo(point: THREE.Vector3, x: number, z: number, half: number) {
    return Math.hypot(Math.max(0, Math.abs(point.x - x) - half), Math.max(0, Math.abs(point.z - z) - half));
}

// How coarse a far piece is: a height every so many heights, the most of these that divides its grid
const COARSE = [8, 4, 2];

// The step of the coarse grid of a ground; 1 if none fits
export function coarseStep(data: TerrainData) {
    const cells = data.heights.length - 1;
    return COARSE.find((step) => cells % step === 0 && (data.heights[0].length - 1) % step === 0 && cells / step >= 2) ?? 1;
}

// The props of a whole piece are drawn only within `detail` meters of the camera, square by square
function cullProps(mesh: THREE.Object3D, point: THREE.Vector3 | null, middle: THREE.Vector3, offset: THREE.Vector3, detail: number) {
    if (mesh.userData.coarse) return;
    cullScatter(mesh, point ? { x: point.x - middle.x - offset.x, z: point.z - middle.z - offset.z } : { x: 0, z: 0 }, point && detail > 0 ? detail : Infinity);
}

// Meters from the camera within which a piece that is still being loaded holds the game up (see Game)
const NEEDED = 1;

// What updateWorlds() has done: whether a piece came or went, and whether a piece the camera is on (or next
// to) is still being loaded
export interface WorldUpdate {
    changed: boolean;
    waiting: boolean;
}

// Shows the pieces of one world near `point` (in the world) and takes away those that are far. A piece whose
// data is not loaded yet is asked for, and comes when it is there.
function updateWorld(group: THREE.Object3D, point: THREE.Vector3 | null, result: WorldUpdate) {
    let changed = false;
    const marker = group.userData.world as WorldMarker;
    const { registry, fields } = marker;
    const pieces = worldPieces(registry.terrainNames(), fields.world);
    const size = pieceSize(registry, pieces);
    group.getWorldPosition(middle);
    const wanted = new Set<string>();
    for (const piece of pieces) {
        const shown = marker.shown.get(piece.name);
        pieceOffset(piece.i, piece.j, size, offset);
        const away = point && !marker.all ? distanceTo(point, middle.x + offset.x, middle.z + offset.z, size / 2) : 0;
        // A piece that is shown goes only a quarter of a piece further away: it does not come and go at the border
        if (away > fields.distance + (shown ? size / 4 : 0)) continue;
        wanted.add(piece.name);
        const data = registry.loadTerrain(piece.name);
        if (!data || data instanceof Promise) {
            // Shown as it was while new data is on its way; the game waits for one the camera is on
            if (away <= NEEDED && !shown) result.waiting = true;
            continue;
        }
        // Whole near the camera, coarse further away (a quarter of a piece of leeway, as above)
        const wasCoarse = (shown?.userData.coarse as number | undefined) ?? 1;
        const whole = !fields.detail || away <= fields.detail + (shown && wasCoarse === 1 ? size / 4 : 0);
        const step = whole ? 1 : coarseStep(data);
        // Shown already, from this very data. A brush changes the meshes in place: they show its copy of the
        // ground while it works and the copy becomes the data of the terrain when it is done.
        if (shown && wasCoarse === step && (shown.userData.made === data || (shown.userData.terrain as { data: TerrainData }).data === data)) {
            shown.userData.made = data;
            cullProps(shown, point, middle, offset, fields.detail);
            continue;
        }
        if (shown) {
            group.remove(shown);
            marker.dispose(shown);
        }
        const made = marker.make({ ...fields, terrain: piece.name } as unknown as TerrainFields, step);
        made.position.copy(offset);
        made.userData.piece = piece;
        made.userData.made = data;
        group.add(made);
        cullProps(made, point, middle, offset, fields.detail);
        marker.shown.set(piece.name, made);
        changed = true;
    }
    for (const [name, shown] of marker.shown) {
        if (wanted.has(name)) continue;
        group.remove(shown);
        marker.dispose(shown);
        marker.shown.delete(name);
        // A piece that can be loaded again lets its data go too (in a built game)
        registry.unloadTerrain(name);
        changed = true;
    }
    if (changed) result.changed = true;
}

// The entity whose ground a terrain mesh is: of its Terrain component, or of the World it is a piece of
export function groundEntity(mesh: THREE.Object3D): THREE.Object3D {
    return mesh.userData.piece ? mesh.parent?.parent ?? mesh.parent! : mesh.parent!;
}

// Shows the pieces of every world under `root` that are near `point` (the camera), takes away the far ones.
// Call it every frame before the scene is used; without a point every piece is shown.
export function updateWorlds(root: THREE.Object3D, point: THREE.Vector3 | null): WorldUpdate {
    const worlds: THREE.Object3D[] = [];
    root.traverse((object) => {
        if (object.userData.world) worlds.push(object);
    });
    const result: WorldUpdate = { changed: false, waiting: false };
    if (worlds.length === 0) return result;
    root.updateMatrixWorld();
    for (const group of worlds) updateWorld(group, point, result);
    return result;
}

// The four sides of a piece: which way its neighbor is, along the grid
export const PIECE_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

// Makes the common edge of a piece and of its neighbor (di, dj away: one of PIECE_SIDES) meet: where their heights
// differ, both get the middle. `own(data, j)` gives the row j of the heights of a ground as one that may be
// written (the caller copies it the first time). Returns true if anything changed. Grounds of different
// grids are left alone.
export function meetEdges(a: TerrainData, b: TerrainData, di: number, dj: number, own: (data: TerrainData, j: number) => number[]): boolean {
    const rows = a.heights.length;
    const columns = a.heights[0].length;
    if (b.heights.length !== rows || b.heights[0].length !== columns) return false;
    let changed = false;
    // The places of the edge in both: [row, column] in a and in b
    const along = di !== 0 ? rows : columns;
    for (let k = 0; k < along; k++) {
        const [ja, ia, jb, ib] = di === 1 ? [k, columns - 1, k, 0] : di === -1 ? [k, 0, k, columns - 1] : dj === 1 ? [rows - 1, k, 0, k] : [0, k, rows - 1, k];
        const here = a.heights[ja][ia];
        const there = b.heights[jb][ib];
        if (here === there) continue;
        const middle = Math.round(((here + there) / 2) * 100) / 100;
        own(a, ja)[ia] = middle;
        own(b, jb)[ib] = middle;
        changed = true;
    }
    return changed;
}

// A new piece beside those that are there: a ground of the same size and cell as `like` whose heights go on from
// the edges of its neighbors (`neighbors`: their grounds by side, as in PIECE_SIDES) — each height is the one of
// the nearest edge, so it meets them all without a seam. It takes the palette, the generator settings and the
// biome of `like` (paint and props it has none: press Generate for those).
export function continuedPiece(like: TerrainData, neighbors: Map<string, TerrainData>): TerrainData {
    const rows = like.heights.length;
    const columns = like.heights[0].length;
    const east = neighbors.get("1,0");
    const west = neighbors.get("-1,0");
    const south = neighbors.get("0,1");
    const north = neighbors.get("0,-1");
    const heights: number[][] = [];
    for (let j = 0; j < rows; j++) {
        const row: number[] = [];
        for (let i = 0; i < columns; i++) {
            // The edges it touches, each with how far it is: the nearest ones count the most
            let sum = 0;
            let weight = 0;
            const add = (height: number | undefined, far: number) => {
                if (height === undefined) return;
                const w = 1 / (far + 0.5) ** 2;
                sum += height * w;
                weight += w;
            };
            add(west?.heights[j][columns - 1], i);
            add(east?.heights[j][0], columns - 1 - i);
            add(north?.heights[rows - 1][i], j);
            add(south?.heights[0][i], rows - 1 - j);
            row.push(weight > 0 ? Math.round((sum / weight) * 100) / 100 : 0);
        }
        heights.push(row);
    }
    // On an edge the neighbor is exact
    if (west) for (let j = 0; j < rows; j++) heights[j][0] = west.heights[j][columns - 1];
    if (east) for (let j = 0; j < rows; j++) heights[j][columns - 1] = east.heights[j][0];
    if (north) heights[0] = [...north.heights[rows - 1]];
    if (south) heights[rows - 1] = [...south.heights[0]];
    return {
        cell: like.cell,
        heights,
        ...(like.palette ? { palette: [...like.palette], colors: heights.map((row) => row.map(() => 0)) } : {}),
        ...(like.generator ? { generator: { ...like.generator } } : {}),
    };
}

// Problems of the pieces of the worlds the scenes name: pieces of different sizes, too big or not square,
// and edges that do not meet their neighbor's
export function validateWorld(registry: Registry, world: string): string[] {
    const pieces = worldPieces(registry.terrainNames(), world);
    if (pieces.length === 0) return [`there is no piece of the world "${world}" in terrains/: a piece is named ${pieceName(world || "World", 0, 0)}`];
    const problems: string[] = [];
    const size = pieceSize(registry, pieces);
    const byPlace = new Map(pieces.map((piece) => [`${piece.i},${piece.j}`, piece]));
    for (const piece of pieces) {
        // Not loaded: a built game checks nothing
        const data = registry.getTerrain(piece.name);
        if (!data) continue;
        const [width, depth] = terrainSize(data);
        if (width !== depth) problems.push(`terrains/${piece.name}.json: a piece of a world must be a square (it is ${width} x ${depth} m)`);
        if (width > MAX_PIECE || depth > MAX_PIECE) problems.push(`terrains/${piece.name}.json: a piece of a world is at most ${MAX_PIECE} x ${MAX_PIECE} m (it is ${width} x ${depth} m)`);
        if (Math.abs(width - size) > 1e-6) problems.push(`terrains/${piece.name}.json: all the pieces of "${world}" must be of one size: ${size} m like the others (it is ${width} m)`);
        // The edges it shares with the neighbors to the east and to the south
        for (const [di, dj] of [[1, 0], [0, 1]]) {
            const next = byPlace.get(`${piece.i + di},${piece.j + dj}`);
            const other = next && registry.getTerrain(next.name);
            if (!other || other.heights.length !== data.heights.length || other.heights[0].length !== data.heights[0].length) continue;
            const rows = data.heights.length;
            const columns = data.heights[0].length;
            let worst = 0;
            if (di === 1) for (let j = 0; j < rows; j++) worst = Math.max(worst, Math.abs(data.heights[j][columns - 1] - other.heights[j][0]));
            else for (let i = 0; i < columns; i++) worst = Math.max(worst, Math.abs(data.heights[rows - 1][i] - other.heights[0][i]));
            if (worst > 0.011) problems.push(`terrains/${piece.name}.json and ${next.name}.json: their common edge does not meet (up to ${worst.toFixed(2)} m apart): a seam in the ground`);
        }
    }
    return problems;
}
