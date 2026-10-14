import * as THREE from "three";
import { componentDefs } from "./components";
import { createEntityObject, createPrefabInstance } from "./loadScene";
import { paramDefaults } from "./Registry";
import type { Registry } from "./Registry";
import { terrainHeight, terrainSize } from "./terrain";
import type { ScatterItem, TerrainData } from "./terrain";
import type { Params } from "./types";

// The props of a terrain: trees, rocks, grass — thousands of copies of a few prefabs, strewn over the
// ground. They are not objects of the scene: a terrain file lists them (`scatter`: for every prefab, where
// its copies stand, how they are turned and how big they are), and all the copies of one prefab are drawn
// at once. A copy stands on the ground wherever the ground is: its height is not written down.
//
// What a copy has of its prefab is what it looks like (every mesh in it) and, for what moves with
// self.move() and for rays, the solid Collider of the root of the prefab. Behaviors, lights, sounds and
// the rest of the prefab are not there: a prop is scenery.

// One mesh of a prefab: what is drawn for every copy, and where it is inside the copy
interface Part {
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
    matrix: THREE.Matrix4;
    castShadow: boolean;
    receiveShadow: boolean;
}

// What a scatter group keeps for a prefab: its parts, and for every square of the ground that has copies of it the
// instanced meshes that draw them there
interface Drawn {
    parts: Part[];
    cells: Map<string, Cell>;
}

interface Cell {
    meshes: THREE.InstancedMesh[];
    // How many copies the meshes have room for
    capacity: number;
}

// Meters along a side of a square of props: each is drawn by meshes of its own, so that what is out of sight (or
// further than a World shows props, see cullScatter) is not drawn. Counted from the corner of the ground: a ground
// no bigger than this has one square.
export const SCATTER_CELL = 64;

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Where a copy stands, from the middle of the terrain; null if it is off the ground
export function scatterMatrix(data: TerrainData, item: ScatterItem, target = new THREE.Matrix4()): THREE.Matrix4 | null {
    const height = terrainHeight(data, item[0], item[1]);
    if (height === null) return null;
    position.set(item[0], height, item[1]);
    quaternion.setFromAxisAngle(UP, THREE.MathUtils.degToRad(item[2]));
    scale.setScalar(item[3]);
    return target.compose(position, quaternion, scale);
}

// The meshes of a prefab, as one copy of it has them. `late` is called if a model file of the prefab was
// still on its way and has arrived: the parts are to be taken again then.
function partsOf(registry: Registry, prefab: string, late: () => void): Part[] | null {
    if (!registry.getPrefab(prefab)) return null;
    const template = createEntityObject(registry, createPrefabInstance(registry, prefab));
    template.updateMatrixWorld(true);
    const parts: Part[] = [];
    template.traverse((object) => {
        // A model file that is not loaded yet shows nothing so far
        const model = object.userData.gltf as { fields: { file: string } } | undefined;
        if (model && object.children.length === 0) {
            const file = registry.loadModelFile(model.fields.file);
            if (file instanceof Promise) file.then(late, () => {});
        }
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        // Hidden with one of the objects it is in
        for (let up: THREE.Object3D | null = mesh; up; up = up.parent) if (!up.visible) return;
        parts.push({ geometry: mesh.geometry, material: mesh.material, matrix: mesh.matrixWorld.clone(), castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow });
    });
    return parts;
}

function removeCell(group: THREE.Group, cell: Cell) {
    for (const mesh of cell.meshes) {
        group.remove(mesh);
        mesh.dispose();
    }
}

