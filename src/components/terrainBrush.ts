import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { addRiverPoint, insertRiverPoint, brushRegion, brushTerrain, DEFAULT_PALETTE, eraseScatter, generateTerrain, generatorOf, markBiome, meetEdges, PIECE_SIDES, plantScatter, updateScatter, fillTerrainGeometry, forgetTerrainRange, isPainted, rayTerrain, terrainHeight } from "../engine";
import type { RiverData, RiverPoint, TerrainData, TerrainMarker, TerrainRegion, WorldPiece } from "../engine";
import { changePieces, editRivers } from "../editor/core/actions";
import { EDITOR_LAYER, sceneStore } from "../editor/core/SceneStore";
import { BiomeView } from "./biomeView";
import { RiverView } from "./riverView";
import type { RiverMark } from "./riverView";

// The brush of "Edit Terrain": while it is on, a ring on the ground of the selected terrain follows the
// mouse, and holding the left button works the ground under it: raises, lowers, smooths, levels or paints
// it. Shift turns "raise" into "lower" and back. A stroke changes a copy of the ground, which the meshes
// show at once; when the button goes up, the copy becomes the terrain (one step of undo) and is written to
// its file.
//
// On a World the brush works every piece that is shown at once: a stroke over the border of two pieces
// changes both, and when it is over the common edges of the pieces it has changed are made to meet. The
// piece the mouse is over becomes the one the Inspector shows (sceneStore.pieceTarget).
//
// The River brush works by clicks instead: a click on the ground is one more point of the river (with Ctrl,
// a point put into its line), and a point that is there already is dragged over the ground by its mark. A
// river belongs to one piece: the one that is picked.
//
// The copy shares with the ground it was made from every row of heights the stroke has not touched: a row is
// copied the first time the brush reaches it. So a stroke on a big ground starts at once, and the steps of
// undo, each of which keeps a whole ground, keep only what the strokes have changed.

// Points of the ring
const RING = 64;

// "smooth" and "flatten" get this much of the way there in a second at strength 1
const SETTLE = 1.5;

// Pixels from the mark of a point of a river within which a press takes it
const MARK_REACH = 10;

// Pixels the mouse has to go before a press on a mark becomes a drag
const DRAG_START = 4;

// A ground the brush can work: a terrain asset and the mesh that shows it
interface Ground {
    name: string;
    data: TerrainData;
    mesh: THREE.Mesh;
    // Its place in the grid of its world, if it is a piece of one
    piece?: WorldPiece;
}

// What a stroke does to one ground: the terrain as it was, the copy being worked, the meshes that show it
interface Part {
    name: string;
    before: TerrainData;
    data: TerrainData;
    meshes: THREE.Mesh[];
    // Where the middle of the ground is in the world
    middle: THREE.Vector3;
    piece?: WorldPiece;
    changed: boolean;
    // The rows of heights and of colors that are the stroke's own by now, by their number
    heights: Set<number>;
    colors: Set<number>;
    // All of the ground the stroke has reached so far
    region: TerrainRegion | null;
}

function joined(a: TerrainRegion | null, b: TerrainRegion): TerrainRegion {
    return a ? { fromI: Math.min(a.fromI, b.fromI), toI: Math.max(a.toI, b.toI), fromJ: Math.min(a.fromJ, b.fromJ), toJ: Math.max(a.toJ, b.toJ) } : b;
}

// The heights along one side of a ground (the side towards di, dj)
function edgeOf(data: TerrainData, di: number, dj: number): TerrainRegion {
    const last = { i: data.heights[0].length - 1, j: data.heights.length - 1 };
    if (di !== 0) return { fromI: di > 0 ? last.i : 0, toI: di > 0 ? last.i : 0, fromJ: 0, toJ: last.j };
    return { fromI: 0, toI: last.i, fromJ: dj > 0 ? last.j : 0, toJ: dj > 0 ? last.j : 0 };
}

export class TerrainBrush {
    // Lives in the scene of the editor, on the layer of its tools
    readonly group = new THREE.Group();

    // true from a press that began a stroke until the next press: that click must not select something else
    grabbed = false;

    // The map of the biomes in color, over the ground
    private biomes = new BiomeView();

    // The rivers of the ground: their lines and the marks of their points
    private rivers = new RiverView();

    // The mark of a river the mouse is over
    private hover: RiverMark | null = null;

    // A point of a river being dragged: the rivers as they will be when the button goes up
    private drag: { name: string; mark: RiverMark; rivers: RiverData[]; from: [number, number]; moved: boolean } | null = null;

    // Where the mouse is over the view, pixels
    private pixel: [number, number] = [0, 0];