// Draws the props of `data` in `group` (made by createScatter): called again whenever they, or the ground
// under them, have changed. The meshes of a square are kept while they have room for its copies.
export function fillScatter(group: THREE.Group, registry: Registry, data: TerrainData) {
    const drawn = group.userData.drawn as Map<string, Drawn>;
    const layers = new Map((data.scatter ?? []).map((layer) => [layer.prefab, layer]));
    for (const [prefab, entry] of drawn) {
        if (layers.has(prefab)) continue;
        for (const cell of entry.cells.values()) removeCell(group, cell);
        drawn.delete(prefab);
    }
    const [width, depth] = terrainSize(data);
    const across = Math.max(1, Math.ceil(width / SCATTER_CELL));
    const along = Math.max(1, Math.ceil(depth / SCATTER_CELL));
    const cellOf = (x: number, z: number) => `${Math.min(across - 1, Math.max(0, Math.floor((x + width / 2) / SCATTER_CELL)))},${Math.min(along - 1, Math.max(0, Math.floor((z + depth / 2) / SCATTER_CELL)))}`;
    const matrix = new THREE.Matrix4();
    const placed = new THREE.Matrix4();
    for (const [prefab, layer] of layers) {
        let entry = drawn.get(prefab);
        if (!entry) {
            const parts = partsOf(registry, prefab, () => {
                // Taken again from the beginning, if this group is still the one that is shown
                const now = group.userData.drawn as Map<string, Drawn>;
                for (const cell of now.get(prefab)?.cells.values() ?? []) removeCell(group, cell);
                now.delete(prefab);
                if (group.parent) fillScatter(group, registry, (group.userData.data as TerrainData | undefined) ?? data);
            });
            if (!parts) {
                console.warn(`Scatter: unknown prefab "${prefab}"`);
                continue;
            }
            entry = { parts, cells: new Map() };
            drawn.set(prefab, entry);
        }
        // The copies of every square
        const squares = new Map<string, typeof layer.items>();
        for (const item of layer.items) {
            const key = cellOf(item[0], item[1]);
            const list = squares.get(key);
            if (list) list.push(item);
            else squares.set(key, [item]);
        }
        for (const [key, cell] of entry.cells) {
            if (squares.has(key)) continue;
            removeCell(group, cell);
            entry.cells.delete(key);
        }
        for (const [key, items] of squares) {
            let cell = entry.cells.get(key);
            if (!cell || items.length > cell.capacity || cell.meshes.length !== entry.parts.length) {
                if (cell) removeCell(group, cell);
                // Room to grow: a brush adds a few copies at every touch
                const capacity = Math.max(16, Math.ceil(items.length * 1.5));
                const [ci, cj] = key.split(",").map(Number);
                cell = {
                    capacity,
                    meshes: entry.parts.map((part) => {
                        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
                        mesh.castShadow = part.castShadow;
                        mesh.receiveShadow = part.receiveShadow;
                        // three.js counts where the copies are from their places, and leaves out what is out of sight
                        mesh.frustumCulled = true;
                        // The middle of the square, from the middle of the ground (see cullScatter)
                        mesh.userData.cell = { x: (ci + 0.5) * SCATTER_CELL - width / 2, z: (cj + 0.5) * SCATTER_CELL - depth / 2 };
                        group.add(mesh);
                        return mesh;
                    }),
                };
                entry.cells.set(key, cell);
            }
            let count = 0;
            for (const item of items) {
                if (!scatterMatrix(data, item, matrix)) continue;
                cell.meshes.forEach((mesh, n) => mesh.setMatrixAt(count, placed.multiplyMatrices(matrix, entry!.parts[n].matrix)));
                count++;
            }
            for (const mesh of cell.meshes) {
                mesh.count = count;
                mesh.instanceMatrix.needsUpdate = true;
                mesh.boundingSphere = null;
                mesh.boundingBox = null;
            }
        }
    }
    group.userData.data = data;
}

// Shows the squares of props of a terrain mesh within `distance` meters of `point` (along the ground, from the
// middle of the terrain) and hides the others; Infinity shows them all
export function cullScatter(mesh: THREE.Object3D, point: { x: number; z: number }, distance: number) {
    const group = mesh.children.find((child) => child.userData.scatter);
    if (!group) return;
    const half = SCATTER_CELL / 2;
    for (const child of group.children) {
        const cell = child.userData.cell as { x: number; z: number } | undefined;
        if (!cell) continue;
        child.visible = distance === Infinity || Math.hypot(Math.max(0, Math.abs(point.x - cell.x) - half), Math.max(0, Math.abs(point.z - cell.z) - half)) <= distance;
    }
}

// The object that shows the props of a terrain; it goes under the mesh of the terrain
export function createScatter(registry: Registry, data: TerrainData): THREE.Group {
    const group = new THREE.Group();
    group.userData.scatter = true;
    group.userData.drawn = new Map<string, Drawn>();
    fillScatter(group, registry, data);
    return group;
}