    private ring: THREE.LineLoop;

    private raycaster = new THREE.Raycaster();

    private camera: THREE.Camera;

    private dom: HTMLElement;

    private controls: OrbitControls;

    // Where the mouse is over the view, -1 to 1; null while it is elsewhere
    private mouse: THREE.Vector2 | null = null;

    private shift = false;

    // The stroke in progress: a part for every ground it may reach
    private stroke: {
        parts: Part[];
        // The height "flatten" levels to, in the world: the one under the brush when the stroke began
        level: number;
        // "plant": the part of a prop that is due, carried over from frame to frame
        due: number;
    } | null = null;

    constructor(camera: THREE.Camera, dom: HTMLElement, controls: OrbitControls) {
        this.camera = camera;
        this.dom = dom;
        this.controls = controls;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RING * 3), 3));
        // Drawn over everything: behind a hill the ring would be lost
        this.ring = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, fog: false }));
        this.ring.layers.set(EDITOR_LAYER);
        this.ring.renderOrder = 1000;
        this.ring.frustumCulled = false;
        this.ring.visible = false;
        this.group.add(this.ring);
        this.group.add(this.biomes.group);
        this.group.add(this.rivers.group);
        // Before the camera controls hear of the press: a stroke must not turn the camera
        dom.addEventListener("pointerdown", this.onDown, true);
        dom.addEventListener("pointermove", this.onMove);
        dom.addEventListener("pointerleave", this.onLeave);
        dom.addEventListener("pointerup", this.onUp);
        dom.addEventListener("pointercancel", this.onUp);
    }

    // The terrain being edited: its asset and the mesh of the selected entity (of a World, the piece that is
    // picked); null while the brush is off
    private target() {
        if (!sceneStore.terrainEdit || sceneStore.playing || sceneStore.gameView) return null;
        const target = sceneStore.terrainTarget;
        const data = target && sceneStore.registry.getTerrain(target.name);
        return target && data ? { ...target, data } : null;
    }

    // The grounds the brush works: the terrain of the selected entity, or every piece of its World that is shown
    private grounds(): Ground[] {
        const target = this.target();
        if (!target) return [];
        const world = sceneStore.worldMarker(target.id);
        if (!world) return [{ name: target.name, data: target.data, mesh: target.mesh }];
        const grounds: Ground[] = [];
        for (const [name, mesh] of world.shown) {
            // A far piece is drawn coarse: its geometry is not the grid of its heights
            if (mesh.userData.coarse) continue;
            const data = sceneStore.registry.getTerrain(name);
            if (data) grounds.push({ name, data, mesh: mesh as THREE.Mesh, piece: mesh.userData.piece as WorldPiece });
        }
        return grounds;
    }

    // Where the mouse points on the ground, in the world, and on which ground; null if not at any. `grounds`
    // with the data each is to be seen with (the copies of a stroke).
    private point(grounds: { data: TerrainData; mesh: THREE.Object3D }[]) {
        if (!this.mouse) return null;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const { origin, direction } = this.raycaster.ray;
        let best: { at: THREE.Vector3; index: number; distance: number } | null = null;
        grounds.forEach((ground, index) => {
            const middle = ground.mesh.getWorldPosition(new THREE.Vector3());
            const hit = rayTerrain(ground.data, origin.clone().sub(middle), direction);
            if (hit && (!best || hit.distance < best.distance)) best = { at: origin.clone().addScaledVector(direction, hit.distance), index, distance: hit.distance };
        });
        return best as { at: THREE.Vector3; index: number; distance: number } | null;
    }

    private place(e: PointerEvent) {
        const rect = this.dom.getBoundingClientRect();
        this.mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        this.pixel = [e.clientX - rect.left, e.clientY - rect.top];
        this.shift = e.shiftKey;
    }

    // The mark of a point of a river the mouse is at, the nearest one
    private markAt(rivers: RiverData[], mesh: THREE.Object3D): RiverMark | null {
        if (!this.mouse) return null;
        const rect = this.dom.getBoundingClientRect();
        const seen = new THREE.Vector3();
        let found: RiverMark | null = null;
        let nearest = MARK_REACH;
        RiverView.places(rivers, mesh.getWorldPosition(new THREE.Vector3())).forEach((places, river) => {
            places.forEach((place, point) => {
                seen.copy(place).project(this.camera);
                // Behind the camera
                if (seen.z > 1) return;
                const distance = Math.hypot(((seen.x + 1) / 2) * rect.width - this.pixel[0], ((1 - seen.y) / 2) * rect.height - this.pixel[1]);
                if (distance >= nearest) return;
                nearest = distance;
                found = { river, point };
            });
        });
        return found;
    }

    private onDown = (e: PointerEvent) => {
        this.grabbed = false;
        if (e.button !== 0) return;
        const target = this.target();
        if (!target) return;
        this.place(e);
        // A press on the mark of a point of a river picks it, and drags it if the mouse goes on
        const mark = sceneStore.brush.tool === "river" ? this.markAt(target.data.rivers ?? [], target.mesh) : null;
        if (mark) {
            this.grabbed = true;
            this.drag = { name: target.name, mark, rivers: target.data.rivers ?? [], from: [...this.pixel], moved: false };
            this.controls.enabled = false;
            this.dom.setPointerCapture(e.pointerId);
            sceneStore.setBrush(mark);
            return;
        }
        const grounds = this.grounds();
        const hit = this.point(grounds);
        // A press past the ground turns the camera as usual
        if (!hit) return;

        // A river is laid click by click: every click is one more point of it, and a step of undo. On a World,
        // on the piece that was clicked.
        if (sceneStore.brush.tool === "river") {
            const ground = grounds[hit.index];
            sceneStore.setPieceTarget(ground.name);
            const at = hit.at.clone().sub(ground.mesh.getWorldPosition(new THREE.Vector3()));
            this.grabbed = true;
            editRivers(ground.name, (rivers, data) => {
                const index = Math.min(sceneStore.brush.river, rivers.length);
                // With Ctrl the point goes into the line of the river, between the two points it runs through there
                const put = e.ctrlKey ? insertRiverPoint({ ...data, rivers }, index, at.x, at.z) : -1;
                if (put < 0) addRiverPoint({ ...data, rivers }, index, at.x, at.z);
                sceneStore.setBrush({ river: index, point: put < 0 ? rivers[index].points.length - 1 : put });
            });
            return;
        }

        const { tool } = sceneStore.brush;
        const parts = grounds.map((ground): Part => {
            // The lists of rows are the stroke's own, the rows are not yet (see the top of the file)
            const data: TerrainData = { ...ground.data, heights: [...ground.data.heights], ...(ground.data.colors ? { colors: [...ground.data.colors] } : {}) };
            const colors = new Set<number>();
            // The first paint of a ground that had none: all of it is the first color of the usual palette
            if ((tool === "paint" || (tool === "generate" && (generatorOf(data).paint || generatorOf(data).biome))) && !isPainted(data)) {
                data.palette = data.palette?.length ? data.palette : [...DEFAULT_PALETTE];
                data.colors = data.heights.map((row) => row.map(() => 0));
                data.colors.forEach((_, j) => colors.add(j));
            }
            const meshes = sceneStore.terrainMeshes(ground.name);
            for (const mesh of meshes) (mesh.userData.terrain as TerrainMarker).data = data;
            // The lists of the props are the stroke's own from the start: they are short. A biome may add its
            // colors to the palette, and is written into the map of the biomes.
            if (tool === "generate" || tool === "biome") {
                if (data.palette) data.palette = [...data.palette];
                if (data.biomes) data.biomes = [...data.biomes];
                if (data.biomeMap) data.biomeMap = data.biomeMap.map((row) => [...row]);
            }
            if ((tool === "plant" || tool === "erase") && data.scatter) data.scatter = data.scatter.map((layer) => ({ prefab: layer.prefab, items: [...layer.items] }));
            return { name: ground.name, before: ground.data, data, meshes, middle: ground.mesh.getWorldPosition(new THREE.Vector3()), piece: ground.piece, changed: false, heights: new Set(), colors, region: null };
        });
        // The first touch plants at once
        this.stroke = { parts, level: hit.at.y, due: 1 };
        this.grabbed = true;
        this.controls.enabled = false;
        this.dom.setPointerCapture(e.pointerId);
        // A click without a move is a touch too
        this.frame(1 / 30);
    };

    private onMove = (e: PointerEvent) => {
        this.place(e);
    };

    private onLeave = () => {
        if (!this.stroke) this.mouse = null;
    };

    private onUp = (e: PointerEvent) => {
        const { drag } = this;
        if (drag) {
            this.drag = null;
            this.controls.enabled = !sceneStore.gameView;
            if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
            // One step of undo: the bed is cut where the river runs now
            if (drag.moved) editRivers(drag.name, (rivers) => void rivers.splice(0, rivers.length, ...drag.rivers));
            return;
        }
        const { stroke } = this;
        if (!stroke) return;
        this.stroke = null;
        this.controls.enabled = !sceneStore.gameView;
        if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
        for (const part of stroke.parts) {
            if (!part.changed) continue;
            // Centimeters are enough, and keep the file readable
            for (const j of part.heights) {
                const row = part.data.heights[j];
                for (let i = 0; i < row.length; i++) row[i] = Math.round(row[i] * 100) / 100;
            }
        }
        this.meet(stroke.parts);
        const changed = stroke.parts.filter((part) => part.changed);
        for (const part of stroke.parts) {
            if (part.changed) continue;
            for (const mesh of part.meshes) (mesh.userData.terrain as TerrainMarker).data = part.before;
        }
        for (const part of changed) {
            forgetTerrainRange(part.data);
            if (part.region) this.show(part.meshes, part.data, part.region);
        }
        changePieces(changed.map((part) => ({ name: part.name, before: part.before, after: part.data })), `Brush stroke on ${changed.length} pieces`);
        // Painted for the first time: the material of the ground is another one from now on
        if (changed.some((part) => isPainted(part.data) !== isPainted(part.before))) sceneStore.setRegistry(sceneStore.registry);
    };

    // The pieces of a World a stroke has changed are made to meet their neighbors at the common edges: the brush
    // works each piece by itself, and smoothing near an edge sees only one side of it
    private meet(parts: Part[]) {
        const byPlace = new Map(parts.filter((part) => part.piece).map((part) => [`${part.piece!.i},${part.piece!.j}`, part]));
        const own = (part: Part) => (data: TerrainData, j: number) => {
            if (!part.heights.has(j)) {
                part.heights.add(j);
                data.heights[j] = [...data.heights[j]];
            }
            return data.heights[j];
        };
        for (const part of parts) {
            if (!part.piece || !part.changed) continue;
            for (const [di, dj] of PIECE_SIDES) {
                const next = byPlace.get(`${part.piece.i + di},${part.piece.j + dj}`);
                if (!next) continue;
                // Each writes only its own rows: the function is given whose data it is by the data
                const ownOf = (data: TerrainData, j: number) => (data === part.data ? own(part)(data, j) : own(next)(data, j));
                if (!meetEdges(part.data, next.data, di, dj, ownOf)) continue;
                for (const [other, si, sj] of [[part, di, dj], [next, -di, -dj]] as const) {
                    other.changed = true;
                    other.region = joined(other.region, edgeOf(other.data, si, sj));
                }
            }
        }
    }

    // `region`: only that part of the ground has changed
    private show(meshes: THREE.Mesh[], data: TerrainData, region?: TerrainRegion) {
        for (const mesh of meshes) {
            fillTerrainGeometry(mesh.geometry, data, (mesh.userData.terrain as TerrainMarker).flat, region);
            // The props stand on the ground: they go up and down with it (and a biome puts its own)
            updateScatter(mesh, sceneStore.registry, data);
        }
    }

    // The props have changed, the ground has not
    private showProps(meshes: THREE.Mesh[], data: TerrainData) {
        for (const mesh of meshes) updateScatter(mesh, sceneStore.registry, data);
    }

    // One touch of the brush on one ground: `x`, `z` from its middle
    private touch(part: Part, x: number, z: number, dt: number) {
        const stroke = this.stroke!;
        const { tool, radius, strength, color } = sceneStore.brush;
        const { data } = part;
        const region = brushRegion(data, x, z, radius);
        if (!region) return;
        if (tool === "plant" || tool === "erase") {
            const { prefab, spacing, sizeMin, sizeMax } = sceneStore.brush;
            let changed = false;
            // Shift turns planting into taking away what was planted of that prefab
            if (tool === "erase" || this.shift) {
                changed = eraseScatter(data, x, z, radius, tool === "erase" ? undefined : prefab) > 0;
            } else if (prefab) {
                // So many tries a second for every 100 square meters of the brush; the spacing does the rest
                const tries = Math.floor(stroke.due);
                if (tries > 0) changed = plantScatter(data, prefab, x, z, radius, tries, { spacing, sizeMin, sizeMax }) > 0;
            }
            if (changed) {
                part.changed = true;
                this.showProps(part.meshes, data);
            }
            return;
        }
        if (tool === "biome") {
            // Only the map changes: the ground is made by it when it is generated. Shift: no one's ground
            if (markBiome(data, this.shift ? "" : generatorOf(data).biome, x, z, radius)) {
                part.changed = true;
                if (part.name === sceneStore.terrainTarget?.name) this.biomes.paint(region);
            }
            return;
        }
        if (tool === "river") return;
        const used = this.shift && tool === "raise" ? "lower" : this.shift && tool === "lower" ? "raise" : tool;
        const amount = used === "raise" || used === "lower" ? strength * dt : strength * SETTLE * dt;
        // The rows the touch is about to change become the stroke's own
        for (const [rows, owned] of [[used === "paint" ? undefined : data.heights, part.heights], [used === "paint" || used === "generate" ? data.colors : undefined, part.colors]] as const) {
            for (let j = region.fromJ; rows && j <= region.toJ; j++) {
                if (owned.has(j)) continue;
                owned.add(j);
                rows[j] = [...rows[j]];
            }
        }
        const changed = used === "generate"
            ? !!generateTerrain(data, generatorOf(data), part.middle, { x, z, radius, amount }, sceneStore.registry.getBiome(generatorOf(data).biome), (shape) => sceneStore.registry.getGenerator(shape))
            : brushTerrain(data, used, x, z, radius, amount, { level: stroke.level - part.middle.y, color });
        if (changed) {
            part.changed = true;
            part.region = joined(part.region, region);
            this.show(part.meshes, data, region);
            if (used === "generate") if (part.name === sceneStore.terrainTarget?.name) this.biomes.paint(region);
        }
    }

    // Call every frame: the ring follows the mouse, a stroke in progress works the ground under it
    frame(dt: number) {
        this.biomes.frame();
        const target = this.target();
        const { tool, radius, strength } = sceneStore.brush;
        // The grounds as they are seen now: the copies of the stroke while there is one
        const grounds = this.stroke
            ? this.stroke.parts.map((part) => ({ name: part.name, data: part.data, mesh: part.meshes[0] }))
            : this.grounds();
        const hit = this.point(grounds);
        const at = hit?.at ?? null;
        this.ring.visible = !!at && !this.drag;
        // The piece the mouse is over is the one the Inspector shows
        if (hit && target && !this.stroke && !this.drag && grounds.length > 1) sceneStore.setPieceTarget(grounds[hit.index].name);

        // The rivers (of the picked ground): a mark that is held goes where the mouse points on the ground, its
        // water as high as it was
        const middle = target?.mesh.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
        const { drag } = this;
        if (drag && at && (drag.moved || Math.hypot(this.pixel[0] - drag.from[0], this.pixel[1] - drag.from[1]) >= DRAG_START)) {
            const { river, point } = drag.mark;
            const moved: RiverPoint = [Math.round((at.x - middle.x) * 100) / 100, Math.round((at.z - middle.z) * 100) / 100, drag.rivers[river].points[point][2]];
            drag.rivers = drag.rivers.map((each, r) => (r === river ? { ...each, points: each.points.map((old, n) => (n === point ? moved : old)) } : each));
            drag.moved = true;
        }
        const rivers = target && tool === "river" ? drag?.rivers ?? target.data.rivers ?? [] : null;
        this.hover = rivers && target && !drag ? this.markAt(rivers, target.mesh) : null;
        this.rivers.frame(rivers, middle, { river: sceneStore.brush.river, point: sceneStore.brush.point }, drag?.mark ?? this.hover);
        if (!target || !at) return;

        if (this.stroke) {
            if (tool === "plant") {
                this.stroke.due += strength * dt * Math.max(1, (Math.PI * radius * radius) / 100);
            }
            for (const part of this.stroke.parts) this.touch(part, at.x - part.middle.x, at.z - part.middle.z, dt);
            if (tool === "plant") this.stroke.due -= Math.floor(this.stroke.due);
        }

        // The ring lies on the ground, a little over it
        const positions = this.ring.geometry.getAttribute("position") as THREE.BufferAttribute;
        const middles = grounds.map((ground) => ground.mesh.getWorldPosition(new THREE.Vector3()));
        for (let n = 0; n < RING; n++) {
            const angle = (n / RING) * Math.PI * 2;
            const x = at.x + Math.cos(angle) * radius;
            const z = at.z + Math.sin(angle) * radius;
            let y = at.y;
            for (let k = 0; k < grounds.length; k++) {
                const height = terrainHeight(grounds[k].data, x - middles[k].x, z - middles[k].z);
                if (height === null) continue;
                y = middles[k].y + height;
                break;
            }
            positions.setXYZ(n, x, y + 0.05, z);
        }
        positions.needsUpdate = true;
    }

    dispose() {
        this.dom.removeEventListener("pointerdown", this.onDown, true);
        this.dom.removeEventListener("pointermove", this.onMove);
        this.dom.removeEventListener("pointerleave", this.onLeave);
        this.dom.removeEventListener("pointerup", this.onUp);
        this.dom.removeEventListener("pointercancel", this.onUp);
        this.biomes.dispose();
        this.rivers.dispose();
        this.group.removeFromParent();
        this.ring.geometry.dispose();
        (this.ring.material as THREE.Material).dispose();
    }
}