// Draws the props of a terrain mesh again: its ground or its props have changed in place
export function updateScatter(mesh: THREE.Object3D, registry: Registry, data: TerrainData) {
    const group = mesh.children.find((child) => child.userData.scatter) as THREE.Group | undefined;
    if (group) fillScatter(group, registry, data);
    // The first props of a ground that had none
    else if (data.scatter?.length) mesh.add(createScatter(registry, data));
}

// How many props a terrain has
export function scatterCount(data: TerrainData) {
    return (data.scatter ?? []).reduce((sum, layer) => sum + layer.items.length, 0);
}

// Strews copies of a prefab within `radius` meters of a point (x and z from the middle of the terrain):
// `tries` places are picked at random, and a copy is put wherever there is ground and no other copy of the
// same prefab nearer than `spacing` meters. Each is turned at random and is from `sizeMin` to `sizeMax`
// times the size of the prefab. Changes `data.scatter` in place (the list of the prefab has to be the
// caller's own); returns how many it has put.
export function plantScatter(
    data: TerrainData,
    prefab: string,
    x: number,
    z: number,
    radius: number,
    tries: number,
    options: { spacing?: number; sizeMin?: number; sizeMax?: number; random?: () => number } = {},
) {
    const { spacing = 2, sizeMin = 1, sizeMax = 1, random = Math.random } = options;
    data.scatter ??= [];
    let layer = data.scatter.find((each) => each.prefab === prefab);
    if (!layer) {
        layer = { prefab, items: [] };
        data.scatter.push(layer);
    }
    // Only the copies that are near enough to be in the way
    const near = layer.items.filter((item) => Math.hypot(item[0] - x, item[1] - z) <= radius + spacing);
    let put = 0;
    for (let n = 0; n < tries; n++) {
        // Evenly over the circle
        const reach = radius * Math.sqrt(random());
        const angle = random() * Math.PI * 2;
        const px = Math.round((x + Math.cos(angle) * reach) * 100) / 100;
        const pz = Math.round((z + Math.sin(angle) * reach) * 100) / 100;
        const turn = Math.round(random() * 360);
        const size = Math.round((sizeMin + (sizeMax - sizeMin) * random()) * 100) / 100;
        if (terrainHeight(data, px, pz) === null) continue;
        if (near.some((item) => Math.hypot(item[0] - px, item[1] - pz) < spacing)) continue;
        const item: ScatterItem = [px, pz, turn, size];
        layer.items.push(item);
        near.push(item);
        put++;
    }
    if (layer.items.length === 0) data.scatter.splice(data.scatter.indexOf(layer), 1);
    return put;
}

// Takes away the props within `radius` meters of a point: of one prefab, or of all without `prefab`.
// Changes `data.scatter` in place (the lists have to be the caller's own); returns how many are gone.
export function eraseScatter(data: TerrainData, x: number, z: number, radius: number, prefab?: string) {
    let gone = 0;
    for (const layer of data.scatter ?? []) {
        if (prefab && layer.prefab !== prefab) continue;
        const kept = layer.items.filter((item) => Math.hypot(item[0] - x, item[1] - z) > radius);
        gone += layer.items.length - kept.length;
        layer.items = kept;
    }
    if (data.scatter) data.scatter = data.scatter.filter((layer) => layer.items.length > 0);
    return gone;
}

// What stops a walker at the props of a terrain: for every copy of a prefab whose root has a solid Collider,
// the fields of that collider (defaults filled in) and where the collider is, from the middle of the terrain
export function scatterColliders(registry: Registry, data: TerrainData): { fields: Params; matrix: THREE.Matrix4 }[] {
    const colliders: { fields: Params; matrix: THREE.Matrix4 }[] = [];
    for (const layer of data.scatter ?? []) {
        const root = registry.getPrefab(layer.prefab);
        const component = root?.components.find((each) => each.type === "collider");
        if (!root || !component || component.solid === false) continue;
        const fields = { ...paramDefaults(componentDefs.collider.fields), ...component } as Params;
        // The collider inside one copy: the root of the prefab with its own turn and size, then its middle
        const inside = new THREE.Matrix4()
            .compose(new THREE.Vector3(), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(root.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]))), new THREE.Vector3(...root.scale))
            .multiply(new THREE.Matrix4().makeTranslation(fields.centerX as number, fields.centerY as number, fields.centerZ as number));
        for (const item of layer.items) {
            const matrix = scatterMatrix(data, item);
            if (matrix) colliders.push({ fields, matrix: matrix.multiply(inside) });
        }
    }
    return colliders;
}
